// src/commands.ts — the two control commands: `/cancel` and `/status`, plus
// their `@bot cancel` / `@bot status` mention equivalents.
//
// These are not work orders: neither entry point spawns a harness, mints a run
// id, touches a session or queues behind the concurrency cap. They read (and,
// for cancel, kill) the in-memory active-run registry that runs.ts maintains
// around each spawn. Both routes share the same targeting + kill core; only the
// Discord plumbing (react + reply vs. interaction reply) differs.

import { ApplicationCommandOptionType, MessageFlags, type Client, type Interaction, type Message } from "discord.js";
import type { Config } from "./config";
import { log } from "./log";
import { type ActiveRun, activeRuns } from "./runs";
import { runByMessage } from "./sessions";
import { matchAccess } from "./triggers";

const elapsed = (since: number) => ((Date.now() - since) / 60000).toFixed(1);

export function statusText(runs: ActiveRun[] = [...activeRuns.values()]): string {
  const live = runs.filter((r) => !r.queued);
  const queued = runs.length - live.length;
  if (!runs.length) return "idle";
  const lines = live.map((r) => `\`${r.runId.slice(0, 8)}\` ${r.tier} · ${r.where} · ${elapsed(r.startedAt)}min`);
  if (queued) lines.push(`${queued} queued`);
  return lines.join("\n");
}

// The channel's most recent *running* run (a queued run has nothing to kill yet).
const newestIn = (channelId: string): ActiveRun | null =>
  [...activeRuns.values()].filter((r) => r.channelId === channelId && r.kill).sort((a, b) => b.startedAt - a.startedAt)[0] ??
  null;

// A reply to one of a run's messages targets that run; a bare `cancel` takes the
// channel's most recent running one.
export function targetRun(message: any, ttlMs: number): ActiveRun | null {
  const ref = message.reference?.messageId ? runByMessage(message.reference.messageId, ttlMs) : null;
  if (ref) return activeRuns.get(ref.runId) ?? null;
  return newestIn(message.channelId);
}

// The shared core both routes end in. Returns what to say.
function cancelRun(run: ActiveRun, byUserId: string): string {
  run.cancelled = true;
  run.kill!();
  log(`Cancelled run ${run.runId} by ${byUserId} after ${elapsed(run.startedAt)}min`);
  return `Cancelled run \`${run.runId.slice(0, 8)}\` after ${elapsed(run.startedAt)}min.`;
}

// ---- mention route -----------------------------------------------------------
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
  const said = cancelRun(target, message.author.id);
  await message.react("🛑").catch(() => {});
  await say(said);
}

// ---- slash route -------------------------------------------------------------
// Registered per guild (instant, unlike global commands' ~1h propagation).
export const COMMAND_DEFS = [
  { name: "status", description: "Show the agent runs in flight" },
  {
    name: "cancel",
    description: "Cancel an agent run (dev tier only)",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "run",
        description: "Run id from /status (default: this channel's newest run)",
        required: false,
      },
    ],
  },
];

// PUT is idempotent, so this just runs at every startup. Registration needs the
// `applications.commands` scope in that guild; without it Discord answers 50001
// and we log the re-invite URL rather than taking the bot down — mention
// commands keep working either way.
export async function registerCommands(client: Client, config: Config) {
  for (const guildId of Object.keys(config.guilds)) {
    try {
      await client.application!.commands.set(COMMAND_DEFS as any, guildId);
      log(`Slash commands registered in guild ${guildId}`);
    } catch (e: any) {
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${client.user?.id}&permissions=67648&scope=bot%20applications.commands`;
      log(
        `Slash command registration failed for guild ${guildId}: ${e?.message || e} — mention commands still work; re-invite the app with both scopes to fix: ${invite}`,
      );
    }
  }
}

export async function handleInteraction(config: Config, interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  const say = (content: string, ephemeral = true) =>
    interaction.reply(ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content });

  // Same rules as the mention route, over the shape matchAccess reads.
  const rule = matchAccess(config.access, {
    author: interaction.user,
    channelId: interaction.channelId,
    channel: interaction.channel,
    guildId: interaction.guildId,
    member: interaction.member,
  });
  if (!rule) {
    // Unlike a mention we can't ignore this — Discord shows the user a failure
    // regardless, so an explicit private denial is the honest answer.
    log(`Ignored /${interaction.commandName} from unauthorized user ${interaction.user.id}`);
    await say("Not authorized.");
    return;
  }
  if (interaction.commandName === "status") {
    await say(statusText());
    return;
  }
  if (rule.tier !== "dev") {
    await say("`/cancel` is dev-tier only.");
    return;
  }
  const id8 = interaction.options.getString("run");
  const target = id8 ? ([...activeRuns.values()].find((r) => r.runId.startsWith(id8)) ?? null) : newestIn(interaction.channelId);
  if (!target?.kill) {
    await say(id8 ? `No active run \`${id8}\`.` : "Nothing to cancel.");
    return;
  }
  await say(cancelRun(target, interaction.user.id), false); // public: the team should see a run was cancelled
}
