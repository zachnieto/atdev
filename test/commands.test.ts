import { CONFIG_FILE } from "./helpers";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../dist/config";
import { handleCommand, statusText, targetRun } from "../dist/commands";
import { activeRuns, type ActiveRun } from "../dist/runs";
import * as sessions from "../dist/sessions";

const cfg = loadConfig(CONFIG_FILE);
const HOUR = 60 * 60 * 1000;

// A run as runs.ts registers it, with a kill handle that just records the call.
function register(over: Partial<ActiveRun> = {}) {
  const killed: boolean[] = [];
  const entry: ActiveRun = {
    runId: "aaaaaaaa-1111-2222-3333-444444444444",
    tier: "dev",
    where: "Fixture Server#general",
    channelId: "CH",
    startedAt: Date.now() - 90 * 1000,
    queued: false,
    cancelled: false,
    kill: () => killed.push(true),
    ...over,
  };
  activeRuns.set(entry.runId, entry);
  return { entry, killed };
}

// A Discord message stub that records what the handler said/did.
function fakeMessage(over: Record<string, unknown> = {}) {
  const said: string[] = [];
  const reacted: string[] = [];
  const message = {
    channelId: "CH",
    author: { id: "u1" },
    reply: async ({ content }: any) => said.push(content),
    react: async (e: string) => reacted.push(e),
    ...over,
  } as any;
  return { message, said, reacted };
}

test("status lists the live runs and the queued count, or says idle", () => {
  activeRuns.clear();
  assert.equal(statusText(), "idle");

  const { entry } = register();
  register({ runId: "bbbbbbbb-1111-2222-3333-444444444444", tier: "chat", queued: true, kill: undefined });
  const text = statusText();
  assert.match(text, /`aaaaaaaa` dev · Fixture Server#general · 1\.5min/);
  assert.equal(text.split("\n").at(-1), "1 queued", "the queued run is counted, not listed");
  assert.ok(!text.includes("bbbbbbbb"), "a queued run has no elapsed time to report");

  entry.queued = true;
  assert.equal(statusText(), "2 queued", "everything waiting is still not idle");
  activeRuns.clear();
});

test("cancel kills the channel's newest run, reacts, and reports", async () => {
  activeRuns.clear();
  register({ runId: "cccccccc-1111-2222-3333-444444444444", startedAt: Date.now() - 10 * 60 * 1000 });
  const { entry, killed } = register({ startedAt: Date.now() - 60 * 1000 });
  register({ runId: "dddddddd-1111-2222-3333-444444444444", channelId: "OTHER" });

  const { message, said, reacted } = fakeMessage();
  await handleCommand(cfg, message, "cancel", "dev");
  assert.deepEqual(killed, [true], "the newest run in this channel was the one killed");
  assert.ok(entry.cancelled, "the run is flagged so it does not also post a failure reply");
  assert.deepEqual(reacted, ["🛑"]);
  assert.match(said[0], /^Cancelled run `aaaaaaaa` after 1\.0min\.$/);
  activeRuns.clear();
});

test("cancel is dev-only, and says so when there is nothing to kill", async () => {
  activeRuns.clear();
  const { killed } = register();

  const chat = fakeMessage();
  await handleCommand(cfg, chat.message, "cancel", "chat");
  assert.match(chat.said[0], /dev-tier only/);
  assert.deepEqual(killed, [], "a chat user must not be able to kill a run");
  assert.deepEqual(chat.reacted, []);

  // status is open to every authorized tier
  const status = fakeMessage();
  await handleCommand(cfg, status.message, "status", "chat");
  assert.match(status.said[0], /`aaaaaaaa`/);

  activeRuns.clear();
  const idle = fakeMessage();
  await handleCommand(cfg, idle.message, "cancel", "dev");
  assert.match(idle.said[0], /Nothing to cancel/);
});

test("a cancel that replies to a run's message targets that run", () => {
  activeRuns.clear();
  const { entry } = register({ runId: "eeeeeeee-1111-2222-3333-444444444444", channelId: "ELSEWHERE" });
  register(); // newer, in the replying channel — must NOT win when a reply targets another run
  sessions.recordRun(entry.runId, { channelId: "ELSEWHERE", guildId: "G", tier: "dev" }, 6 * HOUR);
  sessions.recordMessage(entry.runId, "BOTMSG-X", 6 * HOUR);

  const { message } = fakeMessage({ reference: { messageId: "BOTMSG-X" } });
  assert.equal(targetRun(message, 6 * HOUR)?.runId, entry.runId);
  // a reply to a message from a run that already finished targets nothing
  activeRuns.delete(entry.runId);
  assert.equal(targetRun(message, 6 * HOUR), null);
  activeRuns.clear();
});
