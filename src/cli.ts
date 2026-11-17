#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
                                   ranked findings; kinds: duplicate-exact, duplicate-renamed,
                                   duplicate-edited, duplicate-meaning, unused, hotspot, misplaced,
                                   wrapper, plus imported ones (security, knip-*)
  atlas show <findingId>           one finding with all details
  atlas symbol <name>              where a name is defined, its numbers and its findings
  atlas similar <name> [--limit n] code that means the same as <name>, by embedding
  atlas import sarif|knip <file> [--base dir]
                                   add findings from Opengrep/Semgrep (SARIF) or knip (--reporter json);
                                   --base is the folder knip ran in, relative to the repo
  atlas sql "<select ...>"         read-only SQL; tables: symbols, edges, pairs, findings, meta
`;

const { values: opt, positionals: [cmd, ...rest] } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" }, kind: { type: "string" }, path: { type: "string" },
    min: { type: "string" }, limit: { type: "string" }, base: { type: "string" }, "no-embed": { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});

const repo = resolve(opt.repo ?? ((await Bun.$`git rev-parse --show-toplevel`.quiet().nothrow().text()).trim() || "."));
const limit = Number(opt.limit ?? 30);
const print = (x: unknown) => console.log(JSON.stringify(x, null, 1));
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

if (!cmd || opt.help) { console.log(HELP); process.exit(0); }
if (!existsSync(resolve(repo, ".gitnexus"))) fail(`No GitNexus index in ${repo}. Run: gitnexus analyze`);

const db = open(repo);
const scanned = () => db.query("SELECT 1 FROM sqlite_master WHERE name = 'symbols'").get() ?? fail("No atlas yet. Run: atlas scan");

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
      .sort((a, b) => b.similarity - a.similarity).slice(0, limit));
    break;
  }

  case "import": {
    const [kind, file] = rest;
    if ((kind !== "sarif" && kind !== "knip") || !file) fail("Usage: atlas import sarif|knip <file>");
    scanned();
    print(importReport(db, repo, kind as "sarif" | "knip", await Bun.file(file!).json(), opt.base));
    break;
  }

  case "sql": {
    scanned();
    const q = rest.join(" ");
    if (!/^\s*(select|with|pragma table_info)\b/i.test(q)) fail("Only SELECT/WITH queries.");
    print(new Database(dbPath(repo), { readonly: true }).query(q).all());
    break;
  }

  default:
    fail(HELP);
}
