// src/runners/claude.ts — Claude Code harness adapter.
//
// Streams `--output-format stream-json` and translates the raw events into
// normalized ones for the caller: {type:"init",sessionId} / {type:"tool",name,input}
// / {type:"text",text} / {type:"result",isError,text}. Everything
// Claude-specific about the stream shape stays inside this file.

import { spawn, execFile } from "node:child_process";
import { HarnessConfig } from "../config";
import { log } from "../log";

// The normalized adapter contract: any second harness emits these same events.
export type RunnerEvent =
  | { type: "init"; sessionId: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "text"; text: string }
  | { type: "result"; isError: boolean; text: string };

export interface RunOptions {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  resumeId?: string | null;
  tier?: string;
  env?: Record<string, string>;
  addDirs?: string[];
  onEvent?: (ev: RunnerEvent) => void;
}

export interface RunResult {
  code: number | null;
  text: string;
  sessionId: string | null;
  err: string;
}

// The tier's flags are what actually restrict a chat run — the prompt only
// explains the restriction. `--allowedTools` takes its values greedily, so the
// tier flags must be followed by another flag (they are) and the prompt must go
// in over stdin, never as a positional argument.
export function argv(
  harness: HarnessConfig,
  { tier = "dev", resumeId, addDirs = [] }: { tier?: string; resumeId?: string | null; addDirs?: string[] } = {},
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...(harness.args ?? []), ...(harness.tierArgs?.[tier] ?? [])];
  if (resumeId) args.push("--resume", resumeId);
  for (const dir of addDirs) args.push("--add-dir", dir);
  return args;
}

// run({...}) -> {code, text, sessionId, err}
export function run({ harness, cwd, prompt, resumeId, tier = "dev", env, addDirs = [], onEvent }: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = argv(harness, { tier, resumeId, addDirs });
    const timeoutMs = (harness.timeoutMinutes ?? 45) * 60 * 1000;
    const proc = spawn(harness.command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let buf = "";
    let err = "";
    let text = "";
    let sessionId: string | null = null;
    let sawResult = false;
    let isError = false;
    const emit = (ev: RunnerEvent) => {
      try {
        onEvent?.(ev);
      } catch (e: any) {
        log(`onEvent error: ${e?.message || e}`);
      }
    };
    const timer = setTimeout(() => {
      log(`TIMEOUT after ${timeoutMs / 60000}min; killing pid ${proc.pid}`);
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
      else proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout!.on("data", (d) => {
      buf += String(d);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === "system" && ev.subtype === "init" && ev.session_id) emit({ type: "init", sessionId: ev.session_id });
        if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_use") emit({ type: "tool", name: block.name, input: block.input });
            else if (block.type === "text") emit({ type: "text", text: block.text });
          }
        }
        if (ev.type === "result") {
          sawResult = true;
          isError = !!ev.is_error;
          text = String(ev.result ?? "").trim();
          emit({ type: "result", isError, text });
        }
      }
    });
    proc.stderr!.on("data", (d) => (err += String(d)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      // A clean exit without a result event (or a result flagged as error) is a failure.
      const effCode = code !== 0 ? code : sawResult && !isError ? 0 : 1;
      resolve({ code: effCode, text, sessionId, err: err.trim() });
    });
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}
