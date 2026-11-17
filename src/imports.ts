import type { Database } from "bun:sqlite";
import { join, relative } from "node:path";

type Hit = { kind: string; score: number; title: string; file: string; line: number | null; detail: unknown };

const SARIF_SCORE: Record<string, number> = { error: 85, warning: 65, note: 35, none: 20 };
const KNIP_SCORE: Record<string, number> = { files: 60, dependencies: 50, devDependencies: 40, unlisted: 50, unresolved: 50, exports: 40, types: 30, nsExports: 30, nsTypes: 25, enumMembers: 25, duplicates: 35, cycles: 45 };

type Sarif = { runs?: { tool?: { driver?: { name?: string } }; results?: {
  ruleId?: string; level?: string; message?: { text?: string };
  locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[];
}[] }[] };
type Knip = { issues?: ({ file: string } & Record<string, unknown>)[] };

/**
 * Replaces earlier findings of the same source with this report.
 * `base` is the folder the tool ran in, relative to the repo, for tools that print paths relative to it.
 */
export function importReport(db: Database, repo: string, kind: "sarif" | "knip", report: unknown, base = "") {
  const hits = kind === "sarif" ? fromSarif(report as Sarif, repo) : fromKnip(report as Knip, base);
  const source = kind === "sarif" ? "sarif" : `knip:${base}`;
  const owner = db.prepare<{ id: string }, [string, number, number]>(
    "SELECT id FROM symbols WHERE file = ? AND start_line <= ? AND end_line >= ? ORDER BY lines LIMIT 1",
  );
  const insert = db.prepare("INSERT INTO findings (source, kind, score, title, file, line, ids, detail) VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    db.prepare("DELETE FROM findings WHERE source = ?").run(source);
    for (const h of hits) {
      // Reports use 1-based lines; GitNexus symbols are 0-based.
      const sym = h.line ? owner.get(h.file, h.line - 1, h.line - 1) : null;
      insert.run(source, h.kind, h.score, h.title, h.file, h.line, JSON.stringify(sym ? [sym.id] : []), JSON.stringify(h.detail));
    }
  })();
  return { source, imported: hits.length };
}

function fromSarif(r: Sarif, repo: string): Hit[] {
  return (r.runs ?? []).flatMap((run) => (run.results ?? []).map((x) => {
    const loc = x.locations?.[0]?.physicalLocation;
    const uri = (loc?.artifactLocation?.uri ?? "").replace(/^file:\/\//, "");
    const file = uri.startsWith("/") ? relative(repo, uri) : uri;
    return {
      kind: "security",
      score: SARIF_SCORE[x.level ?? "warning"] ?? 50,
      title: `${x.ruleId ?? "rule"}: ${(x.message?.text ?? "").split("\n")[0]}`,
      file,
      line: loc?.region?.startLine ?? null,
      detail: { tool: run.tool?.driver?.name, ruleId: x.ruleId, level: x.level, message: x.message?.text },
    };
  }));
}

function fromKnip(r: Knip, base: string): Hit[] {
  return (r.issues ?? []).flatMap((row) => Object.entries(row).flatMap(([type, items]) => {
    if (!Array.isArray(items) || !(type in KNIP_SCORE)) return [];
    return (items.flat() as { name?: string; line?: number }[]).map((it) => ({
      kind: `knip-${type}`,
      score: KNIP_SCORE[type]!,
      title: type === "files" ? `Unused file ${row.file}` : `Unused ${type}: ${it.name ?? "?"}`,
      file: join(base, row.file),
      line: it.line ?? null,
      detail: { type, ...it },
    }));
  }));
}
