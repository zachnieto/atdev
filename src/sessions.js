// src/sessions.js — per-channel session store (for --resume continuity).
// Schema: {channelId: {sessionId, updatedAt}}. Reply-chain keying is Phase 3.

const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./config");

const STATE_FILE = path.join(ROOT, "state", "sessions.json");
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSession(channelId, sessionId) {
  const s = loadSessions();
  s[channelId] = { sessionId, updatedAt: Date.now() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function resumableSession(channelId, ttlMs) {
  const e = loadSessions()[channelId];
  return e && Date.now() - e.updatedAt < ttlMs ? e.sessionId : null;
}

module.exports = { loadSessions, saveSession, resumableSession };
