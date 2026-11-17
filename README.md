# code-atlas

Finds duplicates, unused code, hotspots and other technical debt in a TypeScript or
JavaScript repository. It is made for coding agents: every command prints JSON.

It builds on [GitNexus](https://github.com/abhigyanpatwari/GitNexus). GitNexus maps
where each code object is defined, imported and called. code-atlas adds the analysis
GitNexus does not do. Use both: GitNexus for "who calls X" and "what breaks if I change X",
code-atlas for "what should we clean up".

Everything runs locally. The code model downloads once from Hugging Face; no code leaves the machine.
Embedding runs in a child process: onnxruntime and the GitNexus database library crash when loaded together.

## Setup

```sh
bun install
bun link            # puts `atlas` on PATH
```

In the target repository:

```sh
gitnexus analyze --skip-agents-md   # or the repo's own GitNexus command
atlas scan                          # first run embeds all code (minutes); later runs reuse the cache
```

## Security and knip reports

code-atlas does not run these tools itself; it imports their reports and ties each finding
to the code object it sits in.

```sh
# Opengrep (free Semgrep fork with cross-function taint): https://github.com/opengrep/opengrep
git clone --depth 1 https://github.com/opengrep/opengrep-rules ~/.cache/code-atlas/opengrep-rules
opengrep scan --sarif-output=/tmp/og.sarif \
  --config ~/.cache/code-atlas/opengrep-rules/typescript --config ~/.cache/code-atlas/opengrep-rules/javascript .
atlas import sarif /tmp/og.sarif

# knip, run inside one package
(cd apps/x && bunx knip --reporter json > /tmp/knip.json); atlas import knip /tmp/knip.json --base apps/x
```

Any SARIF file works (Semgrep, CodeQL, ESLint SARIF formatter).

## Commands

| Command | Answer |
| --- | --- |
| `atlas debt [--kind k] [--path p] [--min n] [--limit n]` | Ranked findings, highest score first |
| `atlas show <id>` | One finding with all members and numbers |
| `atlas symbol <name>` | Where a name is defined, its numbers and findings |
| `atlas similar <name>` | Code that means the same, by embedding |
| `atlas import sarif <file>` | Security findings from Opengrep/Semgrep |
| `atlas import knip <file> --base apps/x` | Unused files, exports and dependencies from knip |
| `atlas sql "<select>"` | Anything else, read-only |

## Finding kinds

- `duplicate-exact`: the same code under another name.
- `duplicate-renamed`: the same code with renamed variables or other literals.
- `duplicate-edited`: a copy with small edits (≥ 80% of 5-token runs shared).
- `duplicate-meaning`: different code, same meaning (code embedding cosine ≥ 0.95, or ≥ 0.88 with names that mean the same).
- `unused`: no calls, imports or other uses in the graph. Framework entry files are skipped. Exported ones may still be used by other packages; confirm with knip or `gitnexus impact`.
- `hotspot`: complex code that changed often in the last 180 days and that much depends on.
- `wrapper`: a function that only forwards its parameters to another call.
- `security`, `knip-*`: imported reports.

## Tables for `atlas sql`

- `symbols(id, kind, name, file, start_line, end_line, lines, exported, test, community, community_label, fan_in, fan_out, churn, branches, tokens, code_key)` — lines count from 1.
- `edges(src, dst, type)` — use edges from GitNexus: CALLS, IMPORTS, ACCESSES, EXTENDS, …
- `pairs(a, b, kind, score)` — every duplicate pair.
- `findings(id, source, kind, score, title, file, line, ids, detail)` — `ids` and `detail` are JSON.

The database lives in `~/.cache/code-atlas/`, one file per repository.

## Agent workflow

1. `atlas debt --limit 20` for the worst items, or `--path apps/x/` for one area.
2. `atlas show <id>` and read the code.
3. Before changing a shared object: `gitnexus impact <name>`.
4. Fix one finding, run the repo's tests, then `atlas scan` again.
