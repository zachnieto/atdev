// src/log.ts — timestamped line log to stdout + logs/bot.log.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";

const LOG_FILE = path.join(ROOT, "logs", "bot.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

export function log(...parts: string[]) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}
