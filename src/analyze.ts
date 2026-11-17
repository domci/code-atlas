import { dirname } from "node:path";
import { bands, jaccard, type Fingerprint } from "./fingerprint";
import type { Edge, Sym } from "./graph";

export type Unit = Sym & {
  lines: number;
  /** Commits touching the file in the churn window. */
  churn: number;
  test: boolean;
  fp?: Fingerprint;
  /** Source text, only held during a scan. */
  code?: string;
  codeVec?: Float32Array;
  nameVec?: Float32Array;
};
export type Pair = { a: string; b: string; kind: DupKind; score: number };
export type Finding = { kind: string; score: number; ids: string[]; title: string; detail: Record<string, unknown> };
type DupKind = "exact" | "renamed" | "edited" | "meaning";

export const LIMITS = {
  dupMinTokens: 40,
  editedMinJaccard: 0.8,
  meaningMinLines: 6,
  meaningMinCos: 0.95,
  /** Two names this close by meaning lower the code bar for a "same concept" pair. */
  sameNameCos: 0.9,
  sameNameCodeCos: 0.88,
  /** Edited/same-meaning groups larger than this are a repeated pattern, not copies. */
  maxLooseGroup: 8,
};
const DUP_WEIGHT: Record<DupKind, number> = { exact: 1, renamed: 0.9, edited: 0.8, meaning: 0.6 };

const isTestFile = (f: string) => /(^|\/)(__tests__|tests?|e2e|fixtures?|__mocks__)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(f);
export const testFile = isTestFile;

/** Exact, renamed, edited and same-meaning copies, as pairs and as one finding per group. */
export function duplicates(units: Unit[]): { pairs: Pair[]; findings: Finding[] } {
  const pool = units.filter((u) => !u.test && u.fp && u.fp.tokens >= LIMITS.dupMinTokens);
  const logic = pool.filter((u) => !u.fp!.data);
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  const add = (a: Unit, b: Unit, kind: DupKind, score: number) => {
    if (a.id === b.id || contains(a, b) || contains(b, a)) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a: a.id, b: b.id, kind, score });
  };

  for (const [field, kind] of [["exact", "exact"], ["shape", "renamed"]] as const) {
    // Same shape with other values is just two data tables, not copied logic.
    const members = kind === "renamed" ? logic : pool;
    for (const group of groupBy(members, (u) => u.fp![field]).values()) {
      for (let i = 1; i < group.length; i++) add(group[0]!, group[i]!, kind, 1);
    }
  }

  const buckets = new Map<string, Unit[]>();
  for (const u of logic) for (const b of bands(u.fp!.minhash)) push(buckets, b, u);
  for (const group of buckets.values()) {
    if (group.length > 50) continue; // ponytail: huge buckets are boilerplate shapes; skip, not O(n²)
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const s = jaccard(group[i]!.fp!.minhash, group[j]!.fp!.minhash);
        if (s >= LIMITS.editedMinJaccard) add(group[i]!, group[j]!, "edited", s);
      }
    }
  }

  // ponytail: all-pairs dot products, O(n²). Fine to ~30k bodies; use an ANN index beyond that.
  const vec = logic.filter((u) => u.codeVec && u.lines >= LIMITS.meaningMinLines);
  for (let i = 0; i < vec.length; i++) {
    const a = vec[i]!;
    for (let j = i + 1; j < vec.length; j++) {
      const b = vec[j]!;
      const s = dot(a.codeVec!, b.codeVec!);
      if (s >= LIMITS.meaningMinCos) add(a, b, "meaning", s);
      else if (s >= LIMITS.sameNameCodeCos && a.nameVec && b.nameVec && dot(a.nameVec, b.nameVec) >= LIMITS.sameNameCos) {
        add(a, b, "meaning", s);
      }
    }
  }

  const byId = new Map(pool.map((u) => [u.id, u]));
  // Exact and renamed copies are equal to each other, so their groups are true groups.
  const strong = pairs.filter((p) => p.kind === "exact" || p.kind === "renamed");
  const groupOf = new Map<string, number>();
  const strongGroups = clusters(strong);
  strongGroups.forEach((ids, i) => ids.forEach((id) => groupOf.set(id, i)));
  // Edited and same-meaning pairs are not transitive: a~b and b~c does not make a~c.
  // Small groups are kept; a large one is a repeated pattern, reported once at lower weight.
  const loose = pairs.filter((p) => !strong.includes(p) && (groupOf.get(p.a) === undefined || groupOf.get(p.a) !== groupOf.get(p.b)));
  const finding = (ids: string[], inGroup: Pair[]): Finding => {
    const best = inGroup.reduce((m, p) => (DUP_WEIGHT[p.kind] * p.score > DUP_WEIGHT[m.kind] * m.score ? p : m));
    const kind = best.kind === "exact" && inGroup.some((p) => p.kind === "renamed") ? "renamed" : best.kind;
    const members = ids.map((id) => byId.get(id)!);
    const extraLines = members.reduce((s, u) => s + u.lines, 0) - Math.max(...members.map((u) => u.lines));
    const pattern = ids.length > LIMITS.maxLooseGroup && (kind === "edited" || kind === "meaning");
    const score = Math.round(100 * DUP_WEIGHT[kind] * best.score * Math.min(1, 0.4 + extraLines / 100) * (pattern ? 0.5 : 1));
    return {
      kind: `duplicate-${kind}`,
      score,
      ids,
      title: pattern
        ? `${members.length} similar bodies like ${members[0]!.name} (repeated pattern, ${extraLines} lines)`
        : `${members.length} copies of ${members[0]!.name} (${kind}, ${extraLines} extra lines)`,
      detail: { members: members.map(ref), pairs: inGroup.slice(0, 50) },
    };
  };
  const findings = [
    ...strongGroups.map((ids) => finding(ids, strong.filter((p) => groupOf.get(p.a) === groupOf.get(ids[0]!)))),
    ...clusters(loose).map((ids) => {
      const set = new Set(ids);
      return finding(ids, loose.filter((p) => set.has(p.a)));
    }),
  ];
  return { pairs, findings };
}

/** Next.js, Remix, Astro, config and worker entry files are used by the framework, not by imports. */
const FRAMEWORK_FILE = /(^|\/)(page|layout|route|loading|error|not-found|middleware|proxy|default|template|global-error|instrumentation|head|opengraph-image|icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$|\.config\.[cm]?[jt]s$|(^|\/)(worker|index|main|server|cli)\.[cm]?[jt]sx?$/;
const FRAMEWORK_NAME = /^(default|constructor|render|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|generateMetadata|generateStaticParams|loader|action|fetch|scheduled|queue|toString|toJSON)$/;
const DEAD_KINDS = new Set(["Function", "Method", "Class", "Interface", "TypeAlias", "Enum"]);
/** `name: (…) =>` or `"a.b": async …` inside an object: a callback some library or table calls by key. */
const OBJECT_MEMBER = /^\s*(async\s+)?(["'][^"']+["']|[\w$]+)\s*:/;

/**
 * Code objects nothing uses: no use edge in the graph, and the name appears nowhere else as code.
 * The graph alone misses values passed around (`action={save}`); the name check alone misses nothing
 * but can be fooled by another object of the same name, which only hides findings, never invents them.
 */
export function unused(units: Unit[], edges: Edge[], nameCount: Map<string, number>): Finding[] {
  const usedBy = incoming(edges);
  const declared = new Map<string, number>();
  for (const u of units) declared.set(u.name, (declared.get(u.name) ?? 0) + 1);
  return units
    .filter((u) => DEAD_KINDS.has(u.kind) && !u.test && !FRAMEWORK_FILE.test(u.file) && !FRAMEWORK_NAME.test(u.name))
    .filter((u) => (usedBy.get(u.id) ?? 0) === 0 && (nameCount.get(u.name) ?? 0) <= (declared.get(u.name) ?? 1))
    .filter((u) => !(u.code && OBJECT_MEMBER.test(u.code)))
    .map((u) => ({
      kind: "unused",
      score: Math.round((u.exported ? 30 : 55) * Math.min(1, 0.4 + u.lines / 40)),
      ids: [u.id],
      title: `${u.kind} ${u.name} has no users${u.exported ? " (exported: check other packages)" : ""}`,
      detail: { ...ref(u) },
    }));
}

/** Complex code that changes often and that much depends on: the riskiest places to touch. */
export function hotspots(units: Unit[], edges: Edge[], top = 100): Finding[] {
  const usedBy = incoming(edges);
  const scored = units
    .filter((u) => !u.test && u.fp && u.fp.branches >= 5 && u.churn >= 3)
    .map((u) => ({ u, raw: u.churn * u.fp!.branches * Math.log2(2 + (usedBy.get(u.id) ?? 0)) }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, top);
  const max = scored[0]?.raw ?? 1;
  return scored.map(({ u, raw }) => ({
    kind: "hotspot",
    score: Math.round(30 + 50 * (raw / max)),
    ids: [u.id],
    title: `${u.name}: ${u.fp!.branches} branches, ${u.churn} recent commits, ${usedBy.get(u.id) ?? 0} users`,
    detail: { ...ref(u), branches: u.fp!.branches, churn: u.churn, fanIn: usedBy.get(u.id) ?? 0 },
  }));
}

/** Functions that mostly talk to another group of code, in another folder: candidates to move. */
export function misplaced(units: Unit[], edges: Edge[]): Finding[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const neighbours = new Map<string, Unit[]>();
  for (const e of edges) {
    if (e.type !== "CALLS") continue;
    const a = byId.get(e.src), b = byId.get(e.dst);
    if (!a || !b || a.id === b.id) continue;
    push(neighbours, a.id, b);
    push(neighbours, b.id, a);
  }
  const folderOf = new Map<string, Map<string, number>>();
  for (const u of units) if (u.community) count(folderOf, u.community, dirname(u.file));

  const out: Finding[] = [];
  for (const u of units) {
    const ns = neighbours.get(u.id);
    if (u.test || !u.community || !ns || ns.length < 4) continue;
    const shares = new Map<string, number>();
    for (const n of ns) if (n.community) shares.set(n.community, (shares.get(n.community) ?? 0) + 1 / ns.length);
    const own = shares.get(u.community) ?? 0;
    const [other, share] = [...shares].filter(([c]) => c !== u.community).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const home = top(folderOf.get(other));
    if (own > 0.25 || share < 0.6 || !home || home === dirname(u.file)) continue;
    out.push({
      kind: "misplaced",
      score: Math.round(30 + 30 * share),
      ids: [u.id],
      title: `${u.name} works mostly with ${home} (${Math.round(share * 100)}% of its calls)`,
      detail: { ...ref(u), suggestedFolder: home, share, ownShare: own },
    });
  }
  return out;
}

/** Functions whose body only forwards their parameters to another call. */
export function wrappers(units: Unit[]): Finding[] {
  return units
    .filter((u) => !u.test && u.fp?.wrapper && u.kind !== "Method")
    .map((u) => ({
      kind: "wrapper",
      score: u.exported ? 20 : 30,
      ids: [u.id],
      title: `${u.name} only forwards to another call`,
      detail: { ...ref(u) },
    }));
}

/** Cosine similarity of two unit-length vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** "formatPriceLabel" → "format price label", so names compare by meaning, not spelling. */
export const nameText = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$-]+/g, " ").toLowerCase().trim();

export function incoming(edges: Edge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) if (e.src !== e.dst) m.set(e.dst, (m.get(e.dst) ?? 0) + 1);
  return m;
}

const ref = (u: Unit) => ({ id: u.id, name: u.name, kind: u.kind, file: u.file, line: u.start, lines: u.lines });
const contains = (outer: Unit, inner: Unit) => outer.file === inner.file && outer.start <= inner.start && outer.end >= inner.end;

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) push(m, key(x), x);
  return m;
}
function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}
function count(m: Map<string, Map<string, number>>, k: string, v: string) {
  const inner = m.get(k) ?? new Map<string, number>();
  inner.set(v, (inner.get(v) ?? 0) + 1);
  m.set(k, inner);
}
const top = (m?: Map<string, number>) => (m ? [...m].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined);

/** Connected groups of ids linked by pairs (union-find). */
function clusters(pairs: Pair[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const p of pairs) parent.set(find(p.a), find(p.b));
  const groups = new Map<string, string[]>();
  for (const id of new Set(pairs.flatMap((p) => [p.a, p.b]))) push(groups, find(id), id);
  return [...groups.values()];
}
