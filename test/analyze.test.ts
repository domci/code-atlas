import { expect, test } from "bun:test";
import { dot, duplicates, hotspots, pairsAbove, unused, wrappers, type Unit } from "../src/analyze";
import { fingerprint, implicitUses } from "../src/fingerprint";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countsAsUse, mergeTwins, namespaceTargets } from "../src/scan";

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
    community: null, communityLabel: null, lines, churn: 0, test: false, code, fp: fingerprint(code, name), ...over,
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

test("wrapper ignores values built by a call, object constants, type guards and route handlers", async () => {
  const c = (code: string, name: string) => unit(code, { name, kind: "Const" });
  const found = wrappers([
    c("const schema = z.string().refine((p) => known.has(p));", "schema"),
    c("const load = cache(async (id) => fetchRow(id));", "load"),
    c("const OPTIONS = {\n  parse: (s) => Number(s),\n};", "OPTIONS"),
    unit("function isFeature(key: string): key is Feature {\n  return valid.has(key);\n}", { name: "isFeature" }),
    unit("export async function GET(request) {\n  return handler(request);\n}", { name: "GET" }),
    unit("function fwd(a) {\n  return other(a);\n}", { name: "fwd" }),
  ]);
  expect(found.map((f) => f.title)).toEqual(["fwd only forwards to another call"]);
});

test("unused skips interfaces merged into declare global / declare module", async () => {
  const src = 'declare global {\n  interface Window {\n    turnstile?: unknown;\n  }\n}\ndeclare module "vitest" {\n  export interface ProvidedContext {\n    url: string;\n  }\n}\ninterface Lonely {\n  x: number;\n}';
  const at = implicitUses(src);
  const iface = (name: string, start: number) =>
    unit(`interface ${name} {}`, { name, kind: "Interface", start, end: start + 2, implicitUse: at(name, start) });
  const lonely = iface("Lonely", 11);
  expect(unused([iface("Window", 2), iface("ProvidedContext", 7), lonely], [], new Map()).map((f) => f.ids[0])).toEqual([lonely.id]);
});

test("files imported as a namespace resolve through relative paths and tsconfig aliases", async () => {
  const repo = mkdtempSync(join(tmpdir(), "atlas-ns-"));
  try {
    const files: Record<string, string> = {
      "app/tsconfig.json": '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }\n}',
      "app/src/db/schema.ts": "export const users = pgTable('users', {});",
      "app/src/db/relations.ts": "export const usersRelations = relations(users, () => ({}));",
      "app/src/db/named.ts": "export const plain = 1;",
      "app/src/db/client.ts": 'import * as schema from "./schema";\nexport * as rel from "@/db/relations";\nimport { plain } from "./named";\nimport * as z from "zod";',
      "app/src/db/client.test.ts": 'import * as named from "./named";',
    };
    for (const [f, text] of Object.entries(files)) await Bun.write(join(repo, f), text);
    await Bun.$`git -C ${repo} init -q && git -C ${repo} add -A`.quiet();
    const got = await namespaceTargets(repo, new Set(Object.keys(files)));
    expect([...got].sort()).toEqual(["app/src/db/relations.ts", "app/src/db/schema.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unused skips methods of classes that extend or implement (React lifecycle)", async () => {
  const cls = unit("class Boundary extends Component {\n  componentDidCatch(error) {\n    log(error);\n  }\n}", { name: "Boundary", kind: "Class", file: "src/b.tsx", start: 1, end: 5 });
  const method = unit("componentDidCatch(error) {\n  log(error);\n}", { name: "componentDidCatch", kind: "Method", file: "src/b.tsx", start: 2, end: 4 });
  const plain = unit("class Plain {\n  helper() {\n    return 1;\n  }\n}", { name: "Plain", kind: "Class", file: "src/p.ts", start: 1, end: 5 });
  const dead = unit("helper() {\n  return 1;\n}", { name: "helper", kind: "Method", file: "src/p.ts", start: 2, end: 4 });
  const names = new Map([["Boundary", 2], ["Plain", 2]]);
  expect(unused([cls, method, plain, dead], [], names).map((f) => f.ids[0])).toEqual([dead.id]);
});

test("unused skips a default export imported under another name", async () => {
  const at = implicitUses("export default function OfficeLayout() {\n  return null;\n}\nfunction Unused() {}\n");
  const layout = unit(body("OfficeLayout"), { implicitUse: at("OfficeLayout", 1) });
  const other = unit(body("Unused"), { implicitUse: at("Unused", 4) });
  expect(unused([layout, other], [], new Map()).map((f) => f.ids[0])).toEqual([other.id]);
  expect(implicitUses("class A {}\nexport { A as default };")("A", 1)).toBe(true);
});

test("name references ignore Markdown and MDX in docs/ and plans/, not code", async () => {
  expect(["README.md", "docs/guide.mdx", "apps/x/plans/p.mdx", "src/app/docs/page.tsx", "content/blog/a.mdx"].filter(countsAsUse))
    .toEqual(["src/app/docs/page.tsx", "content/blog/a.mdx"]);
});

test("hotspots are one finding per file listing its functions", async () => {
  const hot = (name: string, file: string) =>
    unit(`function ${name}(a) {\n  if (a && b || c ?? d) return a ? 1 : 2;\n  return 0;\n}`, { name, file, churn: 5 });
  const found = hotspots([hot("a1", "src/a.ts"), hot("a2", "src/a.ts"), hot("b1", "src/b.ts")], []);
  expect(found.map((f) => f.ids.length)).toEqual([2, 1]);
  expect(found[0]!.title).toContain("src/a.ts: 2 complex functions");
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
