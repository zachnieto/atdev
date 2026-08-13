// src/config.js — load + validate config.json (machine-local, not committed).
//
// Everything that used to be a top-of-index.js constant lives here now. Paths
// in the config may be relative (resolved against the repo root); absolute
// paths are passed through untouched so they stay byte-identical in prompts.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Scalars the code reads. config.json may override any of them.
const DEFAULTS = {
  workspaceDir: "./workspace",
  sessionTtlHours: 6,
  backscrollCount: 10,
  replyChainMax: 5,
  replyLimit: 1900, // Discord hard cap is 2000 chars
  maxReplyMessages: 8, // runaway guard; agent is told to use ≤4 blocks
  statusEditMinMs: 4500, // Discord edit rate-limit headroom
  statusTail: 10, // activity lines kept in the status message
  lockPort: 47391, // singleton guard: second instance exits immediately
};

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function loadConfig(file = path.join(ROOT, "config.json")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`config not found: ${file} — copy config.example.json to config.json and fill it in`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config ${file} is not valid JSON: ${e.message}`);
  }
  cfg = { ...DEFAULTS, ...cfg };

  if (!cfg.repos || !Object.keys(cfg.repos).length) throw new Error("config.repos is empty — at least one repo is required");
  for (const [name, repo] of Object.entries(cfg.repos)) {
    if (!repo.path) throw new Error(`config.repos.${name}.path is missing`);
    repo.path = resolvePath(repo.path);
    if (!fs.existsSync(repo.path)) throw new Error(`config.repos.${name}.path does not exist: ${repo.path}`);
    if (!repo.base) throw new Error(`config.repos.${name}.base is missing`);
  }
  if (!cfg.guilds || !Object.keys(cfg.guilds).length) throw new Error("config.guilds is empty — the bot would answer nowhere");
  for (const [id, guild] of Object.entries(cfg.guilds)) {
    for (const name of guild.repos ?? []) {
      if (!cfg.repos[name]) throw new Error(`config.guilds.${id}.repos references unknown repo "${name}"`);
    }
  }
  if (!Array.isArray(cfg.access) || !cfg.access.length) throw new Error("config.access is empty — the bot would answer nobody");
  for (const rule of cfg.access) {
    if (!rule.tier) throw new Error(`config.access rule is missing a tier: ${JSON.stringify(rule)}`);
  }
  if (!cfg.harness?.command) throw new Error("config.harness.command is missing");
  cfg.workspaceDir = resolvePath(cfg.workspaceDir);
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };
