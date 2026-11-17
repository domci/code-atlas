import { expect, test } from "bun:test";
import { duplicates, misplaced, unused, wrappers, type Unit } from "../src/analyze";
import { fingerprint } from "../src/fingerprint";

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
const kinds = (us: Unit[]) => duplicates(us).findings.map((f) => f.kind).sort();

test("a plain copy under another name is an exact duplicate", () => {
  expect(kinds([unit(body("sumA")), unit(body("sumB"))])).toEqual(["duplicate-exact"]);
});

test("a copy with renamed variables is a renamed duplicate", () => {
  expect(kinds([unit(body("sumA")), unit(body("sumB", "acc", "rows"))])).toEqual(["duplicate-renamed"]);
});

test("a copy with an extra statement is an edited duplicate", () => {
  const edited = body("sumB").replace("return", "console.log(total);\n  return");
  expect(kinds([unit(body("sumA")), unit(edited)])).toEqual(["duplicate-edited"]);
});

test("same meaning by embedding is found; unrelated code is not", () => {
  const v = (x: number) => Float32Array.from([x, Math.sqrt(1 - x * x)]);
  const other = `function load(id) {\n  const row = db.get(id);\n  if (!row) throw new Error("missing");\n  return { ...row, loadedAt: Date.now(), source: "db", fresh: true };\n}\n\n`;
  const a = unit(body("sumA"), { codeVec: v(1) });
  const b = unit(other, { codeVec: v(0.99) });
  const c = unit(other.replace("load", "fetchIt").replaceAll("row", "r").replace("missing", "gone") + "\n", { codeVec: v(0) });
  expect(duplicates([a, b]).findings.map((f) => f.kind)).toEqual(["duplicate-meaning"]);
  expect(duplicates([a, c]).findings).toEqual([]);
});

test("small bodies and test files are not reported as duplicates", () => {
  const tiny = "function a(x) { return x + 1 }";
  expect(kinds([unit(tiny), unit(tiny.replace("a(", "b("))])).toEqual([]);
  expect(kinds([unit(body("sumA")), unit(body("sumB"), { test: true, file: "src/x.test.ts" })])).toEqual([]);
});

test("unused finds objects without users, but not framework entry points", () => {
  const used = unit(body("used"));
  const dead = unit(body("dead"));
  const page = unit(body("Page"), { file: "app/page.tsx" });
  const caller = unit(body("caller"));
  const found = unused([used, dead, page, caller], [{ src: caller.id, dst: used.id, type: "CALLS" }]);
  expect(found.map((f) => f.ids[0])).toEqual([dead.id, caller.id]);
});

test("wrapper flags bodies that only forward their parameters", () => {
  const w = unit("const fwd = (a, b) => other(a, b);", { name: "fwd", kind: "Const" });
  const notW = unit("const fwd2 = (a, b) => other(b, a);", { name: "fwd2", kind: "Const" });
  expect(wrappers([w, notW]).map((f) => f.ids[0])).toEqual([w.id]);
});

test("misplaced flags a function that mostly calls another group in another folder", () => {
  const home = Array.from({ length: 5 }, (_, i) => unit(body(`b${i}`), { file: `billing/b${i}.ts`, community: "billing" }));
  const stray = unit(body("invoiceTotal"), { file: "ui/helpers.ts", community: "ui" });
  const edges = home.map((h) => ({ src: stray.id, dst: h.id, type: "CALLS" }));
  expect(misplaced([...home, stray], edges).map((f) => f.detail.suggestedFolder)).toEqual(["billing"]);
});
