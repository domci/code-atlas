import { env, pipeline } from "@huggingface/transformers";

/** Best local model in a 2026 code-duplicate benchmark; runs on CPU, no code leaves the machine. */
export const MODEL = "jinaai/jina-embeddings-v2-base-code";
const MAX_CHARS = 2000; // ponytail: long bodies are cut; their head carries most of the meaning.
const BATCH = 16;

env.cacheDir = `${process.env.HOME}/.cache/code-atlas/models`;

/** "formatPriceLabel" → "format price label", so names compare by meaning, not spelling. */
export const nameText = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$-]+/g, " ").toLowerCase().trim();

/**
 * Embeds each text once. `cached` returns a stored vector by key; `save` stores new ones.
 * Vectors are unit length, so cosine similarity is a dot product.
 */
export async function embedAll(
  items: { key: string; text: string }[],
  cached: (key: string) => Float32Array | undefined,
  save: (key: string, v: Float32Array) => void,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const todo = new Map<string, string>();
  for (const it of items) {
    const hit = out.get(it.key) ?? cached(it.key);
    if (hit) out.set(it.key, hit);
    else todo.set(it.key, it.text);
  }
  const list = [...todo].map(([key, text]) => ({ key, text }));
  if (list.length === 0) return out;
  const fe = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const t = await fe(batch.map((b) => b.text.slice(0, MAX_CHARS)), { pooling: "mean", normalize: true });
    const dim = t.dims[1]!;
    const data = t.data as Float32Array;
    batch.forEach((b, j) => {
      const v = data.slice(j * dim, (j + 1) * dim);
      out.set(b.key, v);
      save(b.key, v);
    });
    onProgress(Math.min(i + BATCH, list.length), list.length);
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
