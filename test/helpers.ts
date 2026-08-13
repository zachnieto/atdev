// test/helpers.ts — per-file tmp sandbox + a fresh-clone-safe fixture config.
//
// IMPORT THIS FIRST in every test file: it points ATDEV_STATE_FILE /
// ATDEV_WORKTREE_FILE / ATDEV_LOG_FILE / ATDEV_USAGE_FILE at tmp before
// dist/sessions.js, dist/worktrees.js, dist/log.js and dist/runs.js read them at
// module load. node:test runs
// each file in its own process, so each gets its own tmp dir and the machine's
// real state/ and logs/ are never touched.
//
// Nothing here reads config.json, .env, state/ or logs/ — the suite must pass
// on a fresh clone with none of them present.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atdev-test-"));
process.env.ATDEV_STATE_FILE = path.join(TMP, "sessions.json");
process.env.ATDEV_WORKTREE_FILE = path.join(TMP, "worktrees.json");
process.env.ATDEV_LOG_FILE = path.join(TMP, "bot.log");
process.env.ATDEV_USAGE_FILE = path.join(TMP, "usage.jsonl");
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

// Fake snowflakes: shaped like Discord IDs, owned by nobody.
export const GUILD = "100000000000000001";
export const USER = "200000000000000002";
export const ROLE = "300000000000000003";
export const CHANNEL = "400000000000000004";

export const REPO1 = "fixture-app";
export const REPO2 = "fixture-infra";

// The chat allow-list is the real one from config.example.json: the argv test is
// only meaningful if the fixture carries the flags production actually ships.
const CHAT_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git diff*)",
  "Bash(gh pr view*)",
  "Bash(gh pr list*)",
  "mcp__discord-mcp__read_messages",
  "mcp__discord-mcp__list_forum_posts",
  "mcp__discord-mcp__get_attachment",
  "mcp__discord-mcp__get_channel_info",
  "mcp__discord-mcp__find_channel",
  "mcp__discord-mcp__list_channels",
  "mcp__discord-mcp__get_server_info",
  "mcp__discord-mcp__get_user_id_by_name",
  "mcp__discord-mcp__list_channel_permission_overwrites",
];

// Writes a schema-valid config plus the directories its repo paths point at.
// `over` is merged shallowly so a test can vary one key without a second file.
export function writeConfig(over: Record<string, unknown> = {}, name = "config.json"): string {
  const repoPath = (n: string) => {
    const p = path.join(TMP, "repos", n);
    fs.mkdirSync(p, { recursive: true });
    return p.replaceAll("\\", "/");
  };
  const cfg = {
    workspaceDir: path.join(TMP, "ws").replaceAll("\\", "/"),
    harness: {
      type: "claude",
      command: "claude",
      args: [],
      tierArgs: {
        chat: ["--permission-mode", "dontAsk", "--allowedTools", ...CHAT_TOOLS],
        dev: ["--permission-mode", "bypassPermissions"],
      },
      timeoutMinutes: 45,
    },
    mcp: { port: 0, host: "127.0.0.1", path: "/mcp", defaultGuildId: GUILD },
    repos: {
      [REPO1]: {
        path: repoPath(REPO1),
        base: "origin/main",
        description: "The fixture web app. Use for anything a customer would see.",
        notes: "PRs target main. Squash-merge only.",
      },
      [REPO2]: {
        path: repoPath(REPO2),
        base: "origin/develop",
        description: "Fixture infrastructure.",
        notes: "PRs target develop.",
      },
    },
    guilds: { [GUILD]: { name: "Fixture Server", repos: [REPO1, REPO2] } },
    access: [
      { user: USER, name: "Ada", tier: "dev" },
      { guild: GUILD, role: ROLE, tier: "dev" },
      { channel: CHANNEL, everyone: true, tier: "chat" },
    ],
    workflowNotes: "Fixture workflow notes: file a bead first.",
    sessionTtlHours: 6,
    worktreeTtlHours: 24,
    backscrollCount: 10,
    replyChainMax: 5,
    replyLimit: 1900,
    maxReplyMessages: 8,
    maxConcurrentRuns: 3,
    lockPort: 47391,
    ...over,
  };
  const file = path.join(TMP, name);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

export const CONFIG_FILE = writeConfig();
