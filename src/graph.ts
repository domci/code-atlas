import lbug from "@ladybugdb/core";
import { join } from "node:path";

export type Sym = {
  id: string;
  kind: string;
  name: string;
  file: string;
  start: number;
  end: number;
  exported: boolean;
  community: string | null;
  communityLabel: string | null;
};
export type Edge = { src: string; dst: string; type: string };

/** Code object tables GitNexus fills for TypeScript and JavaScript. */
const SYMBOL_TABLES = [
  "Function", "Method", "Class", "Interface", "TypeAlias", "Enum",
  "Const", "Variable", "Property", "Constructor", "CodeElement",
];
/** Edge types that mean "uses". CONTAINS/DEFINES/MEMBER_OF are structure, not use. */
export const USE_EDGES = [
  "CALLS", "IMPORTS", "ACCESSES", "EXTENDS", "IMPLEMENTS",
  "METHOD_OVERRIDES", "METHOD_IMPLEMENTS", "HANDLES_ROUTE", "HANDLES_TOOL",
  "ENTRY_POINT_OF", "WRAPS", "FETCHES", "QUERIES", "INJECTS",
];

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);

/** Reads symbols, use edges and communities from the GitNexus index of `repo`, read-only. */
export async function loadGraph(repo: string): Promise<{ symbols: Sym[]; edges: Edge[] }> {
  const db = new lbug.Database(join(repo, ".gitnexus", "lbug"), 0, false, true);
  const conn = new lbug.Connection(db);
  const all = async (q: string): Promise<Row[]> => {
    const res = await conn.query(q);
    const one = Array.isArray(res) ? res[0] : res;
    if (!one) return [];
    const rows = (await one.getAll()) as Row[];
    one.close();
    return rows;
  };
  try {
    const tables = new Set((await all("CALL show_tables() RETURN name")).map((r) => str(r.name)));
    const symbols: Sym[] = [];
    for (const t of SYMBOL_TABLES.filter((t) => tables.has(t))) {
      const exported = ["Function", "Class", "Interface", "Method", "CodeElement"].includes(t) ? "n.isExported" : "false";
      const rows = await all(
        `MATCH (n:\`${t}\`) RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS s, n.endLine AS e, ${exported} AS x`,
      );
      for (const r of rows) {
        symbols.push({
          id: str(r.id), kind: t, name: str(r.name), file: str(r.file),
          // GitNexus lines are 0-based; editors and reports count from 1.
          start: num(r.s) + 1, end: num(r.e) + 1, exported: r.x === true, community: null, communityLabel: null,
        });
      }
    }
    const byId = new Map(symbols.map((s) => [s.id, s]));
    for (const r of await all(
      "MATCH (n)-[r:CodeRelation]->(c:Community) WHERE r.type = 'MEMBER_OF' RETURN n.id AS id, c.id AS c, c.heuristicLabel AS l",
    )) {
      const s = byId.get(str(r.id));
      if (s) { s.community = str(r.c); s.communityLabel = str(r.l) || null; }
    }
    const types = USE_EDGES.map((t) => `'${t}'`).join(",");
    const edges = (await all(
      `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${types}] RETURN a.id AS a, b.id AS b, r.type AS t`,
    )).map((r) => ({ src: str(r.a), dst: str(r.b), type: str(r.t) }));
    return { symbols, edges };
  } finally {
    await conn.close();
    await db.close();
  }
}
