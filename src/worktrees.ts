// src/worktrees.ts — worktree registry (bot side) + `create` helper (agent side).
//
// Dev runs never edit a repo checkout. The agent asks for a worktree:
//
//   node dist/worktrees.js create <repo-name> [--base <ref>]
//
// which validates the name against config.repos (an agent cannot point this at
// an arbitrary path), branches off that repo's base into
// <workspaceDir>/worktrees/<repo>-<runId8>, registers it, and prints the path.
//
// The bot side owns the lifecycle: markRunEnded() removes the worktree when the
// run succeeded and keeps it (marked failed) when it did not, so a broken run
// can still be inspected; sweep() runs at startup and hourly to collect
// anything TTL-expired, prune stale git metadata, and delete orphan directories.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { type Config, ROOT, loadConfig } from "./config";
import { log } from "./log";

export interface WorktreeEntry {
  repo: string;
  repoPath: string;
  path: string;
  branch: string;
  runId: string;
  createdAt: string;
  status: string;
}

export type Registry = Record<string, WorktreeEntry>;

export const STATE_FILE = process.env.ATDEV_WORKTREE_FILE || path.join(ROOT, "state", "worktrees.json");

// ponytail: plain read-modify-write, last writer wins. The contention window is
// milliseconds (one create + one markRunEnded per run) and sweep() collects any
// entry a lost write leaks. Add a lock only if that stops being true.
export function load(): Registry {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(reg: Registry) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(reg, null, 2));
}

function git(cwd: string, ...args: string[]): string {
  try {
    return String(execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
  } catch (e: any) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(e.stderr || e.message).trim()}`);
  }
}

function exists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

// Best-effort removal: git first, then the directory itself (Windows holds
// handles open long enough to need retries), then prune the repo's metadata.
export function remove(entry: WorktreeEntry) {
  try {
    git(entry.repoPath, "worktree", "remove", "--force", entry.path);
  } catch (e: any) {
    log(`Worktree remove fell back to rm for ${entry.path}: ${e.message}`);
  }
  try {
    fs.rmSync(entry.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    git(entry.repoPath, "worktree", "prune");
  } catch (e: any) {
    log(`Worktree cleanup left residue at ${entry.path}: ${e.message}`);
  }
}

// Success removes the run's worktrees; failure keeps them for inspection.
// A run with no worktrees (every chat run) is a no-op.
export function markRunEnded(runId: string, ok: boolean) {
  const reg = load();
  let dirty = false;
  for (const [id, entry] of Object.entries(reg)) {
    if (entry.runId !== runId) continue;
    dirty = true;
    if (ok) {
      remove(entry);
      delete reg[id];
      log(`Removed worktree ${id} (${entry.path})`);
    } else {
      entry.status = "failed";
      log(`Kept failed worktree ${id} (${entry.path}) for inspection`);
    }
  }
  if (dirty) save(reg);
}

// Startup + hourly: TTL-expired entries go regardless of status, every repo gets
// pruned, and any directory under workspace/worktrees/ we no longer track is
// deleted (a crash between `git worktree add` and the registry write leaks one).
export function sweep(config: Pick<Config, "workspaceDir" | "worktreeTtlHours" | "repos">) {
  const reg = load();
  const cutoff = Date.now() - config.worktreeTtlHours * 60 * 60 * 1000;
  let dirty = false;
  for (const [id, entry] of Object.entries(reg)) {
    if (Date.parse(entry.createdAt) > cutoff) continue;
    log(`Sweeping expired worktree ${id} (${entry.status})`);
    remove(entry);
    delete reg[id];
    dirty = true;
  }
  if (dirty) save(reg);

  for (const [name, repo] of Object.entries(config.repos)) {
    try {
      git(repo.path, "worktree", "prune");
    } catch (e: any) {
      log(`Prune failed for ${name}: ${e.message}`);
    }
  }

  const rm = (full: string) => {
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (e: any) {
      log(`Delete failed for ${full}: ${e.message}`);
    }
  };
  const readdirSafe = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return []; // nothing created yet
    }
  };

  const root = path.join(config.workspaceDir, "worktrees");
  const known = new Set(Object.values(reg).map((e) => path.resolve(e.path)));
  for (const d of readdirSafe(root)) {
    const full = path.join(root, d.name);
    if (known.has(path.resolve(full))) continue;
    log(`Deleting orphan worktree directory ${full}`);
    rm(full);
  }

  // Attachment dirs have no registry — a failed run's files are kept for
  // inspection, and age out here on the same TTL, judged by mtime.
  const attRoot = path.join(config.workspaceDir, "attachments");
  for (const d of readdirSafe(attRoot)) {
    const full = path.join(attRoot, d.name);
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    log(`Sweeping expired attachments ${full}`);
    rm(full);
  }
}

// Agent-facing. Throws (→ nonzero exit + stderr) on anything unusable.
export function create(
  repoName: string,
  base?: string | null,
  config: Pick<Config, "workspaceDir" | "repos"> = loadConfig(),
): string {
  const repo = config.repos[repoName];
  if (!repo) throw new Error(`unknown repo "${repoName}" — available: ${Object.keys(config.repos).join(", ")}`);
  const runId = process.env.ATDEV_RUN_ID;
  if (!runId) throw new Error("ATDEV_RUN_ID is not set — this helper only runs inside a bot run");

  const id8 = runId.slice(0, 8);
  const wtId = `${repoName}-${id8}`;
  const wtPath = path.join(config.workspaceDir, "worktrees", wtId).replaceAll("\\", "/");
  const branch = `atdev/${id8}`;

  git(repo.path, "fetch", "origin", "-q");
  // A follow-up to a finished run finds its branch still there (only the
  // worktree was removed) — check it back out instead of failing on -b.
  const reuse = exists(repo.path, branch);
  git(repo.path, "worktree", "add", ...(reuse ? [wtPath, branch] : ["-b", branch, wtPath, base || repo.base]));

  const reg = load();
  reg[wtId] = {
    repo: repoName,
    repoPath: repo.path,
    path: wtPath,
    branch,
    runId,
    createdAt: new Date().toISOString(),
    status: "active",
  };
  save(reg);
  log(`Created worktree ${wtId} on ${branch} off ${base || repo.base}`);
  return wtPath;
}

if (require.main === module) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== "create" || !name) throw new Error("usage: node dist/worktrees.js create <repo-name> [--base <ref>]");
    const i = rest.indexOf("--base");
    console.log(create(name, i >= 0 ? rest[i + 1] : null)); // last stdout line is the path, by contract
  } catch (e: any) {
    console.error(`worktree helper: ${e.message}`);
    process.exit(1);
  }
}
