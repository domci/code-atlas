import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { duplicates, hotspots, incoming, nameText, testFile, unused, wrappers, type Unit } from "./analyze";
import { countIdentifiers, fingerprint, implicitUses } from "./fingerprint";
import { loadGraph, type Edge, type Sym } from "./graph";
import { dbPath, open, vectorCache, writeScan } from "./store";

const EMBED_MIN_LINES = 6;
const CHURN_DAYS = 180;

const started = performance.now();
const log = (msg: string) => process.stderr.write(`[${Math.round((performance.now() - started) / 1000)}s] ${msg}\n`);

/** Builds the atlas for `repo` from its GitNexus index, the source files and git history. */
export async function scan(repo: string, opts: { embed: boolean }) {
  const t0 = performance.now();
  const graph = await loadGraph(repo);
  const tracked = await sourceFiles(repo);
  // GitNexus also indexes ignored build output; keep what git tracks.
  const { symbols, edges } = mergeTwins(graph.symbols.filter((s) => tracked.has(s.file)), graph.edges);
  log(`graph: ${symbols.length} symbols in tracked files, ${edges.length} use edges`);

  const churn = await fileChurn(repo);
  const namespaced = await namespaceTargets(repo, tracked);
  log(`namespace-imported files: ${namespaced.size}`);
  const files = new Map<string, { lines: string[]; implicit: ReturnType<typeof implicitUses> } | null>();
  const units: Unit[] = [];
  for (const s of symbols) {
    if (!files.has(s.file)) {
      const f = Bun.file(join(repo, s.file));
      const text = (await f.exists()) ? await f.text() : null;
      files.set(s.file, text === null ? null : { lines: text.split("\n"), implicit: implicitUses(text) });
    }
    const file = files.get(s.file);
    const u: Unit = { ...s, lines: s.end - s.start + 1, churn: churn.get(s.file) ?? 0, test: testFile(s.file) };
    if (file) {
      u.code = file.lines.slice(s.start - 1, s.end).join("\n");
      u.implicitUse = file.implicit(s.name, s.start) || (namespaced.has(s.file) && (s.exported || /^\s*export\b/.test(u.code)));
      if (u.lines >= 3) u.fp = fingerprint(u.code, s.name);
    }
    units.push(u);
  }
  log(`fingerprints: ${units.filter((u) => u.fp).length}`);
  const names = await nameCounts(repo, new Set([...tracked, ...(await gitFiles(repo, ["*.astro", "*.vue", "*.svelte", "*.mdx"]))]));

  const db = open(repo);
  if (opts.embed) {
    const cache = vectorCache(db);
    const pool = units.filter((u) => u.fp && !u.test && u.lines >= EMBED_MIN_LINES);
    const items = pool.flatMap((u) => [
      { key: `code:${u.fp!.exact}`, text: u.code! },
      { key: `name:${u.name}`, text: nameText(u.name) },
    ]);
    db.exec("CREATE TABLE IF NOT EXISTS embed_queue (key TEXT PRIMARY KEY, text TEXT); DELETE FROM embed_queue;");
    const queue = db.prepare("INSERT OR IGNORE INTO embed_queue VALUES (?, ?)");
    db.transaction(() => { for (const it of items) if (!cache.has(it.key)) queue.run(it.key, it.text); })();
    const pending = db.query<{ n: number }, []>("SELECT count(*) AS n FROM embed_queue").get()!.n;
    log(`embeddings: ${new Set(items.map((i) => i.key)).size - pending} cached, ${pending} new`);
    if (pending > 0) {
      const child = Bun.spawn(["bun", join(import.meta.dir, "embed.ts"), dbPath(repo)], { stdout: "inherit", stderr: "inherit" });
      if ((await child.exited) !== 0) throw new Error("Embedding process failed");
    }
    for (const u of pool) {
      u.codeVec = cache.get(`code:${u.fp!.exact}`);
      u.nameVec = cache.get(`name:${u.name}`);
    }
  }
  log("analysing");
  const dup = await duplicates(units);
  log("duplicates done");
  const findings = [...dup.findings, ...unused(units, edges, names), ...hotspots(units, edges), ...wrappers(units)];
  for (const u of units) delete u.code;
  log("writing");
  writeScan(db, units, edges, dup.pairs, findings, incoming(edges));
  db.close();

  const byKind = Object.groupBy(findings, (f) => f.kind);
  return {
    seconds: Math.round((performance.now() - t0) / 1000),
    symbols: units.length,
    edges: edges.length,
    duplicatePairs: dup.pairs.length,
    findings: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v?.length ?? 0])),
  };
}

/** Commits per file in the last CHURN_DAYS days. */
async function fileChurn(repo: string): Promise<Map<string, number>> {
  const out = await Bun.$`git -C ${repo} log --since=${`${CHURN_DAYS} days ago`} --name-only --format=`.quiet().nothrow().text();
  const m = new Map<string, number>();
  for (const line of out.split("\n")) if (line) m.set(line, (m.get(line) ?? 0) + 1);
  return m;
}

/**
 * GitNexus can store one declaration twice, e.g. `const f = () => …` as Function and Const.
 * Keeps the first node of each name+place and points the other's edges at it.
 */
export function mergeTwins(symbols: Sym[], edges: Edge[]): { symbols: Sym[]; edges: Edge[] } {
  const keep = new Map<string, Sym>();
  const alias = new Map<string, string>();
  for (const s of symbols) {
    const key = `${s.file}:${s.start}:${s.name}`;
    const first = keep.get(key);
    if (first) {
      alias.set(s.id, first.id);
      first.exported ||= s.exported;
      first.community ??= s.community;
      first.communityLabel ??= s.communityLabel;
    } else keep.set(key, s);
  }
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    const src = alias.get(e.src) ?? e.src, dst = alias.get(e.dst) ?? e.dst;
    const k = `${src}>${dst}>${e.type}`;
    if (!seen.has(k)) { seen.add(k); out.push({ src, dst, type: e.type }); }
  }
  return { symbols: [...keep.values()], edges: out };
}

const NAMESPACE_IMPORT = /\b(?:import|export)\s+(?:type\s+)?\*\s+as\s+[\w$]+\s+from\s+["']([^"']+)["']/g;

/**
 * Repo files imported as a namespace (`import * as schema from "./schema"`, `export * as x from …`).
 * Their exports are used as `schema.name` or handed over whole (`drizzle({ schema })`), so the name check misses them.
 * Test files do not count. Specifiers resolve like tsc does: relative paths, tsconfig `paths` (`@/…`), extensions and index files.
 */
export async function namespaceTargets(repo: string, files: Set<string>): Promise<Set<string>> {
  const hits = await Bun.$`git -C ${repo} grep -lE ${"(import|export)[[:space:]]+(type[[:space:]]+)?\\*[[:space:]]+as[[:space:]]"} -- ${SOURCE_GLOBS}`.quiet().nothrow().text();
  const configs = new Map<string, ts.CompilerOptions>();
  const optionsFor = (dir: string) => {
    const path = ts.findConfigFile(dir, ts.sys.fileExists) ?? "";
    let o = configs.get(path);
    if (!o) {
      const read = path ? ts.readConfigFile(path, ts.sys.readFile).config : {};
      o = ts.parseJsonConfigFileContent(read ?? {}, ts.sys, dirname(path || dir), undefined, path || undefined).options;
      configs.set(path, o);
    }
    return o;
  };
  const out = new Set<string>();
  // Tests import `* as mod` to spy on it (`vi.spyOn(mod, "x")`); that uses one export, not all of them.
  for (const file of hits.split("\n").filter((f) => files.has(f) && !testFile(f))) {
    const abs = join(repo, file);
    const options = optionsFor(dirname(abs));
    for (const [, spec] of (await Bun.file(abs).text()).matchAll(NAMESPACE_IMPORT)) {
      const r = ts.resolveModuleName(spec!, abs, options, ts.sys).resolvedModule;
      if (r && !r.isExternalLibraryImport) out.add(relative(repo, r.resolvedFileName));
    }
  }
  return out;
}

const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];
/** Tracked JS/TS source files. */
const sourceFiles = async (repo: string) => new Set(await gitFiles(repo, SOURCE_GLOBS));

async function gitFiles(repo: string, patterns: string[]): Promise<string[]> {
  return (await Bun.$`git -C ${repo} ls-files -- ${patterns}`.quiet().text()).split("\n").filter(Boolean);
}

/** Prose (Markdown, and MDX in docs/ or plans/) mentions names without using them. Code files always count. */
export const countsAsUse = (file: string) => !/\.md$/i.test(file) && !/(^|\/)(docs|plans)\/.*\.mdx$/i.test(file);

/** How often each identifier appears across the given files. */
async function nameCounts(repo: string, files: Set<string>): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const f of [...files].filter(countsAsUse)) {
    const file = Bun.file(join(repo, f));
    if ((await file.exists()) && file.size < 2_000_000) countIdentifiers(await file.text(), m);
  }
  return m;
}
