// src/sessions.ts — run-keyed session store (for --resume continuity).
//
// Schema: {runs: {runId: {sessionId, channelId, guildId, tier, messageIds, updatedAt}},
//          byMessage: {<bot message id>: runId},
//          latestByChannel: {channelId: runId}}
//
// The run is the unit of conversation. Every bot message posted for a run
// (each reply chunk) is recorded, so an unpinged Discord reply
// to any of them resumes that exact session. sessionId is written the moment the
// harness emits its init event, so a crashed run is still resumable.
//
// Entries are pruned on load once they are past sessionTtl + a 24h grace (the
// grace keeps a just-expired run around for forensics). A pre-Phase-3 file
// (channel-keyed, no `runs` key) is discarded rather than migrated — sessions
// are short-lived, so there is nothing worth carrying over.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";

export interface RunEntry {
  sessionId: string | null;
  channelId: string;
  guildId: string;
  tier: string;
  messageIds: string[];
  updatedAt: number;
}

export interface SessionState {
  runs: Record<string, RunEntry>;
  byMessage: Record<string, string>;
  latestByChannel: Record<string, string>;
}

export type RunRef = RunEntry & { runId: string };

export const STATE_FILE = process.env.ATDEV_STATE_FILE || path.join(ROOT, "state", "sessions.json");
const GRACE_MS = 24 * 60 * 60 * 1000;
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

export function load(ttlMs: number): SessionState {
  let s: any;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    s = null;
  }
  if (!s?.runs) return { runs: {}, byMessage: {}, latestByChannel: {} }; // missing or old schema
  const cutoff = Date.now() - (ttlMs + GRACE_MS);
  for (const [runId, run] of Object.entries(s.runs) as [string, RunEntry][]) {
    if (run.updatedAt >= cutoff) continue;
    delete s.runs[runId];
    for (const id of run.messageIds ?? []) delete s.byMessage[id];
    if (s.latestByChannel[run.channelId] === runId) delete s.latestByChannel[run.channelId];
  }
  return s as SessionState;
}

function save(s: SessionState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Create or refresh a run. Merging (rather than replacing) keeps the message
// ids of a resumed run, and lets `tier` follow the current author.
export function recordRun(
  runId: string,
  { channelId, guildId, tier }: { channelId: string; guildId: string; tier: string },
  ttlMs: number,
) {
  const s = load(ttlMs);
  const prev = s.runs[runId] ?? ({ sessionId: null, messageIds: [] } as unknown as RunEntry);
  s.runs[runId] = { ...prev, channelId, guildId, tier, updatedAt: Date.now() };
  s.latestByChannel[channelId] = runId;
  save(s);
}

export function recordSession(runId: string, sessionId: string | null, ttlMs: number) {
  const s = load(ttlMs);
  if (!s.runs[runId]) return;
  s.runs[runId].sessionId = sessionId;
  s.runs[runId].updatedAt = Date.now();
  save(s);
}

// Every bot message we post becomes a handle back onto its run.
export function recordMessage(runId: string, messageId: string, ttlMs: number) {
  const s = load(ttlMs);
  const run = s.runs[runId];
  if (!run) return;
  if (!run.messageIds.includes(messageId)) run.messageIds.push(messageId);
  run.updatedAt = Date.now();
  s.byMessage[messageId] = runId;
  save(s);
}

function fresh(s: SessionState, runId: string, ttlMs: number): RunRef | null {
  const run = s.runs[runId];
  return run && Date.now() - run.updatedAt < ttlMs ? { runId, ...run } : null;
}

// Both lookups are TTL-bounded: a cold conversation is not resumed (and, for a
// bare reply, is not even a trigger — ping the bot to start a new one).
export function runByMessage(messageId: string, ttlMs: number): RunRef | null {
  const s = load(ttlMs);
  const runId = s.byMessage[messageId];
  return runId ? fresh(s, runId, ttlMs) : null;
}

export function latestRun(channelId: string, ttlMs: number): RunRef | null {
  const s = load(ttlMs);
  const runId = s.latestByChannel[channelId];
  return runId ? fresh(s, runId, ttlMs) : null;
}
