import { TMP } from "./helpers";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { ROOT } from "../dist/config";
import * as worktrees from "../dist/worktrees";

const HOUR = 60 * 60 * 1000;
const RUN_ID = "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb";

// A throwaway origin + clone in tmp: the lifecycle is all real git, because the
// parts that break (worktree add/remove/prune on Windows) are git's, not ours.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const origin = path.join(TMP, "origin");
const repoPath = path.join(TMP, "repo");
fs.mkdirSync(origin, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", origin], { stdio: "ignore" });
fs.writeFileSync(path.join(origin, "README.md"), "hi\n");
git(origin, "add", "-A");
git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
execFileSync("git", ["clone", "-q", "--no-hardlinks", origin, repoPath], { stdio: "ignore" });

const cfg = {
  workspaceDir: path.join(TMP, "ws"),
  worktreeTtlHours: 24,
  repos: { tmp: { path: repoPath, base: "origin/main" } },
};
const wtRoot = path.join(cfg.workspaceDir, "worktrees");
const listed = () => git(repoPath, "worktree", "list").trim().split("\n").length;
const baseline = listed();

process.env.ATDEV_RUN_ID = RUN_ID;
after(() => {
  delete process.env.ATDEV_RUN_ID;
});

test("create validates the repo name and the run id before touching git", () => {
  assert.throws(() => worktrees.create("../../etc", null, cfg), /unknown repo/, "arbitrary paths must be rejected");
  delete process.env.ATDEV_RUN_ID;
  assert.throws(() => worktrees.create("tmp", null, cfg), /ATDEV_RUN_ID/, "missing run id must be rejected");
  process.env.ATDEV_RUN_ID = RUN_ID;
});

test("create branches off the repo's base and registers the worktree", () => {
  const p1 = worktrees.create("tmp", null, cfg);
  assert.equal(p1, path.join(wtRoot, "tmp-abcdef12").replaceAll("\\", "/"), "printed path");
  assert.ok(fs.existsSync(path.join(p1, "README.md")), "worktree not checked out");
  assert.equal(git(p1, "rev-parse", "--abbrev-ref", "HEAD").trim(), "atdev/abcdef12");
  assert.equal(listed(), baseline + 1);
  assert.equal(worktrees.load()["tmp-abcdef12"].status, "active");
  assert.equal(worktrees.load()["tmp-abcdef12"].runId, RUN_ID);
});

test("a failed run keeps its worktree, a successful one removes it", () => {
  const p1 = path.join(wtRoot, "tmp-abcdef12");
  worktrees.markRunEnded(RUN_ID, false);
  assert.equal(worktrees.load()["tmp-abcdef12"].status, "failed");
  assert.ok(fs.existsSync(p1), "failed run's worktree was removed");

  worktrees.markRunEnded(RUN_ID, true);
  assert.deepEqual(worktrees.load(), {}, "registry entry survived removal");
  assert.ok(!fs.existsSync(p1), "worktree directory survived removal");
  assert.equal(listed(), baseline, "git still lists the removed worktree");

  worktrees.markRunEnded("no-such-run", true); // a chat run makes no worktrees
  assert.deepEqual(worktrees.load(), {});
});

test("the branch outlives the worktree, so a follow-up checks it back out", () => {
  const p2 = worktrees.create("tmp", null, cfg);
  assert.equal(p2, path.join(wtRoot, "tmp-abcdef12").replaceAll("\\", "/"));
  assert.equal(git(p2, "rev-parse", "--abbrev-ref", "HEAD").trim(), "atdev/abcdef12");
});

test("sweep collects expired entries and aged orphans, and spares live/fresh ones", () => {
  const reg = worktrees.load();
  reg["tmp-abcdef12"].createdAt = new Date(Date.now() - 48 * HOUR).toISOString();
  fs.writeFileSync(worktrees.STATE_FILE, JSON.stringify(reg));
  // An aged orphan (crash leftover) goes; a fresh one may be a live run
  // mid-`git worktree add` whose registry write hasn't landed yet — spared.
  const aged = path.join(wtRoot, "tmp-deadbeef");
  const freshOrphan = path.join(wtRoot, "tmp-feedface");
  for (const d of [aged, freshOrphan]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "junk.txt"), "x");
  }
  const ago = new Date(Date.now() - 48 * HOUR);
  fs.utimesSync(aged, ago, ago);

  worktrees.sweep(cfg);
  assert.deepEqual(worktrees.load(), {}, "expired entry survived the sweep");
  assert.ok(!fs.existsSync(path.join(wtRoot, "tmp-abcdef12")), "expired worktree survived the sweep");
  assert.ok(!fs.existsSync(aged), "aged orphan directory survived the sweep");
  assert.ok(fs.existsSync(freshOrphan), "sweep ate a fresh untracked directory — that may be a run mid-create");
  fs.rmSync(freshOrphan, { recursive: true, force: true });
  assert.equal(listed(), baseline);

  const p3 = worktrees.create("tmp", "origin/main", cfg);
  worktrees.sweep(cfg);
  assert.ok(fs.existsSync(p3), "sweep ate a live worktree");
  worktrees.markRunEnded(RUN_ID, true);
});

test("sweep on a workspace that was never created is a no-op", () => {
  worktrees.sweep({ ...cfg, workspaceDir: path.join(TMP, "never") });
  assert.deepEqual(worktrees.load(), {});
});

// The CLI's own logic is argument parsing and exit codes; `create` itself is
// covered above. The happy path is deliberately not shelled out: the CLI resolves
// its config from ROOT/config.json, which a fresh clone does not have.
test("the CLI rejects bad invocations with a nonzero exit", () => {
  const cli = (args: string[]) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, "dist", "worktrees.js"), ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stderr: "" };
    } catch (e: any) {
      return { code: e.status as number, stderr: String(e.stderr) };
    }
  };
  for (const args of [[], ["create"], ["destroy", "tmp"]]) {
    const r = cli(args);
    assert.equal(r.code, 1, `expected failure for: ${args.join(" ") || "(no args)"}`);
    assert.match(r.stderr, /worktree helper: usage/);
  }
});
