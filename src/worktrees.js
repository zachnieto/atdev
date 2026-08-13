// src/worktrees.js — worktree registry (bot side) + `create` helper (agent side).
//
// Dev runs never edit a repo checkout. The agent asks for a worktree:
//
//   node src/worktrees.js create <repo-name> [--base <ref>]
//
// which validates the name against config.repos (an agent cannot point this at
// an arbitrary path), branches off that repo's base into
// <workspaceDir>/worktrees/<repo>-<runId8>, registers it, and prints the path.
//
// The bot side owns the lifecycle: markRunEnded() removes the worktree when the
// run succeeded and keeps it (marked failed) when it did not, so a broken run
// can still be inspected; sweep() runs at startup and hourly to collect
// anything TTL-expired, prune stale git metadata, and delete orphan directories.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, loadConfig } = require("./config");
const { log } = require("./log");

const STATE_FILE = process.env.NEATZ_WORKTREE_FILE || path.join(ROOT, "state", "worktrees.json");

// ponytail: plain read-modify-write, last writer wins. The contention window is
// milliseconds (one create + one markRunEnded per run) and sweep() collects any
// entry a lost write leaks. Add a lock only if that stops being true.
function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(reg) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(reg, null, 2));
}

function git(cwd, ...args) {
  try {
    return String(execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(e.stderr || e.message).trim()}`);
  }
}

function exists(repoPath, ref) {
  try {
    git(repoPath, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

// Best-effort removal: git first, then the directory itself (Windows holds
// handles open long enough to need retries), then prune the repo's metadata.
function remove(entry) {
  try {
    git(entry.repoPath, "worktree", "remove", "--force", entry.path);
  } catch (e) {
    log(`Worktree remove fell back to rm for ${entry.path}: ${e.message}`);
  }
  try {
    fs.rmSync(entry.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    git(entry.repoPath, "worktree", "prune");
  } catch (e) {
    log(`Worktree cleanup left residue at ${entry.path}: ${e.message}`);
  }
}

// Success removes the run's worktrees; failure keeps them for inspection.
// A run with no worktrees (every chat run) is a no-op.
function markRunEnded(runId, ok) {
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
function sweep(config) {
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
    } catch (e) {
      log(`Prune failed for ${name}: ${e.message}`);
    }
  }

  const root = path.join(config.workspaceDir, "worktrees");
  const known = new Set(Object.values(reg).map((e) => path.resolve(e.path)));
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // nothing created yet
  }
  for (const d of dirs) {
    const full = path.join(root, d.name);
    if (known.has(path.resolve(full))) continue;
    log(`Deleting orphan worktree directory ${full}`);
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (e) {
      log(`Orphan delete failed for ${full}: ${e.message}`);
    }
  }
}

// Agent-facing. Throws (→ nonzero exit + stderr) on anything unusable.
function create(repoName, base, config = loadConfig()) {
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
    if (cmd !== "create" || !name) throw new Error("usage: node src/worktrees.js create <repo-name> [--base <ref>]");
    const i = rest.indexOf("--base");
    console.log(create(name, i >= 0 ? rest[i + 1] : null)); // last stdout line is the path, by contract
  } catch (e) {
    console.error(`worktree helper: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { create, markRunEnded, sweep, load, remove, STATE_FILE };
