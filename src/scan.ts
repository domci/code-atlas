import { join } from "node:path";
import { duplicates, hotspots, incoming, nameText, testFile, unused, wrappers, type Unit } from "./analyze";
import { countIdentifiers, fingerprint } from "./fingerprint";
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
  const files = new Map<string, string[] | null>();
  const units: Unit[] = [];
  for (const s of symbols) {
    if (!files.has(s.file)) {
      const f = Bun.file(join(repo, s.file));
      files.set(s.file, (await f.exists()) ? (await f.text()).split("\n") : null);
    }
    const lines = files.get(s.file);
    const u: Unit = { ...s, lines: s.end - s.start + 1, churn: churn.get(s.file) ?? 0, test: testFile(s.file) };
    if (lines) {
      u.code = lines.slice(s.start - 1, s.end).join("\n");
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

/** Tracked JS/TS source files. */
const sourceFiles = async (repo: string) => new Set(await gitFiles(repo, ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"]));

async function gitFiles(repo: string, patterns: string[]): Promise<string[]> {
  return (await Bun.$`git -C ${repo} ls-files -- ${patterns}`.quiet().text()).split("\n").filter(Boolean);
}

/** How often each identifier appears across the given files. */
async function nameCounts(repo: string, files: Set<string>): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const f of files) {
    const file = Bun.file(join(repo, f));
    if ((await file.exists()) && file.size < 2_000_000) countIdentifiers(await file.text(), m);
  }
  return m;
}
