// src/config.ts — load + validate config.json (machine-local, not committed).
//
// Everything that used to be a top-of-index.js constant lives here now. Paths
// in the config may be relative (resolved against the repo root); absolute
// paths are passed through untouched so they stay byte-identical in prompts.

import fs from "node:fs";
import path from "node:path";

export interface RepoConfig {
  path: string;
  base: string;
  description?: string;
  notes?: string;
}

export interface GuildConfig {
  name: string;
  repos?: string[];
}

export interface AccessRule {
  tier: string;
  user?: string;
  role?: string;
  guild?: string;
  channel?: string;
  name?: string;
  everyone?: boolean;
}

export interface HarnessConfig {
  type?: string;
  command: string;
  args?: string[];
  tierArgs?: Record<string, string[]>;
  timeoutMinutes?: number;
}

export interface McpConfig {
  host?: string;
  port?: number;
  path?: string;
  defaultGuildId?: string;
}

export interface Config {
  workspaceDir: string;
  harness: HarnessConfig;
  mcp?: McpConfig;
  repos: Record<string, RepoConfig>;
  guilds: Record<string, GuildConfig>;
  access: AccessRule[];
  workflowNotes?: string;
  sessionTtlHours: number;
  worktreeTtlHours: number;
  backscrollCount: number;
  replyChainMax: number;
  replyLimit: number;
  maxReplyMessages: number;
  maxConcurrentRuns?: number;
  lockPort: number;
}

export const ROOT = path.join(__dirname, "..");

// Scalars the code reads. config.json may override any of them.
export const DEFAULTS = {
  workspaceDir: "./workspace",
  sessionTtlHours: 6,
  backscrollCount: 10,
  replyChainMax: 5,
  replyLimit: 1900, // Discord hard cap is 2000 chars
  maxReplyMessages: 8, // runaway guard; agent is told to use ≤4 blocks
  lockPort: 47391, // singleton guard: second instance exits immediately
};

function resolvePath(p: string) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

export function loadConfig(file = path.join(ROOT, "config.json")): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`config not found: ${file} — copy config.example.json to config.json and fill it in`);
  }
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`config ${file} is not valid JSON: ${e.message}`);
  }
  cfg = { ...DEFAULTS, ...cfg };

  if (!cfg.repos || !Object.keys(cfg.repos).length) throw new Error("config.repos is empty — at least one repo is required");
  for (const [name, repo] of Object.entries(cfg.repos) as [string, RepoConfig][]) {
    if (!repo.path) throw new Error(`config.repos.${name}.path is missing`);
    repo.path = resolvePath(repo.path);
    if (!fs.existsSync(repo.path)) throw new Error(`config.repos.${name}.path does not exist: ${repo.path}`);
    if (!repo.base) throw new Error(`config.repos.${name}.base is missing`);
  }
  if (!cfg.guilds || !Object.keys(cfg.guilds).length) throw new Error("config.guilds is empty — the bot would answer nowhere");
  for (const [id, guild] of Object.entries(cfg.guilds) as [string, GuildConfig][]) {
    for (const name of guild.repos ?? []) {
      if (!cfg.repos[name]) throw new Error(`config.guilds.${id}.repos references unknown repo "${name}"`);
    }
  }
  if (!Array.isArray(cfg.access) || !cfg.access.length) throw new Error("config.access is empty — the bot would answer nobody");
  for (const rule of cfg.access as AccessRule[]) {
    if (!rule.tier) throw new Error(`config.access rule is missing a tier: ${JSON.stringify(rule)}`);
  }
  if (!cfg.harness?.command) throw new Error("config.harness.command is missing");
  cfg.workspaceDir = resolvePath(cfg.workspaceDir);
  return cfg as Config;
}
