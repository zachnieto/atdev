// src/runners/claude.ts — Claude Code harness adapter.
//
// Streams `--output-format stream-json` and translates the raw events into
// normalized ones for the caller: {type:"init",sessionId} / {type:"tool",name,input}
// / {type:"text",text} / {type:"result",isError,text}. Everything
// Claude-specific about the stream shape stays inside this file.

import { spawn, execFile } from "node:child_process";
import type { HarnessConfig } from "../config";
import { log } from "../log";

// Token totals for one run. `input` folds the cache tiers in (cache reads and
// writes are still input tokens someone paid for).
export interface RunUsage {
  input: number;
  output: number;
}

// The normalized adapter contract: any second harness emits these same events.
export type RunnerEvent =
  | { type: "init"; sessionId: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "text"; text: string }
  | { type: "result"; isError: boolean; text: string; usage?: RunUsage; costUsd?: number };

export interface RunOptions {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  resumeId?: string | null;
  tier?: string;
  env?: Record<string, string>;
  addDirs?: string[];
  onEvent?: (ev: RunnerEvent) => void;
  // Handed the kill handle for this run's process tree as soon as it spawns,
  // so the caller can cancel it (same path the timeout uses).
  onSpawn?: (kill: () => void) => void;
}

export interface RunResult {
  code: number | null;
  text: string;
  sessionId: string | null;
  err: string;
  usage?: RunUsage;
  costUsd?: number;
}

// The tier's flags are what actually restrict a chat run — the prompt only
// explains the restriction. `--allowedTools` takes its values greedily, so the
// tier flags must be followed by another flag (they are) and the prompt must go
// in over stdin, never as a positional argument.
export function argv(
  harness: HarnessConfig,
  { tier = "dev", resumeId, addDirs = [] }: { tier?: string; resumeId?: string | null; addDirs?: string[] } = {},
): string[] {
  // harness.args goes first (it is documented as *prepended*), which also lets a
  // test point `command` at an interpreter and `args` at a fake-harness script.
  const args = [
    ...(harness.args ?? []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(harness.tierArgs?.[tier] ?? []),
  ];
  if (resumeId) args.push("--resume", resumeId);
  for (const dir of addDirs) args.push("--add-dir", dir);
  return args;
}

// run({...}) -> {code, text, sessionId, err}
export function run({
  harness,
  cwd,
  prompt,
  resumeId,
  tier = "dev",
  env,
  addDirs = [],
  onEvent,
  onSpawn,
}: RunOptions): Promise<RunResult> {
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
    let usage: RunUsage | undefined;
    let costUsd: number | undefined;
    const emit = (ev: RunnerEvent) => {
      try {
        onEvent?.(ev);
      } catch (e: any) {
        log(`onEvent error: ${e?.message || e}`);
      }
    };
    // Kills the whole tree: the harness spawns tool subprocesses of its own.
    const kill = () => {
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
      else proc.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      log(`TIMEOUT after ${timeoutMs / 60000}min; killing pid ${proc.pid}`);
      kill();
    }, timeoutMs);
    onSpawn?.(kill);
    proc.stdout!.on("data", (d) => {
      buf += String(d);
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: the classic drain-the-buffer line splitter
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
          const u = ev.usage;
          usage = u
            ? {
                input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
                output: u.output_tokens ?? 0,
              }
            : undefined;
          costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
          emit({ type: "result", isError, text, ...(usage && { usage }), ...(costUsd != null && { costUsd }) });
        }
      }
    });
    proc.stderr!.on("data", (d) => (err += String(d)));
    // A harness that never starts (bad harness.command) must fail this run, not
    // the bot: resolve as a failure instead of throwing out of the event loop.
    proc.on("error", (e: any) => {
      clearTimeout(timer);
      log(`Harness spawn failed: ${e?.message || e}`);
      resolve({ code: null, text, sessionId, err: String(e?.message || e) });
    });
    proc.stdin!.on("error", () => {}); // writing to a process that never spawned
    proc.on("close", (code) => {
      clearTimeout(timer);
      // A clean exit without a result event (or a result flagged as error) is a failure.
      const effCode = code !== 0 ? code : sawResult && !isError ? 0 : 1;
      resolve({ code: effCode, text, sessionId, err: err.trim(), usage, costUsd });
    });
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}
