// OpenCode plugin, the counterpart of stop.ts: when a root session goes idle, runs `atlas new` and,
// when it finds new copies, sends them back to the session as a prompt. One nudge per turn: the idle
// after the agent's answer is skipped. Silent on no findings, child sessions or any error.
// Install: ln -s ~/repos/code-atlas/hooks/opencode.js ~/.config/opencode/plugins/code-atlas.js
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const cli = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "src", "cli.ts");
const nudged = new Set();
const seen = new Map(); // session.idle and session.status both report one idle

const atlasNew = (cwd) =>
  new Promise((done) =>
    execFile("bun", [cli, "new"], { cwd, timeout: 10_000 }, (err, out) => done(err ? "" : out.trim())),
  );

// OpenCode 1.x and 2.x SDKs take different argument shapes.
async function call(fn, v2, v1) {
  if (typeof fn !== "function") return undefined;
  const r = await fn(...v2).catch(() => undefined);
  return r && !r.error ? r : fn(...v1);
}

export const CodeAtlasPlugin = async ({ client, directory }) => ({
  event: async ({ event }) => {
    try {
      const idle = event?.type === "session.idle" || (event?.type === "session.status" && event.properties?.status?.type === "idle");
      const id = event?.properties?.sessionID;
      if (!idle || !id || Date.now() - (seen.get(id) ?? 0) < 3000) return;
      seen.set(id, Date.now());
      if (nudged.delete(id)) return;
      const s = client.session;
      const info = await call(s.get?.bind(s), [{ sessionID: id }], [{ path: { id } }]);
      if (info?.data?.parentID) return;
      const out = await atlasNew(info?.data?.directory ?? directory);
      if (!out) return;
      nudged.add(id);
      const text = `${out}\nIf the copy is intended, say why in one line and stop.`;
      const send = (s.promptAsync ?? s.prompt)?.bind(s);
      await call(send, [{ sessionID: id, parts: [{ type: "text", text }] }], [{ path: { id }, body: { parts: [{ type: "text", text }] } }]);
    } catch {}
  },
});
