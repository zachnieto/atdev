import { CONFIG_FILE, GUILD, REPO1, REPO2, TMP, USER, writeConfig } from "./helpers";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, ROOT } from "../dist/config";

const bad = (obj: unknown) => {
  const f = path.join(TMP, "bad.json");
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};

test("loads a config and applies defaults", () => {
  const cfg = loadConfig(CONFIG_FILE);
  assert.equal(cfg.lockPort, 47391);
  assert.equal(cfg.replyLimit, 1900);
  assert.equal(cfg.harness.timeoutMinutes, 45);
  assert.deepEqual(Object.keys(cfg.repos), [REPO1, REPO2]);
  assert.equal(cfg.guilds[GUILD].name, "Fixture Server");
  assert.equal(cfg.access[0].user, USER);
});

test("defaults fill in for keys the file omits", () => {
  const file = writeConfig({}, "minimal.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["sessionTtlHours", "replyLimit", "maxReplyMessages", "lockPort", "backscrollCount", "replyChainMax"])
    delete raw[k];
  fs.writeFileSync(file, JSON.stringify(raw));
  const cfg = loadConfig(file);
  assert.equal(cfg.sessionTtlHours, 6);
  assert.equal(cfg.replyLimit, 1900);
  assert.equal(cfg.maxReplyMessages, 8);
  assert.equal(cfg.lockPort, 47391);
  assert.equal(cfg.backscrollCount, 10);
  assert.equal(cfg.replyChainMax, 5);
});

test("absolute paths pass through byte-identical; relative ones resolve against ROOT", () => {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const cfg = loadConfig(CONFIG_FILE);
  assert.equal(cfg.repos[REPO1].path, raw.repos[REPO1].path, "absolute repo path was rewritten");

  const rel = writeConfig({ workspaceDir: "./workspace" }, "rel.json");
  assert.equal(loadConfig(rel).workspaceDir, path.resolve(ROOT, "./workspace"));
});

test("rejects every unusable config", () => {
  assert.throws(() => loadConfig(path.join(TMP, "nope.json")), /config not found/);

  fs.writeFileSync(path.join(TMP, "syntax.json"), "{nope");
  assert.throws(() => loadConfig(path.join(TMP, "syntax.json")), /not valid JSON/);

  assert.throws(() => loadConfig(bad({})), /repos is empty/);
  assert.throws(() => loadConfig(bad({ repos: { a: { base: "x" } } })), /repos\.a\.path is missing/);
  assert.throws(() => loadConfig(bad({ repos: { a: { path: path.join(TMP, "gone"), base: "x" } } })), /does not exist/);
  assert.throws(() => loadConfig(bad({ repos: { a: { path: ROOT } } })), /repos\.a\.base is missing/);
  assert.throws(() => loadConfig(bad({ repos: { a: { path: ROOT, base: "x" } } })), /guilds is empty/);
  assert.throws(
    () => loadConfig(bad({ repos: { a: { path: ROOT, base: "x" } }, guilds: { g: {} } })),
    /guilds\.g\.name is missing/, // "undefined" would land verbatim in prompts and /status
  );
  assert.throws(
    () => loadConfig(bad({ repos: { a: { path: ROOT, base: "x" } }, guilds: { g: { name: "G", repos: ["b"] } } })),
    /unknown repo "b"/,
  );
  assert.throws(
    () => loadConfig(bad({ repos: { a: { path: ROOT, base: "x" } }, guilds: { g: { name: "G", repos: ["a"] } } })),
    /access is empty/,
  );
  assert.throws(
    () =>
      loadConfig(
        bad({
          repos: { a: { path: ROOT, base: "x" } },
          guilds: { g: { name: "G" } },
          access: [{ user: "u" }],
          harness: { command: "c" },
        }),
      ),
    /missing a tier/,
  );
  assert.throws(
    () => loadConfig(bad({ repos: { a: { path: ROOT, base: "x" } }, guilds: { g: { name: "G" } }, access: [{ tier: "dev" }] })),
    /harness\.command is missing/,
  );
});
