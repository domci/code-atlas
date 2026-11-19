import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffScans } from "../src/diff";

type F = [kind: string, ids: string[], file?: string, rule?: string];
function scanDb(dir: string, name: string, findings: F[]) {
  const file = join(dir, `${name}.db`);
  const db = new Database(file);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE findings (id INTEGER PRIMARY KEY, source TEXT, kind TEXT, score INT, title TEXT, file TEXT, line INT, ids TEXT, detail TEXT);`);
  const ins = db.prepare("INSERT INTO findings (source, kind, score, title, file, line, ids, detail) VALUES (?,?,?,?,?,?,?,?)");
  for (const [kind, ids, f, rule] of findings) {
    ins.run(kind === "security" ? "sarif" : "atlas", kind, 50, `${rule ?? kind}: x`, f ?? ids[0]?.split(":")[1] ?? "", 1, JSON.stringify(ids), JSON.stringify(rule ? { ruleId: rule } : {}));
  }
  db.close();
  return file;
}

test("diff matches findings across scans by identity, move and overlap, not by row id", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-diff-"));
  try {
    const base = scanDb(dir, "base", [
      ["duplicate-exact", ["Function:a.ts:x", "Function:b.ts:x"]], // kept, now "renamed"
      ["duplicate-edited", ["Function:big.ts:p", "Function:big.ts:q", "Function:c.ts:p2"]], // file split: moved
      ["duplicate-renamed", ["Function:d.ts:m", "Function:e.ts:m", "Function:f.ts:m", "Function:g.ts:m"]], // one copy merged: changed
      ["unused", ["Function:old.ts:dead"]], // deleted: gone
      ["security", [], "s.ts", "xss"], ["security", [], "s.ts", "xss"], // one of two fixed
      ["hotspot", ["Function:big.ts:p"], "big.ts"], // split: gone
    ]);
    const head = scanDb(dir, "head", [
      ["duplicate-renamed", ["Function:b.ts:x", "Function:a.ts:x"]],
      ["duplicate-edited", ["Function:big/p.ts:p", "Function:big/q.ts:q", "Function:c.ts:p2"]],
      ["duplicate-renamed", ["Function:d.ts:m", "Function:e.ts:m", "Function:f.ts:m"]],
      ["unused", ["Function:new.ts:fresh"]], // new
      ["security", [], "s.ts", "xss"],
    ]);
    const d = diffScans(base, head);
    expect(d.summary.duplicate).toEqual({ base: 3, head: 3, gone: 0, new: 0, kept: 1, moved: 1, changed: 1 });
    expect(d.summary.unused).toMatchObject({ gone: 1, new: 1 });
    expect(d.summary.security).toMatchObject({ base: 2, head: 1, kept: 1, gone: 1 });
    expect(d.skipped).toEqual(["hotspot (only in base)"]); // not compared: the head scan has no hotspots at all
    expect(d.new.map((f) => f.file)).toEqual(["new.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
