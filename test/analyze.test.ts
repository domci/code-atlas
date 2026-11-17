import { expect, test } from "bun:test";
import { dot, duplicates, pairsAbove, unused, wrappers, type Unit } from "../src/analyze";
import { fingerprint } from "../src/fingerprint";
import { mergeTwins } from "../src/scan";

const body = (name: string, a = "total", b = "items") => `function ${name}(${b}) {
  let ${a} = 0;
  for (const item of ${b}) {
    if (item.price > 0 && item.active) ${a} += item.price * item.quantity;
  }
  return Math.round(${a} * 100) / 100;
}`;

let n = 0;
function unit(code: string, over: Partial<Unit> = {}): Unit {
  const name = over.name ?? code.match(/function (\w+)/)?.[1] ?? `u${n}`;
  const lines = code.split("\n").length;
  return {
    id: `Function:${n++}`, kind: "Function", name, file: `src/f${n}.ts`, start: 0, end: lines - 1, exported: false,
    community: null, communityLabel: null, lines, churn: 0, test: false, fp: fingerprint(code, name), ...over,
  };
}
const kinds = async (us: Unit[]) => (await duplicates(us)).findings.map((f) => f.kind).sort();

test("a plain copy under another name is an exact duplicate", async () => {
  expect(await kinds([unit(body("sumA")), unit(body("sumB"))])).toEqual(["duplicate-exact"]);
});

test("a copy with renamed variables is a renamed duplicate", async () => {
  expect(await kinds([unit(body("sumA")), unit(body("sumB", "acc", "rows"))])).toEqual(["duplicate-renamed"]);
});

test("a copy with an extra statement is an edited duplicate", async () => {
  const edited = body("sumB").replace("return", "console.log(total);\n  return");
  expect(await kinds([unit(body("sumA")), unit(edited)])).toEqual(["duplicate-edited"]);
});

test("same meaning by embedding is found; unrelated code is not", async () => {
  const v = (x: number) => Float32Array.from([x, Math.sqrt(1 - x * x)]);
  const other = `function load(id) {\n  const row = db.get(id);\n  if (!row) throw new Error("missing");\n  return { ...row, loadedAt: Date.now(), source: "db", fresh: true };\n}\n\n`;
  const a = unit(body("sumA"), { codeVec: v(1) });
  const b = unit(other, { codeVec: v(0.99) });
  const c = unit(other.replace("load", "fetchIt").replaceAll("row", "r").replace("missing", "gone") + "\n", { codeVec: v(0) });
  expect((await duplicates([a, b])).findings.map((f) => f.kind)).toEqual(["duplicate-meaning"]);
  expect((await duplicates([a, c])).findings).toEqual([]);
});

test("data tables only count when copied exactly", async () => {
  const table = (k: string, v: string) => `const ${k} = {\n  alpha: { label: "${v}1", weight: 1, tags: ["a", "b"] },\n  beta: { label: "${v}2", weight: 2, tags: ["c", "d"] },\n  gamma: { label: "${v}3", weight: 3, tags: ["e", "f"] },\n};`;
  expect(await kinds([unit(table("A", "x"), { name: "A" }), unit(table("B", "y"), { name: "B" })])).toEqual([]);
  expect(await kinds([unit(table("A", "x"), { name: "A" }), unit(table("B", "x"), { name: "B" })])).toEqual(["duplicate-exact"]);
});

test("small bodies and test files are not reported as duplicates", async () => {
  const tiny = "function a(x) { return x + 1 }";
  expect(await kinds([unit(tiny), unit(tiny.replace("a(", "b("))])).toEqual([]);
  expect(await kinds([unit(body("sumA")), unit(body("sumB"), { test: true, file: "src/x.test.ts" })])).toEqual([]);
});

test("unused finds objects without users or name references, but not framework entry points", async () => {
  const used = unit(body("used"));
  const dead = unit(body("dead"));
  const page = unit(body("Page"), { file: "app/page.tsx" });
  const caller = unit(body("caller"));
  const passed = unit(body("passed"));
  const names = new Map([["used", 2], ["dead", 1], ["Page", 1], ["caller", 1], ["passed", 2]]);
  const found = unused([used, dead, page, caller, passed], [{ src: caller.id, dst: used.id, type: "CALLS" }], names);
  expect(found.map((f) => f.ids[0])).toEqual([dead.id, caller.id]);
});

test("wrapper flags bodies that only forward their parameters", async () => {
  const w = unit("const fwd = (a, b) => other(a, b);", { name: "fwd", kind: "Const" });
  const notW = unit("const fwd2 = (a, b) => other(b, a);", { name: "fwd2", kind: "Const" });
  const onLiteral = unit("const isImg = (k) => /image|logo/.test(k);", { name: "isImg", kind: "Const" });
  expect(wrappers([w, notW, onLiteral]).map((f) => f.ids[0])).toEqual([w.id]);
});

test("a long chain of loosely similar bodies is one low-weight pattern, not copies", async () => {
  const v = Float32Array.from([1, 0]);
  const loads = Array.from({ length: 10 }, (_, i) =>
    unit(`function load${i}(id) {\n  const row = db.get(id);\n${"  log(row, id);\n".repeat(i)}  if (!row) throw new Error("no");\n  return { ...row, kind: ${i} };\n}\n`, { codeVec: v }));
  const [f] = (await duplicates(loads)).findings;
  expect(f?.title).toContain("repeated pattern");
  expect(f!.score).toBeLessThan(50);
});

test("mergeTwins folds a declaration GitNexus stored twice and moves its edges", async () => {
  const fn = { id: "Function:a.ts:f", kind: "Function", name: "f", file: "a.ts", start: 3, end: 5, exported: false, community: "c1", communityLabel: null };
  const twin = { ...fn, id: "Const:a.ts:f", kind: "Const", exported: true, community: null };
  const out = mergeTwins([fn, twin], [{ src: "x", dst: twin.id, type: "CALLS" }, { src: "x", dst: fn.id, type: "CALLS" }]);
  expect(out.symbols.map((s) => [s.id, s.exported, s.community])).toEqual([[fn.id, true, "c1"]]);
  expect(out.edges).toEqual([{ src: "x", dst: fn.id, type: "CALLS" }]);
});

test("pairsAbove split over workers finds exactly the pairs a plain loop finds", async () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const vs = Array.from({ length: 1200 }, () => {
    const v = Float32Array.from({ length: 8 }, rnd);
    const len = Math.hypot(...v);
    return v.map((x) => x / len);
  });
  const want: string[] = [];
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) if (dot(vs[i]!, vs[j]!) >= 0.9) want.push(`${i},${j}`);
  const got = await pairsAbove(vs, 0.9);
  const keys: string[] = [];
  for (let x = 0; x < got.length; x += 3) keys.push(`${got[x]},${got[x + 1]}`);
  expect(want.length).toBeGreaterThan(100);
  expect(keys.sort()).toEqual(want.sort());
});
