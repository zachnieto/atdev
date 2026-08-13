import { CONFIG_FILE } from "./helpers";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../dist/config";
import * as sessions from "../dist/sessions";
import { evaluate, matchAccess } from "../dist/triggers";
import type { AccessRule } from "../dist/config";

const HOUR = 60 * 60 * 1000;

// Ordered, first match wins, every key present on a rule must match.
const RULES: AccessRule[] = [
  { user: "u1", tier: "dev" },
  { guild: "g1", role: "r1", tier: "dev" },
  { channel: "c1", everyone: true, tier: "chat" },
  { user: "u1", tier: "chat" }, // shadowed by the first rule
];

const cfg = { ...loadConfig(CONFIG_FILE), guilds: { G: { name: "T" } }, access: RULES, sessionTtlHours: 6 } as any;
const client = { user: { id: "BOT" } } as any;

test("access rules: ordered, all-keys-must-match, threads inherit their parent", () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    author: { id: "nobody" },
    channelId: "cX",
    guildId: "gX",
    member: null,
    channel: {},
    ...over,
  });
  const withRole = (r: string) => ({ member: { roles: { cache: new Set([r]) } } });

  assert.equal(matchAccess(RULES, mk({ author: { id: "u1" } }))?.tier, "dev", "first match wins");
  assert.equal(matchAccess(RULES, mk({ guildId: "g1", ...withRole("r1") }))?.tier, "dev", "role rule");
  assert.equal(matchAccess(RULES, mk({ guildId: "gX", ...withRole("r1") })), null, "role rule needs its guild too");
  assert.equal(matchAccess(RULES, mk({ guildId: "g1", ...withRole("other") })), null, "wrong role");
  assert.equal(matchAccess(RULES, mk({ channelId: "c1" }))?.tier, "chat", "channel + everyone");
  assert.equal(matchAccess(RULES, mk({ channelId: "t9", channel: { parentId: "c1" } }))?.tier, "chat", "thread inherits parent");
  assert.equal(matchAccess(RULES, mk()), null, "stranger");
});

const msg = (over: Record<string, unknown> = {}) =>
  ({
    inGuild: () => true,
    author: { id: "u1", bot: false },
    guildId: "G",
    channelId: "CH",
    channel: {},
    content: "<@BOT> please do the thing",
    member: null,
    mentions: { users: { has: () => false } },
    ...over,
  }) as any;
const mention = { mentions: { users: { has: (id: string) => id === "BOT" } } };

test("non-triggers stay non-triggers", () => {
  assert.equal(evaluate(client, cfg, msg({ inGuild: () => false, ...mention })), null, "DM");
  assert.equal(evaluate(client, cfg, msg({ author: { id: "u1", bot: true }, ...mention })), null, "bot author");
  assert.equal(evaluate(client, cfg, msg({ guildId: "nope", ...mention })), null, "unmapped guild");
  assert.equal(evaluate(client, cfg, msg()), null, "no mention, no reply");
  assert.equal(evaluate(client, cfg, msg({ author: { id: "rando", bot: false }, ...mention })), null, "stranger");
});

test("mention/reply resolution: fresh, resume, cross-tier, unknown reference", () => {
  fs.writeFileSync(sessions.STATE_FILE, JSON.stringify({ runs: {}, byMessage: {}, latestByChannel: {} }));

  const fresh = evaluate(client, cfg, msg(mention));
  assert.equal(fresh?.mode, "fresh");
  assert.equal(fresh?.tier, "dev");
  assert.match(fresh!.run.runId, /^[0-9a-f-]{36}$/);
  assert.equal(fresh!.run.sessionId, null);
  assert.notEqual(evaluate(client, cfg, msg(mention))!.run!.runId, fresh!.run.runId, "runId is per-trigger");

  sessions.recordRun(fresh!.run.runId, { channelId: "CH", guildId: "G", tier: "dev" }, 6 * HOUR);
  sessions.recordSession(fresh!.run.runId, "sess-A", 6 * HOUR);
  sessions.recordMessage(fresh!.run.runId, "BOTMSG", 6 * HOUR);

  // a bare re-mention resumes the channel's latest run
  const again = evaluate(client, cfg, msg(mention));
  assert.equal(again?.mode, "resume");
  assert.equal(again?.run.sessionId, "sess-A");

  // an unpinged reply to one of that run's messages is a trigger on its own
  const reply = evaluate(client, cfg, msg({ reference: { messageId: "BOTMSG" } }));
  assert.equal(reply?.mode, "resume");
  assert.equal(reply?.run.runId, fresh!.run.runId);

  // ...but only to a message we actually posted, and never for a stranger
  assert.equal(evaluate(client, cfg, msg({ reference: { messageId: "SOMEONE-ELSE" } })), null);
  assert.equal(
    evaluate(client, cfg, msg({ author: { id: "rando", bot: false }, reference: { messageId: "BOTMSG" } })),
    null,
    "stranger follow-up",
  );

  // a chat user replying into a dev conversation is restricted to chat
  const crossTier = evaluate(
    client,
    cfg,
    msg({ author: { id: "u9", bot: false }, channelId: "c1", reference: { messageId: "BOTMSG" } }),
  );
  assert.equal(crossTier?.mode, "resume");
  assert.equal(crossTier?.tier, "chat", "resume must use the current author's tier");
  assert.equal(crossTier?.run.sessionId, "sess-A");
});

// ---- control commands --------------------------------------------------------
test("cancel/status are control matches, not work orders", () => {
  fs.writeFileSync(sessions.STATE_FILE, JSON.stringify({ runs: {}, byMessage: {}, latestByChannel: {} }));

  for (const content of ["<@BOT> cancel", "<@!BOT>   CANCEL  ", "cancel <@BOT>"]) {
    const m = evaluate(client, cfg, msg({ ...mention, content }));
    assert.equal(m?.command, "cancel", `not recognized: ${content}`);
    assert.equal(m?.tier, "dev");
    assert.ok(!("run" in m!), "a control command must not mint a run");
  }
  assert.equal(evaluate(client, cfg, msg({ ...mention, content: "<@BOT> Status" }))?.command, "status");

  // and nothing was written to the session store
  const state = JSON.parse(fs.readFileSync(sessions.STATE_FILE, "utf8"));
  assert.deepEqual(state.runs, {});

  // a chat user may ask for status but not cancel (the tier travels with the match)
  const chat = msg({ author: { id: "u9", bot: false }, channelId: "c1", ...mention });
  assert.equal(evaluate(client, cfg, { ...chat, content: "<@BOT> status" } as any)?.tier, "chat");
  const chatCancel = evaluate(client, cfg, { ...chat, content: "<@BOT> cancel" } as any);
  assert.equal(chatCancel?.command, "cancel");
  assert.equal(chatCancel?.tier, "chat", "the tier travels with the match; commands.ts is what denies it");

  // anything else is still a work order
  const work = evaluate(client, cfg, msg({ ...mention, content: "<@BOT> cancel the release please" }));
  assert.equal(work?.command, undefined);
  assert.equal(work?.mode, "fresh");
  assert.equal(evaluate(client, cfg, msg({ ...mention, content: "<@BOT> statuses" }))?.command, undefined);

  // a stranger's `cancel` is still ignored before anything else
  assert.equal(evaluate(client, cfg, msg({ author: { id: "rando", bot: false }, ...mention, content: "cancel" })), null);
});

test("a run past its TTL is not resumed — a mention starts fresh", () => {
  const state = JSON.parse(fs.readFileSync(sessions.STATE_FILE, "utf8"));
  for (const run of Object.values(state.runs) as any[]) run.updatedAt = Date.now() - 7 * HOUR;
  fs.writeFileSync(sessions.STATE_FILE, JSON.stringify(state));
  assert.equal(evaluate(client, cfg, msg(mention))?.mode, "fresh");
  assert.equal(evaluate(client, cfg, msg({ reference: { messageId: "BOTMSG" } })), null, "cold reply is not a trigger");
});
