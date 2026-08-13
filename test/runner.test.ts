import { CONFIG_FILE, TMP } from "./helpers";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, ROOT } from "../dist/config";
import type { HarnessConfig } from "../dist/config";
import { argv, run } from "../dist/runners/claude";
import type { RunnerEvent } from "../dist/runners/claude";

const harness = loadConfig(CONFIG_FILE).harness;

// ---- argv --------------------------------------------------------------------
test("chat tier: the read-only allow-list survives as separate argv elements", () => {
  const args = argv(harness, { tier: "chat", addDirs: ["D1", "D2"] });
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");

  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
  assert.ok(allowed.includes("Read") && allowed.includes("Bash(git log*)"), "read tools missing");
  assert.ok(allowed.includes("mcp__discord-mcp__read_messages"), "discord read tools missing");
  // `--allowedTools` takes its values greedily, so they must never be comma-joined
  assert.ok(!allowed.some((a) => a.includes(",")), "allowed tools were comma-joined");
  assert.ok(
    !allowed.some((a) => a === "mcp__discord-mcp__*" || a === "mcp__discord-mcp__send_message"),
    "chat tier must not be able to post to Discord directly",
  );
  assert.ok(!allowed.some((a) => ["Edit", "Write", "Bash"].includes(a)), "chat tier must not get write tools");
  assert.deepEqual(args.slice(-4), ["--add-dir", "D1", "--add-dir", "D2"]);
});

test("dev tier: bypass permissions, resume last", () => {
  assert.deepEqual(argv(harness, { tier: "dev", resumeId: "S" }), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    "S",
  ]);
  // the greedy allow-list is always terminated by another flag
  const chatResume = argv(harness, { tier: "chat", resumeId: "S" });
  assert.equal(chatResume.at(-2), "--resume");
});

test("an unknown tier and an empty harness degrade to the bare invocation", () => {
  assert.deepEqual(argv({ command: "claude" }, { tier: "nope" }), ["-p", "--output-format", "stream-json", "--verbose"]);
  // harness.args is prepended, ahead of everything
  assert.deepEqual(argv({ command: "claude", args: ["--foo"] }).slice(0, 2), ["--foo", "-p"]);
});

// ---- stream parsing ----------------------------------------------------------
// `node test/fixtures/harness.js` stands in for the real CLI: same stream-json
// contract, no claude install, no network.
const FIXTURE: HarnessConfig = {
  command: process.execPath,
  args: [path.join(ROOT, "test", "fixtures", "harness.js")],
  timeoutMinutes: 1,
};
const exec = (scenario: string, prompt = "do the thing") => {
  const events: RunnerEvent[] = [];
  return run({
    harness: FIXTURE,
    cwd: TMP,
    prompt,
    env: { FIXTURE_SCENARIO: scenario },
    onEvent: (e) => events.push(e),
  }).then((res) => ({ res, events }));
};

test("a good run: normalized events, last session id wins, junk lines ignored", async () => {
  const { res, events } = await exec("ok", "the prompt\nwith two lines");
  assert.deepEqual(
    events.slice(0, 3),
    [
      { type: "init", sessionId: "sess-1" },
      { type: "text", text: "thinking out loud" },
      { type: "tool", name: "Read", input: { file_path: "/tmp/x" } },
    ],
    "blank/malformed/unknown lines must not produce events",
  );
  assert.equal(events.length, 4);
  const last = events[3];
  assert.ok(last.type === "result" && !last.isError, "the result event must be the last thing emitted");

  assert.equal(res.code, 0);
  assert.equal(res.err, "");
  assert.equal(res.sessionId, "sess-2", "the newest session_id on the stream wins");

  // the fixture echoes what it actually received: the prompt went in over stdin,
  // and the argv the adapter built reached the process intact
  const echo = JSON.parse(res.text);
  assert.equal(echo.prompt, "the prompt\nwith two lines");
  assert.deepEqual(echo.argv, argv(FIXTURE).slice(1));
});

test("a result flagged is_error is a failure even on a clean exit", async () => {
  const { res, events } = await exec("error-result");
  assert.equal(res.code, 1, "exit 0 + is_error must normalize to a failure");
  assert.equal(res.text, "the model gave up");
  assert.deepEqual(events.at(-1), { type: "result", isError: true, text: "the model gave up" });
});

test("a clean exit with no result event at all is a failure", async () => {
  const { res, events } = await exec("no-result");
  assert.equal(res.code, 1);
  assert.equal(res.text, "");
  assert.ok(!events.some((e) => e.type === "result"));
  assert.equal(res.sessionId, "sess-1", "a crashed run is still resumable");
});

test("a nonzero exit keeps its code and carries stderr back", async () => {
  const { res } = await exec("crash");
  assert.equal(res.code, 3);
  assert.equal(res.err, "boom: the harness died");
  assert.equal(res.text, "");
});
