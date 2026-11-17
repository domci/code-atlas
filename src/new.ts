import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { LIMITS, testFile } from "./analyze";
import { fingerprint } from "./fingerprint";

const SOURCE = /\.[cm]?[jt]sx?$/;
const MAX_FILES = 30;

type Hit = { file: string; line: number; name: string; kind: "exact" | "renamed"; of: string; ofFile: string; ofLine: number };

/** Top-level declarations, cut like GitNexus ranges them (the `export` prefix is part of the code). */
function declarations(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : undefined);
  const out: { name: string; line: number; code: string }[] = [];
  for (const st of sf.statements) {
    const name = ts.isVariableStatement(st) ? st.declarationList.declarations[0]?.name.getText()
      : ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) ? st.name?.text : undefined;
    if (!name) continue;
    const code = st.getText(sf);
    if (code.split("\n").length >= 3) out.push({ name, line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1, code });
  }
  return out;
}

/**
 * New plain copies (exact or renamed) in files changed since HEAD (plus untracked) of code the last scan already holds.
 * Edited/semantic copies and unused exports are the nightly report's job. Empty when there is no scan.
 */
export async function newCopies(top: string, dbFile: string): Promise<Hit[]> {
  if (!existsSync(dbFile)) return [];
  const db = new Database(dbFile, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM pragma_table_info('symbols') WHERE name = 'fp_exact'").get()) return []; // scan predates `atlas new`
    const sh = async (...a: string[]) => (await Bun.$`git -C ${top} ${a}`.quiet().nothrow().text()).split("\n");
    const files = [...new Set([...(await sh("diff", "HEAD", "--name-only", "--diff-filter=AM")), ...(await sh("ls-files", "--others", "--exclude-standard"))])]
      .filter((f) => SOURCE.test(f) && !testFile(f)).slice(0, MAX_FILES);
    const find = db.query<{ name: string; file: string; start_line: number; fp_exact: string }, { $t: number; $e: string; $s: string }>(
      `SELECT name, file, start_line, fp_exact FROM symbols
       WHERE test = 0 AND tokens >= $t AND (fp_exact = $e OR (fp_shape = $s AND fp_data = 0)) LIMIT 50`,
    );
    const hits: Hit[] = [];
    for (const file of files) {
      const text = await Bun.file(join(top, file)).text().catch(() => "");
      for (const d of declarations(file, text)) {
        const fp = fingerprint(d.code, d.name);
        if (fp.tokens < LIMITS.dupMinTokens) continue;
        const same = find.all({ $t: LIMITS.dupMinTokens, $e: fp.exact, $s: fp.shape });
        // Already in the scan at this place: not new (even if it is a copy, the nightly report lists it).
        if (same.some((s) => s.file === file && s.name === d.name)) continue;
        const o = same.find((s) => s.fp_exact === fp.exact) ?? same[0];
        if (o) hits.push({ file, line: d.line, name: d.name, kind: o.fp_exact === fp.exact ? "exact" : "renamed", of: o.name, ofFile: o.file, ofLine: o.start_line });
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

export const formatHits = (hits: Hit[]) => hits.length === 0 ? "" :
  `atlas: ${hits.length} new ${hits.length === 1 ? "copy" : "copies"} of code already in the repo. Reuse the original, or ignore with a reason.\n` +
  hits.slice(0, 5).map((h) => `  ${h.file}:${h.line} ${h.name}: ${h.kind} copy of ${h.of} (${h.ofFile}:${h.ofLine})`).join("\n") + "\n";
