// Runs as its own process: onnxruntime and LadybugDB crash when loaded into one Bun process.
// Usage: bun src/embed.ts <atlas.db> — embeds every row of embed_queue into vectors.
import { Database } from "bun:sqlite";
import { env, pipeline } from "@huggingface/transformers";

/** Best local model in a 2026 code-duplicate benchmark; runs on CPU, no code leaves the machine. */
export const MODEL = "jinaai/jina-embeddings-v2-base-code";
const MAX_CHARS = 1500; // ponytail: long bodies are cut; their head carries most of the meaning.
const BATCH = 16;

if (import.meta.main) {
  env.cacheDir = `${process.env.HOME}/.cache/code-atlas/models`;
  const db = new Database(process.argv[2]!);
  // Sorted by length so each batch pads to similar sizes; mixing names with bodies wastes most of the work.
  const todo = db.query<{ key: string; text: string }, [number]>(
    "SELECT key, substr(text, 1, ?) AS text FROM embed_queue ORDER BY length(text)",
  ).all(MAX_CHARS);
  const put = db.prepare("INSERT OR REPLACE INTO vectors VALUES (?, ?)");
  const fe = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const t = await fe(batch.map((b) => b.text), { pooling: "mean", normalize: true });
    const dim = t.dims[1]!;
    const data = t.data as Float32Array;
    db.transaction(() => batch.forEach((b, j) => put.run(b.key, new Uint8Array(data.slice(j * dim, (j + 1) * dim).buffer))))();
    if ((i / BATCH) % 30 === 0 || i + BATCH >= todo.length) {
      process.stderr.write(`embeddings: ${Math.min(i + BATCH, todo.length)}/${todo.length} new\n`);
    }
  }
  db.exec("DELETE FROM embed_queue");
}
