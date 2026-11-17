#!/usr/bin/env bun
// Stop hook for Claude Code and Codex: runs `atlas new` once per turn and, when it finds new copies,
// blocks the stop with the findings as the reason. The agent may ignore them with a reason.
// Silent (exit 0) on no findings, no scan, a second stop in the same turn, or any error.
try {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  if (!input.stop_hook_active) {
    const out = await Bun.$`bun ${import.meta.dir}/../src/cli.ts new`.cwd(input.cwd ?? process.cwd()).quiet().nothrow().text();
    if (out.trim()) console.log(JSON.stringify({ decision: "block", reason: `${out.trim()}\nIf the copy is intended, say why in one line and stop.` }));
  }
} catch {}
