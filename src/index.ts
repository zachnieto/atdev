// atdev — Discord mention listener that triggers headless Claude Code runs.
//
// Flow: an authorized user (config.access) @mentions the bot in a mapped guild
// -> react 👀 -> spawn the harness in that guild's repo with a work-order
// prompt (beads-first, PR flow) -> post the <reply>-marked portion of the final
// message as the Discord reply. Mentions from anyone else are ignored silently,
// before any AI is in the loop. Everything configurable lives in config.json;
// the only secret is DISCORD_TOKEN in .env.
//
// This file is the entry point only — see the rest of src/ for the pieces:
//   config.ts · triggers.ts · runs.ts · sessions.ts
//   runners/claude.ts · mcp-server.ts

import "dotenv/config";
import net from "node:net";
import { Client, GatewayIntentBits, Events, Message } from "discord.js";
import { loadConfig, Config } from "./config";
import { log } from "./log";
import { evaluate } from "./triggers";
import { startRun } from "./runs";
import { startMcpServer } from "./mcp-server";
import { sweep } from "./worktrees";

export function startBot(config: Config) {
  // Collect expired/orphaned worktrees at startup and hourly (a crashed run
  // leaves its worktree behind on purpose — this is what eventually reaps it).
  const sweepWorktrees = () => {
    try {
      sweep(config);
    } catch (e: any) {
      log(`Worktree sweep failed: ${e?.stack || e}`);
    }
  };
  sweepWorktrees();
  setInterval(sweepWorktrees, 60 * 60 * 1000);

  const client = new Client({
    // MessageContent is needed for backscroll (non-mention messages); the bot's
    // portal toggle already has it on (the triage routines read channels via REST).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once(Events.ClientReady, (c) => {
    log(`Logged in as ${c.user.tag} (${c.user.id})`);
    const mcp = config.mcp ?? {};
    startMcpServer(client, mcp);
    log(`In-process discord-mcp listening on http://${mcp.host ?? "127.0.0.1"}:${mcp.port}${mcp.path ?? "/mcp"}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      const match = evaluate(client, config, message);
      if (!match) return;
      await startRun(config, message, match);
    } catch (e: any) {
      log(`Handler error: ${e?.stack || e}`);
      await message.react("❌").catch(() => {});
    }
  });

  client.login(process.env.DISCORD_TOKEN).catch((e: any) => {
    log(`Login failed: ${e?.message || e}`);
    process.exit(1);
  });
}

// ---- entry point -------------------------------------------------------------
export function main() {
  const config = loadConfig();
  // singleton lock: second instance exits immediately
  const lock = net.createServer();
  lock.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log("atdev already running; exiting.");
      process.exit(0);
    }
    throw err;
  });
  lock.listen(config.lockPort, "127.0.0.1", () => {
    startBot(config);
  });
}

if (require.main === module) main();
