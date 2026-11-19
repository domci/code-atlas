import { Database } from "bun:sqlite";

type Row = { id: number; kind: string; score: number; title: string; file: string; line: number; ids: string[]; rule?: string };
export type Change = "kept" | "moved" | "changed";
type Count = { base: number; head: number; gone: number; new: number; kept: number; moved: number; changed: number };

/** Duplicate kinds count as one family: a copy that is now "renamed" instead of "exact" is still the same copy. */
const family = (kind: string) => (kind.startsWith("duplicate") ? "duplicate" : kind);
// Symbol ids are `Kind:file:name` (methods may end in `#n`); the name survives a move to another file.
const nameOf = (id: string) => id.slice(id.lastIndexOf(":") + 1).replace(/#\d+$/, "");
const sorted = (xs: string[]) => [...xs].sort().join("|");

function load(file: string): { rows: Row[]; scannedAt?: string } {
  const db = new Database(file, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'findings'").get()) throw new Error(`No atlas scan in ${file}`);
    const rows = db.query<{ id: number; kind: string; score: number; title: string; file: string; line: number; ids: string; detail: string }, []>(
      "SELECT id, kind, score, title, file, line, ids, detail FROM findings",
    ).all().map((r) => {
      const detail = (() => { try { return JSON.parse(r.detail ?? "{}"); } catch { return {}; } })();
      return { ...r, ids: JSON.parse(r.ids || "[]") as string[], rule: detail.ruleId ?? (r.kind === "security" ? r.title.split(":")[0] : undefined) };
    });
    const at = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'scannedAt'").get()?.value;
    return { rows, scannedAt: at };
  } finally {
    db.close();
  }
}

/** Exact identity of a finding, independent of its row id (ids change on every scan). */
function key(r: Row): string {
  if (r.kind === "security") return `security|${r.rule}|${r.file}`;
  if (r.kind === "hotspot") return `hotspot|${r.file}`;
  return `${family(r.kind)}|${sorted(r.ids)}`;
}
// Same members by name, any file: the code moved (a split, a rename of the file).
const nameKey = (r: Row) => `${family(r.kind)}|${sorted(r.ids.map(nameOf))}`;

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  let both = 0;
  for (const x of sa) if (sb.has(x)) both++;
  return both / (sa.size + sb.size - both || 1);
}

/**
 * Compares two atlas scans. A finding in both is "kept"; same members under other files is "moved";
 * a duplicate group whose members mostly overlap (by name, Jaccard >= 0.5) is "changed". The rest is gone or new.
 */
export function diffScans(baseFile: string, headFile: string, opts: { kind?: string; path?: string; limit?: number } = {}) {
  const base = load(baseFile), head = load(headFile);
  // A kind only one scan has (e.g. security imported into the main scan only) is not compared: it would all look new or gone.
  const kinds = (rs: Row[]) => new Set(rs.map((r) => family(r.kind)));
  const kb = kinds(base.rows), kh = kinds(head.rows);
  const skipped = [...new Set([...kb, ...kh])].filter((k) => !(kb.has(k) && kh.has(k))).map((k) => `${k} (only in ${kb.has(k) ? "base" : "head"})`);
  const keep = (r: Row) => kb.has(family(r.kind)) && kh.has(family(r.kind))
    && (!opts.kind || r.kind.startsWith(opts.kind) || family(r.kind) === opts.kind) && (!opts.path || r.file?.startsWith(opts.path));
  const left = base.rows.filter(keep), right = head.rows.filter(keep);
  const goneSet = new Set(left), newSet = new Set(right);
  const matched: { change: Change; base: Row; head: Row }[] = [];

  const pass = (k: (r: Row) => string | undefined, change: Change) => {
    const pool = new Map<string, Row[]>();
    for (const r of goneSet) { const x = k(r); if (x) pool.set(x, [...(pool.get(x) ?? []), r]); }
    for (const r of [...newSet]) {
      const x = k(r);
      const b = x ? pool.get(x)?.pop() : undefined;
      if (!b) continue;
      goneSet.delete(b); newSet.delete(r);
      matched.push({ change, base: b, head: r });
    }
  };
  pass(key, "kept");
  pass((r) => (r.kind === "security" || r.kind === "hotspot" ? undefined : nameKey(r)), "moved");
  // ponytail: greedy O(n*m) over leftover duplicate groups; fine for a few thousand groups.
  for (const r of [...newSet].filter((r) => family(r.kind) === "duplicate")) {
    let best: Row | undefined, score = 0.5;
    for (const b of goneSet) {
      if (family(b.kind) !== "duplicate") continue;
      const s = jaccard(r.ids.map(nameOf), b.ids.map(nameOf));
      if (s >= score) { best = b; score = s; }
    }
    if (best) { goneSet.delete(best); newSet.delete(r); matched.push({ change: "changed", base: best, head: r }); }
  }

  const summary: Record<string, Count> = {};
  const c = (kind: string) => (summary[family(kind)] ??= { base: 0, head: 0, gone: 0, new: 0, kept: 0, moved: 0, changed: 0 });
  for (const r of left) c(r.kind).base++;
  for (const r of right) c(r.kind).head++;
  for (const r of goneSet) c(r.kind).gone++;
  for (const r of newSet) c(r.kind).new++;
  for (const m of matched) c(m.head.kind)[m.change]++;

  const brief = ({ id, kind, score, title, file, line }: Row) => ({ id, kind, score, title, file, line });
  const top = (rs: Row[]) => rs.sort((a, b) => b.score - a.score).slice(0, opts.limit && opts.limit > 0 ? opts.limit : undefined).map(brief);
  return {
    base: { db: baseFile, scannedAt: base.scannedAt },
    head: { db: headFile, scannedAt: head.scannedAt },
    summary,
    skipped,
    new: top([...newSet]),
    gone: top([...goneSet]),
    changed: matched.filter((m) => m.change === "changed").slice(0, opts.limit && opts.limit > 0 ? opts.limit : undefined)
      .map((m) => ({ base: brief(m.base), head: brief(m.head) })),
  };
}
