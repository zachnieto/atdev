// A fake Claude Code harness: emits stream-json NDJSON and exits.
//
// Spawned by runner.test.ts as `node test/fixtures/harness.js <the real argv>`,
// so it also proves the argv the adapter built actually reached the process.
// Everything is synchronous: readFileSync(0) blocks until the parent closes
// stdin, so the prompt is always in hand before anything is written.
const fs = require("node:fs");

const prompt = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const out = (s) => fs.writeSync(1, s);

const init = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" });
const assistant = JSON.stringify({
  type: "assistant",
  session_id: "sess-1",
  message: {
    content: [
      { type: "text", text: "thinking out loud" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
      { type: "image", data: "ignored" },
    ],
  },
});
const result = (isError, text) => JSON.stringify({ type: "result", session_id: "sess-2", is_error: isError, result: text });
const echo = JSON.stringify({ prompt, argv });

switch (process.env.FIXTURE_SCENARIO) {
  case "error-result":
    out(`${init}\n${result(true, "the model gave up")}\n`);
    break;
  case "no-result": // a clean exit with no result event is still a failure
    out(`${init}\n${assistant}\n`);
    break;
  case "crash":
    out(`${init}\n`);
    fs.writeSync(2, "  boom: the harness died\n  ");
    process.exit(3);
    break;
  default: {
    // Deliberately ragged: a blank line, junk that is not JSON, an event type
    // the adapter does not know, and one line split across two writes.
    const head = `${init}\n\n{not json at all\n${JSON.stringify({ type: "stream_event", session_id: "sess-1" })}\n${assistant}\n`;
    const tail = `${result(false, echo)}\n`;
    out(head + tail.slice(0, 20));
    sleep(30);
    out(tail.slice(20));
  }
}
process.exit(0);
