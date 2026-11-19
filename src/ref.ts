import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { scan } from "./scan";
import { dbPath, open } from "./store";

/**
 * Where a ref scan checks the ref out. Fixed per repo and ref, so its database (keyed by path) can be found again.
 * ATLAS_WORKTREES moves the folder (default ~/worktrees).
 */
export function refDir(repoName: string, ref: string): string {
  const root = process.env.ATLAS_WORKTREES ?? join(homedir(), "worktrees");
  return join(root, `atlas-${repoName}-${ref.replace(/[^\w.-]+/g, "-")}`, repoName);
}

/**
 * Scans a branch, tag or commit without touching the current checkout: a detached worktree, its own GitNexus index
 * (registered under `<repo>@<ref>`, so `-r <repo>` still means the main checkout), the scan, then both are removed.
 * The atlas database stays. Vectors are seeded from the main scan so only changed code is embedded again.
 */
export async function scanRef(top: string, repo: string, ref: string, opts: { embed: boolean }) {
  const sha = (await Bun.$`git -C ${top} rev-parse --verify ${`${ref}^{commit}`}`.quiet().text()).trim();
  const name = basename(repo);
  const dir = refDir(name, ref);
  const log = (msg: string) => process.stderr.write(`[ref ${ref}] ${msg}\n`);
  if (existsSync(dir)) await Bun.$`git -C ${top} worktree remove --force ${dir}`.quiet().nothrow(); // left over by a crash
  await Bun.$`git -C ${top} worktree add --detach ${dir} ${sha}`.quiet();
  try {
    log(`worktree ${dir} at ${sha.slice(0, 10)}; gitnexus analyze`);
    await Bun.$`gitnexus analyze --index-only --name ${`${name}@${ref}`} ${dir}`.cwd(dir).quiet();
    const db = open(dir);
    if (existsSync(dbPath(repo)) && dbPath(repo) !== dbPath(dir)) {
      db.exec(`ATTACH ${`'${dbPath(repo).replaceAll("'", "''")}'`} AS main_scan;
        INSERT OR IGNORE INTO vectors SELECT * FROM main_scan.vectors; DETACH main_scan;`);
    }
    db.close();
    const result = await scan(dir, opts);
    const out = new Database(dbPath(dir));
    out.run("INSERT OR REPLACE INTO meta VALUES ('ref', ?), ('sha', ?)", [ref, sha]);
    out.close();
    return { ref, sha, db: dbPath(dir), ...result };
  } finally {
    await Bun.$`gitnexus clean --force`.cwd(dir).quiet().nothrow();
    await Bun.$`git -C ${top} worktree remove --force ${dir}`.quiet().nothrow();
    rmSync(dirname(dir), { recursive: true, force: true });
    await Bun.$`git -C ${top} worktree prune`.quiet().nothrow();
  }
}
