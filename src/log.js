// src/log.js — timestamped line log to stdout + logs/bot.log.

const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./config");

const LOG_FILE = path.join(ROOT, "logs", "bot.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

module.exports = { log };
