// src/runners/claude.js — Claude Code harness adapter.
//
// Streams `--output-format stream-json` and translates the raw events into
// normalized ones for the caller: {type:"init",sessionId} / {type:"tool",name,input}
// / {type:"text",text} / {type:"result",isError,text}. Everything
// Claude-specific about the stream shape stays inside this file.

const { spawn, execFile } = require("node:child_process");
const { log } = require("../log");

// run({...}) -> {code, text, sessionId, err}
function run({ harness, cwd, prompt, resumeId, tier = "dev", env, addDirs = [], onEvent }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...(harness.args ?? []), ...(harness.tierArgs?.[tier] ?? [])];
    if (resumeId) args.push("--resume", resumeId);
    for (const dir of addDirs) args.push("--add-dir", dir);
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
    let sessionId = null;
    let sawResult = false;
    let isError = false;
    const emit = (ev) => {
      try {
        onEvent?.(ev);
      } catch (e) {
        log(`onEvent error: ${e?.message || e}`);
      }
    };
    const timer = setTimeout(() => {
      log(`TIMEOUT after ${timeoutMs / 60000}min; killing pid ${proc.pid}`);
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
      else proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
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
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      // A clean exit without a result event (or a result flagged as error) is a failure.
      const effCode = code !== 0 ? code : sawResult && !isError ? 0 : 1;
      resolve({ code: effCode, text, sessionId, err: err.trim() });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { run };
