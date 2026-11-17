// Lays out the call graph of a scanned repo for docs/network-graph.html.
// Usage: bun docs/network-layout.ts <atlas.db> <out.json>
// Output holds positions only, no names: [x, y, inDuplicateGroup] per node and [i, j] per edge.
import { Database } from "bun:sqlite";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

const [dbFile, out] = process.argv.slice(2);
if (!dbFile || !out) throw new Error("Usage: bun docs/network-layout.ts <atlas.db> <out.json>");
const db = new Database(dbFile, { readonly: true });

const prod = new Set(db.query<{ id: string }, []>("SELECT id FROM symbols WHERE test = 0").all().map((r) => r.id));
const dup = new Set(db.query<{ id: string }, []>(
  "SELECT DISTINCT j.value AS id FROM findings f, json_each(f.ids) j WHERE f.kind LIKE 'duplicate-%'",
).all().map((r) => r.id));

const g = new Graph({ type: "undirected", multi: false });
for (const e of db.query<{ src: string; dst: string }, []>("SELECT src, dst FROM edges").all()) {
  if (e.src === e.dst || !prod.has(e.src) || !prod.has(e.dst)) continue;
  for (const id of [e.src, e.dst]) if (!g.hasNode(id)) g.addNode(id, { x: Math.random() * 1000, y: Math.random() * 1000 });
  if (!g.hasEdge(e.src, e.dst)) g.addEdge(e.src, e.dst);
}
console.error(`graph: ${g.order} connected objects, ${g.size} links`);

const t0 = performance.now();
forceAtlas2.assign(g, {
  iterations: 500,
  settings: { ...forceAtlas2.inferSettings(g), barnesHutOptimize: true, strongGravityMode: true, gravity: 0.05, scalingRatio: 10 },
});
console.error(`layout: ${Math.round((performance.now() - t0) / 1000)} s`);

const index = new Map<string, number>();
const nodes: [number, number, number][] = [];
g.forEachNode((id, a) => { index.set(id, nodes.length); nodes.push([+a.x.toFixed(1), +a.y.toFixed(1), dup.has(id) ? 1 : 0]); });
const edges: [number, number][] = [];
g.forEachEdge((_e, _a, s, t) => edges.push([index.get(s)!, index.get(t)!]));
await Bun.write(out, JSON.stringify({ nodes, edges, dup: nodes.filter((n) => n[2]).length }));
