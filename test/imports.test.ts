import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { importReport } from "../src/imports";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE symbols (id TEXT, file TEXT, start_line INT, end_line INT, lines INT);
    CREATE TABLE findings (id INTEGER PRIMARY KEY, source TEXT, kind TEXT, score INT, title TEXT, file TEXT, line INT, ids TEXT, detail TEXT);
    INSERT INTO symbols VALUES ('Class:a.ts:A', 'src/a.ts', 1, 50, 50), ('Method:a.ts:A.run', 'src/a.ts', 10, 20, 11);
  `);
  return d;
}
const rows = (d: Database) => d.query<{ source: string; kind: string; score: number; file: string; ids: string }, []>(
  "SELECT source, kind, score, file, ids FROM findings ORDER BY id").all();

test("SARIF results become security findings on the smallest enclosing symbol", () => {
  const d = db();
  const sarif = { runs: [{ tool: { driver: { name: "opengrep", rules: [
    { id: "x.rules.javascript.lang.security.sqli", defaultConfiguration: { level: "error" }, properties: { tags: ["security"] } },
  ] } }, results: [{
    ruleId: "x.rules.javascript.lang.security.sqli", message: { text: "SQL built from input" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "/repo/src/a.ts" }, region: { startLine: 12 } } }],
  }] }] };
  importReport(d, "/repo", "sarif", sarif);
  expect(rows(d)).toEqual([{ source: "sarif", kind: "security", score: 85, file: "src/a.ts", ids: '["Method:a.ts:A.run"]' }]);
});

test("knip paths are prefixed with --base, and a re-import replaces the old one", () => {
  const d = db();
  const knip = { issues: [{ file: "src/a.ts", exports: [{ name: "A", line: 1 }], files: [] }] };
  importReport(d, "/repo", "knip", knip);
  importReport(d, "/repo", "knip", knip, "apps/x");
  importReport(d, "/repo", "knip", knip, "apps/x");
  expect(rows(d).map((r) => [r.source, r.kind, r.file])).toEqual([
    ["knip:", "knip-exports", "src/a.ts"],
    ["knip:apps/x", "knip-exports", "apps/x/src/a.ts"],
  ]);
});
