import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/fingerprint";
import { formatHits, newCopies, unreported } from "../src/new";
import { open, writeScan } from "../src/store";

const fn = (name: string, v = "total") => `export function ${name}(items: { price: number; active: boolean }[]) {
  let ${v} = 0;
  for (const item of items) {
    if (item.price > 0 && item.active) ${v} += item.price * 2;
  }
  return Math.round(${v} * 100) / 100;
}
`;

test("atlas new flags a planted copy of scanned code, only once it is new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-new-"));
  const cache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  try {
    const sh = (c: string) => Bun.$`sh -c ${c}`.cwd(dir).quiet();
    await sh("git init -q && git config user.email a@b && git config user.name a");
    writeFileSync(join(dir, "a.ts"), fn("sumA"));
    await sh("git add . && git commit -qm init");
    const fp = fingerprint(fn("sumA"), "sumA");
    const db = open(dir);
    writeScan(db, [{ id: "F:1", kind: "Function", name: "sumA", file: "a.ts", start: 1, end: 7, lines: 7, exported: true, test: false,
      community: null, communityLabel: null, churn: 0, fp }], [], [], [], new Map());
    db.close();
    const dbFile = db.filename;

    expect(await newCopies(dir, dbFile)).toEqual([]); // nothing changed
    writeFileSync(join(dir, "b.ts"), fn("sumB", "acc")); // untracked renamed copy
    const hits = await newCopies(dir, dbFile);
    expect(hits.map((h) => [h.file, h.name, h.kind, h.of])).toEqual([["b.ts", "sumB", "renamed", "sumA"]]);
    expect(formatHits(hits)).toContain("b.ts:1 sumB: renamed copy of sumA (a.ts:1)");
    expect(await newCopies(dir, join(dir, "none.db"))).toEqual([]); // no scan
    await sh("git checkout -qb feature && git add . && git commit -qm copy"); // committed on a branch before the stop
    expect((await newCopies(dir, dbFile)).map((h) => h.name)).toEqual(["sumB"]);
    expect(await unreported(dir, hits)).toEqual(hits);
    expect(await unreported(dir, hits)).toEqual([]); // raised once per worktree
  } finally {
    if (cache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = cache;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atlas new ignores code that moved away from its scanned place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-move-"));
  const cache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  try {
    const sh = (c: string) => Bun.$`sh -c ${c}`.cwd(dir).quiet();
    await sh("git init -q && git config user.email a@b && git config user.name a");
    writeFileSync(join(dir, "a.ts"), fn("sumA"));
    await sh("git add . && git commit -qm init");
    const db = open(dir);
    writeScan(db, [{ id: "F:1", kind: "Function", name: "sumA", file: "a.ts", start: 1, end: 7, lines: 7, exported: true, test: false,
      community: null, communityLabel: null, churn: 0, fp: fingerprint(fn("sumA"), "sumA") }], [], [], [], new Map());
    db.close();

    writeFileSync(join(dir, "a.ts"), 'export { sumA } from "./b";\n'); // moved: the old file only re-exports it
    writeFileSync(join(dir, "b.ts"), fn("sumA"));
    expect(await newCopies(dir, db.filename)).toEqual([]);
  } finally {
    if (cache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = cache;
    rmSync(dir, { recursive: true, force: true });
  }
});
