import "./helpers";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as sessions from "../dist/sessions";

const HOUR = 60 * 60 * 1000;
const TTL = 6 * HOUR;
const EMPTY = { runs: {}, byMessage: {}, latestByChannel: {} };
const write = (s: unknown) => fs.writeFileSync(sessions.STATE_FILE, typeof s === "string" ? s : JSON.stringify(s));

test("a missing, corrupt, or pre-Phase-3 state file reads as empty", () => {
  fs.rmSync(sessions.STATE_FILE, { force: true });
  assert.deepEqual(sessions.load(TTL), EMPTY);
  write("{not json");
  assert.deepEqual(sessions.load(TTL), EMPTY, "corrupt file not tolerated");
  write({ "123": { sessionId: "old", updatedAt: Date.now() } }); // channel-keyed schema
  assert.deepEqual(sessions.load(TTL), EMPTY, "old schema not discarded");
});

test("a run records its session and every message posted for it", () => {
  write(EMPTY);
  sessions.recordRun("R1", { channelId: "CH", guildId: "G", tier: "dev" }, TTL);
  sessions.recordSession("R1", "sess-1", TTL);
  sessions.recordMessage("R1", "M-status", TTL);
  sessions.recordMessage("R1", "M-reply", TTL);
  sessions.recordMessage("R1", "M-reply", TTL); // idempotent

  const s = sessions.load(TTL);
  assert.deepEqual(s.runs.R1.messageIds, ["M-status", "M-reply"]);
  assert.equal(s.runs.R1.sessionId, "sess-1");
  assert.equal(s.latestByChannel.CH, "R1");
  assert.deepEqual(s.byMessage, { "M-status": "R1", "M-reply": "R1" });

  assert.equal(sessions.runByMessage("M-reply", TTL)?.sessionId, "sess-1");
  assert.equal(sessions.runByMessage("unknown", TTL), null);
  assert.equal(sessions.latestRun("CH", TTL)?.runId, "R1");
  assert.equal(sessions.latestRun("other", TTL), null);
});

test("writes for an unknown run are dropped, not created", () => {
  write(EMPTY);
  sessions.recordSession("ghost", "s", TTL);
  sessions.recordMessage("ghost", "M", TTL);
  assert.deepEqual(sessions.load(TTL), EMPTY);
});

test("re-recording a run merges: message ids survive, tier follows the current author", () => {
  write(EMPTY);
  sessions.recordRun("R1", { channelId: "CH", guildId: "G", tier: "dev" }, TTL);
  sessions.recordSession("R1", "sess-1", TTL);
  sessions.recordMessage("R1", "M-reply", TTL);

  sessions.recordRun("R1", { channelId: "CH", guildId: "G", tier: "chat" }, TTL);
  const s = sessions.load(TTL);
  assert.equal(s.runs.R1.tier, "chat");
  assert.equal(s.runs.R1.sessionId, "sess-1");
  assert.deepEqual(s.runs.R1.messageIds, ["M-reply"]);
});

test("past TTL a run stops resuming, and past the 24h grace it is pruned", () => {
  write(EMPTY);
  sessions.recordRun("R1", { channelId: "CH", guildId: "G", tier: "dev" }, TTL);
  sessions.recordMessage("R1", "M-reply", TTL);
  const age = (ms: number) => {
    const st = sessions.load(TTL);
    st.runs.R1.updatedAt = Date.now() - ms;
    write(st);
  };

  age(7 * HOUR);
  assert.equal(sessions.runByMessage("M-reply", TTL), null, "stale run resumed");
  assert.equal(sessions.latestRun("CH", TTL), null, "stale channel latest resumed");
  assert.ok(sessions.load(TTL).runs.R1, "pruned before the grace period elapsed");

  age(31 * HOUR);
  assert.deepEqual(sessions.load(TTL), EMPTY, "expired run not fully pruned");
});
