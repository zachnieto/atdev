// src/sessions.js — run-keyed session store (for --resume continuity).
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

const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./config");

const STATE_FILE = process.env.ATDEV_STATE_FILE || path.join(ROOT, "state", "sessions.json");
const GRACE_MS = 24 * 60 * 60 * 1000;
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

function load(ttlMs) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    s = null;
  }
  if (!s?.runs) return { runs: {}, byMessage: {}, latestByChannel: {} }; // missing or old schema
  const cutoff = Date.now() - (ttlMs + GRACE_MS);
  for (const [runId, run] of Object.entries(s.runs)) {
    if (run.updatedAt >= cutoff) continue;
    delete s.runs[runId];
    for (const id of run.messageIds ?? []) delete s.byMessage[id];
    if (s.latestByChannel[run.channelId] === runId) delete s.latestByChannel[run.channelId];
  }
  return s;
}

function save(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Create or refresh a run. Merging (rather than replacing) keeps the message
// ids of a resumed run, and lets `tier` follow the current author.
function recordRun(runId, { channelId, guildId, tier }, ttlMs) {
  const s = load(ttlMs);
  const prev = s.runs[runId] ?? { sessionId: null, messageIds: [] };
  s.runs[runId] = { ...prev, channelId, guildId, tier, updatedAt: Date.now() };
  s.latestByChannel[channelId] = runId;
  save(s);
}

function recordSession(runId, sessionId, ttlMs) {
  const s = load(ttlMs);
  if (!s.runs[runId]) return;
  s.runs[runId].sessionId = sessionId;
  s.runs[runId].updatedAt = Date.now();
  save(s);
}

// Every bot message we post becomes a handle back onto its run.
function recordMessage(runId, messageId, ttlMs) {
  const s = load(ttlMs);
  const run = s.runs[runId];
  if (!run) return;
  if (!run.messageIds.includes(messageId)) run.messageIds.push(messageId);
  run.updatedAt = Date.now();
  s.byMessage[messageId] = runId;
  save(s);
}

function fresh(s, runId, ttlMs) {
  const run = s.runs[runId];
  return run && Date.now() - run.updatedAt < ttlMs ? { runId, ...run } : null;
}

// Both lookups are TTL-bounded: a cold conversation is not resumed (and, for a
// bare reply, is not even a trigger — ping the bot to start a new one).
function runByMessage(messageId, ttlMs) {
  const s = load(ttlMs);
  const runId = s.byMessage[messageId];
  return runId ? fresh(s, runId, ttlMs) : null;
}

function latestRun(channelId, ttlMs) {
  const s = load(ttlMs);
  const runId = s.latestByChannel[channelId];
  return runId ? fresh(s, runId, ttlMs) : null;
}

module.exports = { load, recordRun, recordSession, recordMessage, runByMessage, latestRun, STATE_FILE };
