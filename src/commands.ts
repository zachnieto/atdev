// src/commands.ts — the two control commands: `@bot cancel` and `@bot status`.
//
// These are not work orders: triggers.ts routes them here instead of runs.ts,
// so they never spawn a harness, mint a run id, touch a session or queue behind
// the concurrency cap. They read (and, for cancel, kill) the in-memory active-run
// registry that runs.ts maintains around each spawn.

import type { Message } from "discord.js";
import type { Config } from "./config";
import { log } from "./log";
import { type ActiveRun, activeRuns } from "./runs";
import { runByMessage } from "./sessions";

const elapsed = (since: number) => ((Date.now() - since) / 60000).toFixed(1);

export function statusText(runs: ActiveRun[] = [...activeRuns.values()]): string {
  const live = runs.filter((r) => !r.queued);
  const queued = runs.length - live.length;
  if (!runs.length) return "idle";
  const lines = live.map((r) => `\`${r.runId.slice(0, 8)}\` ${r.tier} · ${r.where} · ${elapsed(r.startedAt)}min`);
  if (queued) lines.push(`${queued} queued`);
  return lines.join("\n");
}

// A reply to one of a run's messages targets that run; a bare `cancel` takes the
// channel's most recent running one (a queued run has nothing to kill yet).
export function targetRun(message: any, ttlMs: number): ActiveRun | null {
  const ref = message.reference?.messageId ? runByMessage(message.reference.messageId, ttlMs) : null;
  if (ref) return activeRuns.get(ref.runId) ?? null;
  return (
    [...activeRuns.values()]
      .filter((r) => r.channelId === message.channelId && r.kill)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  );
}

export async function handleCommand(config: Config, message: Message, command: "cancel" | "status", tier: string) {
  const say = (content: string) => message.reply({ content, allowedMentions: { repliedUser: false } });
  if (command === "status") {
    await say(statusText());
    return;
  }
  if (tier !== "dev") {
    await say("`cancel` is dev-tier only.");
    return;
  }
  const target = targetRun(message, config.sessionTtlHours * 60 * 60 * 1000);
  if (!target?.kill) {
    await say("Nothing to cancel.");
    return;
  }
  target.cancelled = true;
  target.kill();
  log(`Cancelled run ${target.runId} by ${message.author.id} after ${elapsed(target.startedAt)}min`);
  await message.react("🛑").catch(() => {});
  await say(`Cancelled run \`${target.runId.slice(0, 8)}\` after ${elapsed(target.startedAt)}min.`);
}
