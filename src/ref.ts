import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { scan } from "./scan";
import { dbPath, open } from "./store";

const safe = (ref: string) => ref.replace(/[^\w.-]+/g, "-");

/** Where a ref scan checks the ref out for the scan. ATLAS_WORKTREES moves the folder (default ~/worktrees). */
const refDir = (repoName: string, ref: string) =>
  join(process.env.ATLAS_WORKTREES ?? join(homedir(), "worktrees"), `atlas-${repoName}-${safe(ref)}`, repoName);

/** The scan of `ref`, stored next to the main scan as `<repo>@<ref>` (independent of ATLAS_WORKTREES). */
export const refDb = (repo: string, ref: string) => dbPath(`${repo}@${safe(ref)}`);

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
    // VACUUM INTO copies a consistent snapshot even while the scan's own handle keeps the WAL database open.
    rmSync(refDb(repo, ref), { force: true });
    out.run("VACUUM INTO ?", [refDb(repo, ref)]);
    out.close();
    for (const x of ["", "-wal", "-shm"]) rmSync(dbPath(dir) + x, { force: true });
    return { ref, sha, db: refDb(repo, ref), ...result };
  } finally {
    await Bun.$`gitnexus clean --force`.cwd(dir).quiet().nothrow();
    await Bun.$`git -C ${top} worktree remove --force ${dir}`.quiet().nothrow();
    rmSync(dirname(dir), { recursive: true, force: true });
    await Bun.$`git -C ${top} worktree prune`.quiet().nothrow();
  }
}
