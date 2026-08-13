// src/triggers.js — messageCreate -> {project, tier} | null.
//
// Guild message + not a bot + direct @mention + a mapped guild + an access rule
// that matches the author. No match = silent ignore (no AI in the loop for
// strangers). Access rules are ordered, first match wins; every key present on
// a rule must match. Multi-repo guild routing is Phase 4 — for now a guild
// resolves to its first repo.

const { log } = require("./log");

function matchAccess(access, message) {
  for (const rule of access) {
    if (rule.user && rule.user !== message.author.id) continue;
    if (rule.channel && rule.channel !== message.channelId) continue;
    if (rule.guild && rule.guild !== message.guildId) continue;
    if (rule.role && !message.member?.roles?.cache?.has(rule.role)) continue;
    return rule; // `everyone: true` is documentation — a rule with no identity key matches anyone
  }
  return null;
}

function evaluate(client, config, message) {
  if (!message.inGuild() || message.author.bot) return null;
  if (!message.mentions.users.has(client.user.id)) return null; // direct @mention only (not @everyone/@role)
  const guild = config.guilds[message.guildId];
  if (!guild) return null;
  const rule = matchAccess(config.access, message);
  if (!rule) {
    // Hard authorization gate: everyone else is ignored before any AI runs.
    log(`Ignored mention from unauthorized user ${message.author.id} in ${guild.name}`);
    return null;
  }
  const repoName = guild.repos?.[0] ?? Object.keys(config.repos)[0];
  const repo = config.repos[repoName];
  return {
    tier: rule.tier,
    project: { name: guild.name, repo: repo.path, prNote: repo.notes ?? "", base: repo.base },
  };
}

module.exports = { evaluate, matchAccess };
