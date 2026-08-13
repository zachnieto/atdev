// src/triggers.ts — messageCreate -> {tier, mode, run} | null.
//
// A guild message from a human triggers a run when it either @mentions the bot
// or is a Discord reply to one of the bot's own messages from a live run (the
// unpinged follow-up: the reply chain *is* the conversation). Access rules are
// ordered, first match wins, and every key present on a rule must match; no
// match = silent ignore, so no AI is ever in the loop for strangers.
//
// Session resolution: a reply to a known bot message resumes that run; a bare
// @mention resumes the channel's latest run if it is still within TTL,
// otherwise starts fresh. A resume always runs at the CURRENT author's tier —
// a chat user replying into a dev conversation gets chat restrictions.

import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";
import type { AccessRule, Config } from "./config";
import { log } from "./log";
import { runByMessage, latestRun } from "./sessions";

export interface Match {
  tier: string;
  mode: "resume" | "fresh";
  run: { runId: string; sessionId: string | null };
}

// `message` is deliberately loose: every field is read through optional chaining
// because the shapes differ between channel kinds (guild channel vs thread).
export function matchAccess(access: AccessRule[], message: any): AccessRule | null {
  for (const rule of access) {
    if (rule.user && rule.user !== message.author.id) continue;
    // `channel` also matches a thread's parent (and a channel's category).
    if (rule.channel && rule.channel !== message.channelId && rule.channel !== message.channel?.parentId) continue;
    if (rule.guild && rule.guild !== message.guildId) continue;
    if (rule.role && !message.member?.roles?.cache?.has(rule.role)) continue;
    return rule; // `everyone: true` is documentation — a rule with no identity key matches anyone
  }
  return null;
}

export function evaluate(client: Client, config: Config, message: Message): Match | null {
  if (!message.inGuild() || message.author.bot) return null;
  const guild = config.guilds[message.guildId];
  if (!guild) return null;

  const ttlMs = config.sessionTtlHours * 60 * 60 * 1000;
  const mentioned = message.mentions.users.has(client.user!.id); // direct @mention only (not @everyone/@role)
  const repliedTo = message.reference?.messageId ? runByMessage(message.reference.messageId, ttlMs) : null;
  if (!mentioned && !repliedTo) return null;

  const rule = matchAccess(config.access, message);
  if (!rule) {
    // Hard authorization gate: everyone else is ignored before any AI runs.
    log(`Ignored ${repliedTo ? "follow-up" : "mention"} from unauthorized user ${message.author.id} in ${guild.name}`);
    return null;
  }

  const run = repliedTo ?? (mentioned ? latestRun(message.channelId, ttlMs) : null);
  return { tier: rule.tier, mode: run ? "resume" : "fresh", run: run ?? { runId: randomUUID(), sessionId: null } };
}
