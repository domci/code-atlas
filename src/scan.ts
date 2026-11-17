import { join } from "node:path";
import { duplicates, hotspots, incoming, misplaced, testFile, unused, wrappers, type Unit } from "./analyze";
import { embedAll, MODEL, nameText } from "./embed";
import { fingerprint } from "./fingerprint";
import { loadGraph } from "./graph";
import { open, vectorCache, writeScan } from "./store";

const EMBED_MIN_LINES = 6;
const CHURN_DAYS = 180;

const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Builds the atlas for `repo` from its GitNexus index, the source files and git history. */
export async function scan(repo: string, opts: { embed: boolean }) {
  const t0 = performance.now();
  const { symbols, edges } = await loadGraph(repo);
  log(`graph: ${symbols.length} symbols, ${edges.length} use edges`);

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
    if (lines && u.lines >= 3) {
      // GitNexus lines are 0-based.
      const code = lines.slice(s.start, s.end + 1).join("\n");
      u.fp = fingerprint(code, s.name);
      u.code = code;
    }
    units.push(u);
  }
  log(`fingerprints: ${units.filter((u) => u.fp).length}`);

  const db = open(repo);
  if (opts.embed) {
    const cache = vectorCache(db);
    const pool = units.filter((u) => u.fp && !u.test && u.lines >= EMBED_MIN_LINES);
    const items = pool.flatMap((u) => [
      { key: `code:${u.fp!.exact}`, text: u.code! },
      { key: `name:${u.name}`, text: nameText(u.name) },
    ]);
    let last = 0;
    const vecs = await embedAll(items, cache.get, cache.put, (d, t) => {
      if (d - last >= 500 || d === t) { log(`embeddings: ${d}/${t} new`); last = d; }
    });
    for (const u of pool) {
      u.codeVec = vecs.get(`code:${u.fp!.exact}`);
      u.nameVec = vecs.get(`name:${u.name}`);
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('model', ?)").run(MODEL);
  }
  for (const u of units) delete u.code;

  const dup = duplicates(units);
  const findings = [...dup.findings, ...unused(units, edges), ...hotspots(units, edges), ...misplaced(units, edges), ...wrappers(units)];
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
