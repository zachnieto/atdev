import { TMP } from "./helpers";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { attachmentsDir, cleanup, collect, MAX_BYTES, MAX_FILES, render, safeName, save } from "../dist/attachments";
import type { AttachmentLike } from "../dist/attachments";
import { sweep } from "../dist/worktrees";

// A local file server stands in for the Discord CDN: real fetch, real bytes, no
// network beyond loopback.
const server = http.createServer((req, res) => {
  if (req.url === "/boom") {
    res.writeHead(404);
    res.end("gone");
    return;
  }
  res.writeHead(200);
  res.end(req.url === "/big" ? Buffer.alloc(MAX_BYTES + 1) : Buffer.from(`bytes for ${req.url}`));
});
let BASE = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  BASE = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const at = (name: string, over: Partial<AttachmentLike> = {}): AttachmentLike => ({
  url: `${BASE}/${encodeURIComponent(name)}`,
  name,
  size: 20,
  contentType: "text/plain",
  ...over,
});
let n = 0;
const freshDir = () => path.join(TMP, "att", `run${n++}`);

// ---- naming ------------------------------------------------------------------
test("safeName keeps a filename and nothing else", () => {
  assert.equal(safeName("shot.png"), "shot.png");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Windows\\evil.exe"), "evil.exe");
  assert.equal(safeName("sub/dir/report.pdf"), "report.pdf");
  assert.equal(safeName(".."), "file");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("a?b*c.txt"), "a_b_c.txt", "Windows-illegal characters are replaced");
});

// ---- downloading -------------------------------------------------------------
test("save downloads into the run's own directory, colliding names get a suffix", async () => {
  const dir = freshDir();
  const { files, notes } = await save([at("a.txt"), at("a.txt"), at("../a.txt")], dir);
  assert.deepEqual(notes, []);
  assert.deepEqual(
    files.map((f) => path.basename(f.path)),
    ["a.txt", "a-2.txt", "a-3.txt"],
  );
  assert.ok(
    files.every((f) => path.dirname(f.path) === dir && f.name && f.contentType === "text/plain"),
    "saved files keep their original name and content type",
  );
  assert.equal(fs.readFileSync(files[0].path, "utf8"), "bytes for /a.txt");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a-2.txt", "a-3.txt", "a.txt"]);
});

test("attachmentsDir is per-run, under the workspace", () => {
  assert.equal(attachmentsDir("/ws", "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb"), path.join("/ws", "attachments", "abcdef12"));
});

test("oversized, broken and surplus files are skipped with a note, never fatal", async () => {
  const dir = freshDir();
  const { files, notes } = await save(
    [
      at("huge.zip", { size: 25 * 1024 * 1024 }),
      at("liar.bin", { url: `${BASE}/big` }),
      at("gone.txt", { url: `${BASE}/boom` }),
      at("ok.txt"),
    ],
    dir,
  );
  assert.deepEqual(
    files.map((f) => f.name),
    ["ok.txt"],
    "the good file still made it",
  );
  assert.deepEqual(notes, [
    "skipped huge.zip: 25.0MB > 10.0MB cap",
    "skipped liar.bin: 10.0MB > 10.0MB cap",
    "skipped gone.txt: download failed (HTTP 404)",
  ]);
  assert.deepEqual(fs.readdirSync(dir), ["ok.txt"], "nothing skipped was left on disk");
});

test("the file-count cap takes the first MAX_FILES and notes the rest", async () => {
  const dir = freshDir();
  const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => at(`f${i}.txt`));
  const { files, notes } = await save(many, dir);
  assert.equal(files.length, MAX_FILES);
  assert.deepEqual(notes, [`skipped 3 more file(s): ${MAX_FILES}-file cap`]);
});

test("no attachments means no directory and no prompt section", async () => {
  const dir = freshDir();
  const saved = await save([], dir);
  assert.deepEqual(saved, { files: [], notes: [] });
  assert.ok(!fs.existsSync(dir), "an empty run created a directory anyway");
  assert.equal(render(saved), "");
});

test("render lists local path, original name and content type, plus the skip notes", async () => {
  const dir = freshDir();
  const saved = await save([at("shot.png", { contentType: "image/png" }), at("huge.zip", { size: 25 * 1024 * 1024 })], dir);
  const out = render(saved);
  assert.ok(out.includes(path.join(dir, "shot.png")), "local path missing");
  assert.ok(out.includes('original name "shot.png"') && out.includes("(image/png)"));
  assert.ok(out.includes("- skipped huge.zip: 25.0MB > 10.0MB cap"));
});

// ---- what gets collected -----------------------------------------------------
test("collect takes the message's files and the reply target's, not the backscroll", async () => {
  const target = { attachments: new Map([["1", at("from-reply.png")]]) } as any;
  const other = { attachments: new Map([["2", at("from-backscroll.png")]]) } as any;
  const message = {
    attachments: new Map([["3", at("from-mention.png")]]),
    reference: { messageId: "T" },
    channel: { messages: { fetch: async (id: string) => (id === "T" ? target : other) } },
  } as any;
  assert.deepEqual(
    (await collect(message)).map((a) => a.name),
    ["from-mention.png", "from-reply.png"],
  );

  // a plain mention: just its own files
  assert.deepEqual(
    (await collect({ ...message, reference: undefined })).map((a) => a.name),
    ["from-mention.png"],
  );
  // an unfetchable reply target must not lose the mention's own files
  const broken = {
    ...message,
    channel: {
      messages: {
        fetch: async () => {
          throw new Error("no access");
        },
      },
    },
  };
  assert.deepEqual(
    (await collect(broken as any)).map((a) => a.name),
    ["from-mention.png"],
  );
});

// ---- lifecycle ---------------------------------------------------------------
test("a successful run's files are deleted, a failed run's are kept", async () => {
  const dir = freshDir();
  await save([at("a.txt")], dir);
  cleanup(dir, false);
  assert.ok(fs.existsSync(dir), "a failed run lost its files");
  cleanup(dir, true);
  assert.ok(!fs.existsSync(dir), "a successful run left its files behind");
  cleanup(dir, true); // already gone: still a no-op
});

test("sweep reaps attachment dirs past the TTL and spares fresh ones", async () => {
  const ws = path.join(TMP, "sweep-ws");
  const cfg = { workspaceDir: ws, worktreeTtlHours: 24, repos: {} };
  const old = path.join(ws, "attachments", "old00000");
  const live = path.join(ws, "attachments", "live0000");
  for (const d of [old, live]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "x");
  }
  const ago = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(old, ago, ago);

  sweep(cfg);
  assert.ok(!fs.existsSync(old), "expired attachments survived the sweep");
  assert.ok(fs.existsSync(live), "sweep ate a live run's attachments");

  sweep({ ...cfg, workspaceDir: path.join(TMP, "never-created") }); // no workspace: no-op
});
