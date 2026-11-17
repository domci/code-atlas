import ts from "typescript";

export type Fingerprint = {
  /** Same tokens, own name ignored: a plain copy. */
  exact: string;
  /** Names and literals blanked: a copy with renamed parts. */
  shape: string;
  /** MinHash of 5-token shingles over the shape: an edited copy. */
  minhash: Uint32Array;
  tokens: number;
  /** if/for/while/case/catch/?/&&/||/?? count, a cheap complexity number. */
  branches: number;
  /** Body is one forwarded call, e.g. `const f = (a) => g(a)`. */
  wrapper: boolean;
};

const K = ts.SyntaxKind;
const LITERALS = new Set([
  K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.NoSubstitutionTemplateLiteral,
  K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.RegularExpressionLiteral, K.JsxText,
]);
const BRANCHES = new Set([
  K.IfKeyword, K.ForKeyword, K.WhileKeyword, K.CaseKeyword, K.CatchKeyword,
  K.QuestionToken, K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken,
]);
const MINHASH_SIZE = 64;
const SHINGLE = 5;
const hash32 = (s: string) => Number(Bun.hash.xxHash32(s));

/** Mixes a shingle hash with seed i into a new 32-bit hash (murmur3 finalizer). */
function mix(h: number, i: number): number {
  let x = (h ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// ponytail: token scan without a parse, so regex/template edge cases can mis-tokenise.
// Copies mis-tokenise the same way, so duplicate checks still hold. Use the full AST if that changes.
export function fingerprint(code: string, ownName: string): Fingerprint {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, code);
  const raw: string[] = [];
  const shape: string[] = [];
  let branches = 0;
  for (let k = scanner.scan(); k !== K.EndOfFileToken; k = scanner.scan()) {
    const text = scanner.getTokenText();
    const isName = k === K.Identifier || k === K.PrivateIdentifier;
    raw.push(isName && text === ownName ? "SELF" : text);
    shape.push(isName ? "I" : LITERALS.has(k) ? "L" : text);
    if (BRANCHES.has(k)) branches++;
  }

  const minhash = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= shape.length; i++) {
    const h = hash32(shape.slice(i, i + SHINGLE).join(" "));
    for (let j = 0; j < MINHASH_SIZE; j++) {
      const m = mix(h, j);
      if (m < minhash[j]!) minhash[j] = m;
    }
  }

  return {
    exact: Bun.hash(raw.join(" ")).toString(16),
    shape: Bun.hash(shape.join(" ")).toString(16),
    minhash,
    tokens: raw.length,
    branches,
    wrapper: isWrapper(code),
  };
}

export function jaccard(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** LSH buckets: 16 bands of 4 rows. Two bodies share a bucket when they are likely similar. */
export function bands(m: Uint32Array): string[] {
  const out: string[] = [];
  for (let b = 0; b < 16; b++) out.push(`${b}:${m.slice(b * 4, b * 4 + 4).join(",")}`);
  return out;
}

/** True when the function only forwards its own parameters to one other call. */
export function isWrapper(code: string): boolean {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  let fn: ts.SignatureDeclaration & { body?: ts.ConciseBody } | undefined;
  const visit = (n: ts.Node) => {
    if (fn) return;
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) fn = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!fn?.body || fn.parameters.length === 0) return false;
  let expr: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const [only] = fn.body.statements;
    if (fn.body.statements.length !== 1 || !only) return false;
    if (ts.isReturnStatement(only)) expr = only.expression;
    else if (ts.isExpressionStatement(only)) expr = only.expression;
  } else expr = fn.body;
  if (expr && ts.isAwaitExpression(expr)) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  const params = fn.parameters.map((p) => p.name.getText(sf));
  const args = expr.arguments.map((a) => a.getText(sf));
  return args.length === params.length && args.every((a, i) => a === params[i]);
}
