import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Edge } from "./graph";
import type { Finding, Pair, Unit } from "./analyze";

/** One database per repository, outside the repo so nothing needs ignoring. */
export function dbPath(repo: string): string {
  const dir = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME!, ".cache"), "code-atlas");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${basename(repo)}-${Bun.hash(repo).toString(16).slice(0, 8)}.db`);
}

export function open(repo: string): Database {
  const db = new Database(dbPath(repo), { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, v BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, source TEXT NOT NULL, kind TEXT, score INT, title TEXT,
      file TEXT, line INT, ids TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS findings_score ON findings(score DESC);
  `);
  return db;
}

/** Replaces all scan results; keeps the vector cache. */
export function writeScan(db: Database, units: Unit[], edges: Edge[], pairs: Pair[], findings: Finding[], fanIn: Map<string, number>) {
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS pairs;
      CREATE TABLE symbols (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file TEXT, start_line INT, end_line INT, lines INT,
        exported INT, test INT, community TEXT, community_label TEXT, fan_in INT, fan_out INT, churn INT, branches INT, tokens INT, code_key TEXT);
      CREATE TABLE edges (src TEXT, dst TEXT, type TEXT);
      CREATE TABLE pairs (a TEXT, b TEXT, kind TEXT, score REAL);
      CREATE INDEX symbols_name ON symbols(name); CREATE INDEX symbols_file ON symbols(file);
      CREATE INDEX edges_src ON edges(src); CREATE INDEX edges_dst ON edges(dst);
      DELETE FROM findings WHERE source = 'atlas';
    `);
    const fanOut = new Map<string, number>();
    for (const e of edges) fanOut.set(e.src, (fanOut.get(e.src) ?? 0) + 1);
    const s = db.prepare("INSERT OR REPLACE INTO symbols VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const u of units) {
      s.run(u.id, u.kind, u.name, u.file, u.start, u.end, u.lines, u.exported ? 1 : 0, u.test ? 1 : 0, u.community,
        u.communityLabel, fanIn.get(u.id) ?? 0, fanOut.get(u.id) ?? 0, u.churn, u.fp?.branches ?? null, u.fp?.tokens ?? null,
        u.codeVec ? `code:${u.fp!.exact}` : null);
    }
    const e = db.prepare("INSERT INTO edges VALUES (?,?,?)");
    for (const x of edges) e.run(x.src, x.dst, x.type);
    const p = db.prepare("INSERT INTO pairs VALUES (?,?,?,?)");
    for (const x of pairs) p.run(x.a, x.b, x.kind, x.score);
    const f = db.prepare("INSERT INTO findings (source, kind, score, title, file, line, ids, detail) VALUES ('atlas',?,?,?,?,?,?,?)");
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const x of findings.sort((a, b) => b.score - a.score)) {
      const first = byId.get(x.ids[0]!);
      f.run(x.kind, x.score, x.title, first?.file ?? null, first?.start ?? null, JSON.stringify(x.ids), JSON.stringify(x.detail));
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run("scannedAt", new Date().toISOString());
  })();
}

export function vectorCache(db: Database) {
  const get = db.prepare<{ v: Uint8Array }, [string]>("SELECT v FROM vectors WHERE key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO vectors VALUES (?, ?)");
  return {
    get: (key: string) => {
      const row = get.get(key);
      return row ? new Float32Array(row.v.slice().buffer) : undefined;
    },
    put: (key: string, v: Float32Array) => put.run(key, new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
  };
}
