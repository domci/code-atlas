#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dot } from "./analyze";
import { importReport } from "./imports";
import { scan } from "./scan";
import { Database } from "bun:sqlite";
import { dbPath, open, vectorCache } from "./store";

const HELP = `atlas — code duplicate, debt and structure analysis on top of a GitNexus index.
All output is JSON. Run inside the repo or pass --repo <path>.

  atlas scan [--no-embed]          rebuild the atlas (run "gitnexus analyze" first)
  atlas debt [--kind k] [--path p] [--min n] [--limit n]
                                   ranked findings (--limit 0 = all); kinds: duplicate-exact, duplicate-renamed,
                                   duplicate-edited, duplicate-meaning, unused, hotspot, wrapper,
                                   plus imported ones (security, knip-*)
  atlas show <findingId>           one finding with all details
  atlas symbol <name>              where a name is defined, its numbers and its findings
  atlas similar <name> [--limit n] code that means the same as <name>, by embedding
  atlas import sarif|knip <file> [--base dir]
                                   add findings from Opengrep/Semgrep (SARIF) or knip (--reporter json);
                                   --base is the folder knip ran in, relative to the repo
  atlas sql "<select ...>"         read-only SQL; tables: symbols, edges, pairs, findings, meta
  atlas export [dir]               full lists as CSV: findings.csv (one row per finding member),
                                   symbols.csv (every code object), edges.csv (who uses whom)
`;

const { values: opt, positionals: [cmd, ...rest] } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" }, kind: { type: "string" }, path: { type: "string" },
    min: { type: "string" }, limit: { type: "string" }, base: { type: "string" }, "no-embed": { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});

const git = async (arg: string) => (await Bun.$`git rev-parse --path-format=absolute ${arg}`.quiet().nothrow().text()).trim();
// A worktree has no index of its own; fall back to the main checkout that holds .gitnexus.
const top = resolve(opt.repo ?? ((await git("--show-toplevel")) || "."));
const common = opt.repo ? "" : await git("--git-common-dir");
const main = common && dirname(common);
const repo = existsSync(resolve(top, ".gitnexus")) || !main ? top : main;
const limit = Number(opt.limit ?? 30) || -1; // 0 = all; SQLite LIMIT -1 = no limit
const print = (x: unknown) => console.log(JSON.stringify(x, null, 1));
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

if (!cmd || opt.help) { console.log(HELP); process.exit(0); }
if (!existsSync(resolve(repo, ".gitnexus"))) fail(`No GitNexus index in ${repo}. Run: gitnexus analyze`);

const db = open(repo);
const scanned = () => db.query("SELECT 1 FROM sqlite_master WHERE name = 'symbols'").get() ?? fail("No atlas yet. Run: atlas scan");

function toCsv(rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const head = Object.keys(rows[0] ?? {});
  return [head.join(","), ...rows.map((r) => head.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
}

/** Tools may print log lines before their JSON report; start at the first brace. */
function parseReport(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) fail("No JSON object in report");
  return JSON.parse(text.slice(start));
}

switch (cmd) {
  case "scan":
    db.close();
    print(await scan(repo, { embed: !opt["no-embed"] }));
    break;

  case "debt": {
    scanned();
    const where = ["score >= $min"];
    if (opt.kind) where.push("kind LIKE $kind");
    if (opt.path) where.push("file LIKE $path");
    print(db.query(`SELECT id, kind, score, title, file, line FROM findings WHERE ${where.join(" AND ")} ORDER BY score DESC LIMIT $limit`)
      .all({ $min: Number(opt.min ?? 0), $kind: `${opt.kind ?? ""}%`, $path: `${opt.path ?? ""}%`, $limit: limit }));
    break;
  }

  case "show": {
    const row = db.query<{ detail: string; ids: string }, [number]>("SELECT * FROM findings WHERE id = ?").get(Number(rest[0])) ?? fail("No such finding");
    print({ ...row, ids: JSON.parse(row.ids), detail: JSON.parse(row.detail) });
    break;
  }

  case "symbol": {
    scanned();
    const syms = db.query<{ id: string }, [string]>("SELECT * FROM symbols WHERE name = ? ORDER BY test, fan_in DESC LIMIT 20").all(rest[0] ?? "");
    print(syms.map((s) => ({
      ...s,
      findings: db.query("SELECT id, kind, score, title FROM findings WHERE ids LIKE ? ORDER BY score DESC").all(`%${JSON.stringify(s.id)}%`),
    })));
    break;
  }

  case "similar": {
    scanned();
    const cache = vectorCache(db);
    const rows = db.query<{ id: string; name: string; file: string; start_line: number; key: string }, []>(
      "SELECT id, name, file, start_line, code_key AS key FROM symbols WHERE code_key IS NOT NULL",
    ).all();
    const target = rows.find((r) => r.name === rest[0]) ?? fail(`No embedded code named ${rest[0]}`);
    const tv = cache.get(target.key)!;
    print(rows.filter((r) => r.id !== target.id)
      .map((r) => ({ id: r.id, name: r.name, file: r.file, line: r.start_line, similarity: +dot(tv, cache.get(r.key)!).toFixed(3) }))
      .sort((a, b) => b.similarity - a.similarity).slice(0, limit < 0 ? undefined : limit));
    break;
  }

  case "import": {
    const [kind, file] = rest;
    if ((kind !== "sarif" && kind !== "knip") || !file) fail("Usage: atlas import sarif|knip <file>");
    scanned();
    print(importReport(db, repo, kind as "sarif" | "knip", parseReport(await Bun.file(file!).text()), opt.base));
    break;
  }

  case "sql": {
    scanned();
    const q = rest.join(" ");
    if (!/^\s*(select|with|pragma table_info)\b/i.test(q)) fail("Only SELECT/WITH queries.");
    print(new Database(dbPath(repo), { readonly: true }).query(q).all());
    break;
  }

  case "export": {
    scanned();
    const dir = resolve(rest[0] ?? "atlas-export");
    mkdirSync(dir, { recursive: true });
    const files = {
      // One row per member, so a group of 8 copies lists all 8 places.
      "findings.csv": `SELECT f.id AS finding, f.kind, f.score, f.title, coalesce(s.file, f.file) AS file,
          coalesce(s.start_line, f.line) AS line, s.name AS symbol, f.source
        FROM findings f LEFT JOIN json_each(f.ids) m LEFT JOIN symbols s ON s.id = m.value
        ORDER BY f.score DESC, f.id, file, line`,
      "symbols.csv": `SELECT s.kind, s.name, s.file, s.start_line, s.end_line, s.lines, s.exported, s.test,
          s.fan_in, s.fan_out, s.churn, s.branches,
          (SELECT count(*) FROM findings f, json_each(f.ids) m WHERE m.value = s.id) AS findings
        FROM symbols s ORDER BY s.file, s.start_line`,
      "edges.csv": `SELECT e.type, a.name AS from_name, a.file AS from_file, a.start_line AS from_line,
          b.name AS to_name, b.file AS to_file, b.start_line AS to_line
        FROM edges e JOIN symbols a ON a.id = e.src JOIN symbols b ON b.id = e.dst ORDER BY from_file, from_line`,
    };
    const out: Record<string, number> = {};
    for (const [name, q] of Object.entries(files)) {
      const rows = db.query<Record<string, unknown>, []>(q).all();
      out[join(dir, name)] = rows.length;
      await Bun.write(join(dir, name), toCsv(rows));
    }
    print(out);
    break;
  }

  default:
    fail(HELP);
}
