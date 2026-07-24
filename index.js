// neatz-bot — Discord mention listener that triggers headless Claude Code runs.
//
// Flow: NeatZ (and ONLY NeatZ, matched by user ID) @mentions the bot in a mapped
// guild -> react 👀 -> spawn `claude -p` in that guild's repo with a work-order
// prompt (beads-first, PR flow) -> post Claude's final message as the reply.
// Mentions from anyone else are ignored silently, before any AI is in the loop.

require("dotenv").config();
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const NEATZ_ID = "145305657237700608";
const CLAUDE_EXE = "C:\\Users\\zachn\\.local\\bin\\claude.exe";
const LOCK_PORT = 47391; // singleton guard: second instance exits immediately
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const REPLY_LIMIT = 1900; // Discord hard cap is 2000 chars

// guild ID -> project wiring. Add new projects here (repo must have a beads board).
const PROJECTS = {
  "505102060119916545": {
    name: "NeatQueue",
    repo: "C:/Users/zachn/IdeaProjects/neatqueue",
    prNote:
      "PRs target `develop` on zachnieto/neatqueue (`gh pr create --base develop`). Deployed paths `/neatqueue/...` map to local `discord-bot/`.",
    base: "origin/develop",
  },
  "700622160992927774": {
    name: "Breaking Point",
    repo: "C:/Users/zachn/IdeaProjects/breaking-point",
    prNote:
      "Monorepo Breaking-Point/breaking-point (`gh pr create --repo Breaking-Point/breaking-point`). Biome is the lint gate; `yarn typecheck` has pre-existing failures and is not blocking.",
    base: "the default branch",
  },
};

const LOG_FILE = path.join(__dirname, "logs", "bot.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ---- bundled discord-mcp container ------------------------------------------
// neatz-bot is the single entry point: it ensures the local discord-mcp
// container (saseq/discord-mcp on 127.0.0.1:8085, --restart unless-stopped)
// is running. Docker supervises the container after that; we just kick it at
// startup and retry while Docker Desktop is still coming up after a reboot.
const MCP_CONTAINER = "neatz-discord-mcp";
function ensureMcpContainer(attempt = 0) {
  execFile("docker", ["start", MCP_CONTAINER], { windowsHide: true }, (err) => {
    if (!err) {
      log(`discord-mcp container '${MCP_CONTAINER}' running (http://127.0.0.1:8085/mcp)`);
      return;
    }
    if (attempt < 30) {
      // Docker Desktop can take a while after logon; retry every 20s for ~10min.
      if (attempt === 0) log(`docker not ready yet; retrying container start (${err.message.split("\n")[0]})`);
      setTimeout(() => ensureMcpContainer(attempt + 1), 20_000);
    } else {
      log(`GAVE UP starting discord-mcp container after ${attempt} attempts — MCP tools will be unavailable until Docker is up.`);
    }
  });
}

// ---- singleton lock ---------------------------------------------------------
const lock = net.createServer();
lock.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("neatz-bot already running; exiting.");
    process.exit(0);
  }
  throw err;
});
lock.listen(LOCK_PORT, "127.0.0.1", () => {
  ensureMcpContainer();
  startBot();
});

// ---- per-repo serialization (two mentions must not race on git state) --------
const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job); // run regardless of prior job's outcome
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// ---- work order -------------------------------------------------------------
const TEMPLATE = fs.readFileSync(path.join(__dirname, "work-order.md"), "utf8");
function buildPrompt(project, message) {
  const permalink = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  return TEMPLATE.replaceAll("{PROJECT}", project.name)
    .replaceAll("{REPO}", project.repo)
    .replaceAll("{PR_NOTE}", project.prNote)
    .replaceAll("{BASE}", project.base)
    .replaceAll("{CHANNEL}", message.channel?.name ?? message.channelId)
    .replaceAll("{PERMALINK}", permalink)
    .replaceAll("{CONTENT}", message.content);
}

function runClaude(project, prompt) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_EXE, ["-p", "--output-format", "text"], {
      cwd: project.repo,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      log(`TIMEOUT after ${RUN_TIMEOUT_MS / 60000}min; killing pid ${proc.pid}`);
      execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
    }, RUN_TIMEOUT_MS);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---- bot --------------------------------------------------------------------
function startBot() {
  const client = new Client({
    // Message content is exempt from the privileged intent for messages that
    // mention the bot — which is exactly and only what we act on.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once(Events.ClientReady, (c) => log(`Logged in as ${c.user.tag} (${c.user.id})`));

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.inGuild() || message.author.bot) return;
      if (!message.mentions.users.has(client.user.id)) return; // direct @mention only (not @everyone/@role)
      const project = PROJECTS[message.guildId];
      if (!project) return;
      if (message.author.id !== NEATZ_ID) {
        // Hard authorization gate: everyone else is ignored before any AI runs.
        log(`Ignored mention from non-NeatZ user ${message.author.id} in ${project.name}`);
        return;
      }

      log(`Work order from NeatZ in ${project.name}#${message.channel?.name}: ${message.content.slice(0, 200)}`);
      await message.react("👀").catch(() => {});

      await enqueue(project.repo, async () => {
        const started = Date.now();
        const { code, out, err } = await runClaude(project, buildPrompt(project, message));
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        log(`Run finished in ${mins}min (exit ${code}) for message ${message.id}`);

        let reply;
        if (code === 0 && out) {
          reply = out.length > REPLY_LIMIT ? out.slice(0, REPLY_LIMIT) + "\n…(truncated)" : out;
          await message.react("✅").catch(() => {});
        } else {
          log(`Run error output: ${(err || out).slice(0, 500)}`);
          reply = `⚠️ The agent run failed (exit ${code}). Check the board and \`neatz-bot\` logs on the host machine.`;
          await message.react("❌").catch(() => {});
        }
        await message.reply({ content: reply, allowedMentions: { repliedUser: true } });
      });
    } catch (e) {
      log(`Handler error: ${e?.stack || e}`);
      await message.react("❌").catch(() => {});
    }
  });

  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    log(`Login failed: ${e?.message || e}`);
    process.exit(1);
  });
}
