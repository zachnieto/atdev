# atdev

A mention-driven Discord bot that acts as a dev-team teammate: @mention it with a
request and it spawns a headless [Claude Code](https://docs.claude.com/en/docs/claude-code)
run against the right repo, replies in the thread, and cleans up after itself. Access
is tiered per user/role/channel (`dev` can edit and open PRs, `chat` is read-only),
each dev run works in its own disposable git worktree so parallel requests never
collide, and the bot exposes a small built-in Discord MCP server so an agent — this
bot's own runs, or any other local Claude Code session — can read/post to Discord as
a tool.

## Quick start

```
git clone <this repo>
cd atdev
npm install
cp .env.example .env            # fill in DISCORD_TOKEN
cp config.example.json config.json   # fill in repos, guilds, access
npm start
```

**Discord application setup** (Discord Developer Portal):
- Bot → Privileged Gateway Intents: enable **Message Content**.
- Gateway intents the bot requests at login: `Guilds`, `GuildMessages`, `MessageContent`.
- OAuth2 → URL Generator → scope **bot**, permissions **Send Messages**, **Read Message
  History**, **Add Reactions**. Use the generated URL to invite the bot to your server.

**Harness**: install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)
and make sure `claude` is on `PATH` (or point `harness.command` in `config.json` at its
full path) and you're logged in.

Then `npm start` (or run `node index.js` directly). The bot logs its Discord login and
the MCP server's listen address to `logs/bot.log`.

**TypeScript**: the source is TypeScript in `src/`; `tsc` compiles it to CommonJS in
`dist/` (gitignored), which is what actually runs — `index.js` at the root is a shim
onto `dist/index.js`. `npm install` builds via the `prepare` script, so a fresh clone
is ready to `npm start`; after editing `src/`, run `npm run build`.

## Concepts

**Tiers.** Every message that triggers a run resolves to a tier via `config.access`:
`dev` gets `--permission-mode bypassPermissions` (can edit, run shell, push, open PRs);
`chat` gets an allow-list of read-only tools (`Read`, `Grep`, read-only `Bash(git ...)`,
read-only Discord MCP tools) — no `Edit`/`Write`/`Bash` general shell. The restriction
is enforced by the harness's own CLI flags, not by asking the model nicely.

**Work orders vs. follow-ups.** A run starts when someone @mentions the bot, or
replies (unpinged) to one of the bot's own messages from a still-live run — the reply
chain *is* the conversation. A bare re-mention in the same channel resumes that
channel's most recent run if it's still within `sessionTtlHours`; otherwise it starts
fresh. A follow-up always runs at the *replying* user's tier, even if the original run
was a different tier.

**Repos manifest + self-routing worktrees.** `config.repos` lists every repo the bot
knows about, and `config.guilds.<id>.repos` scopes which of them a given Discord
server offers. A dev run is handed the manifest (path/base/description/notes per
repo) and picks which repo(s) the request concerns itself — for anything it's going
to *edit*, it calls `node dist/worktrees.js create <repo-name>` first, which fetches,
creates a fresh `git worktree` on a new branch off that repo's configured base, and
hands back the path. All edits happen inside that worktree; the shared checkout in
the manifest is read-only. The bot removes the worktree on a successful run and keeps
it (marked failed) for inspection otherwise; a sweep at startup and hourly reaps
anything past `worktreeTtlHours` or orphaned by a crash.

**Built-in Discord MCP server.** The bot serves a small Streamable HTTP MCP server
(`src/mcp-server.ts`) over its own already-logged-in discord.js client — no separate
process or container. It exposes 9 read tools plus `send_message`, under the server
key `discord-mcp` (compatibility contract: tool names/args must not change, since
other repos' Claude configs already call them). To point an external Claude Code
session at it, add to that repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8085/mcp"
    }
  }
}
```

## Config reference

`config.json` (gitignored, machine-local; copy from `config.example.json`):

- `workspaceDir` — root for dev-run worktrees and scratch space (default `./workspace`).
- `harness.type` — harness adapter to use; only `"claude"` exists today.
- `harness.command` — the CLI executable (`"claude"` if on `PATH`, or a full path).
- `harness.args` — extra argv prepended to every run, before tier flags.
- `harness.tierArgs.chat` — argv appended for `chat`-tier runs (permission mode + allow-list).
- `harness.tierArgs.dev` — argv appended for `dev`-tier runs (permission mode).
- `harness.timeoutMinutes` — kill the harness process after this long.
- `mcp.port` / `mcp.host` / `mcp.path` — where the built-in Discord MCP server listens.
- `mcp.defaultGuildId` — guild ID assumed when an MCP tool call omits `guildId` (only needed if the bot is in more than one guild).
- `repos.<name>.path` — absolute path to that repo's checkout.
- `repos.<name>.base` — the git ref new worktrees branch from (e.g. `origin/main`).
- `repos.<name>.description` — when-to-use guidance the agent routes on.
- `repos.<name>.notes` — that repo's conventions (PR target, lint gate, etc.), shown to dev runs.
- `guilds.<id>.name` — display name for the guild, used in logs and prompts.
- `guilds.<id>.repos` — which `repos` this guild offers (omit for "all of them").
- `access` — ordered list of rules; first match wins, no match = silently ignored. Each rule may key on `user`/`role`/`guild`/`channel` (a channel rule also matches its threads), all present keys must match, and it must set a `tier`. `everyone: true` on a rule is documentation only — a rule with no identity key already matches anyone.
- `workflowNotes` — free-text operator instructions (e.g. issue-tracker conventions) injected into dev-run prompts.
- `sessionTtlHours` — how long a run stays resumable via mention/reply.
- `worktreeTtlHours` — how long a worktree survives before the sweep reclaims it.
- `backscrollCount` — channel messages fetched for ambient context on a fresh run.
- `replyChainMax` — how far up a Discord reply chain to walk for context.
- `replyLimit` — max characters per posted Discord message (Discord's hard cap is 2000).
- `maxReplyMessages` — cap on how many `<reply>` blocks/chunks get posted per run.
- `maxConcurrentRuns` — global cap on harness processes running at once; excess runs queue FIFO.
- `lockPort` — localhost TCP port used as a singleton lock (a second launch exits immediately).

`.env` (gitignored): `DISCORD_TOKEN` is the only secret.

## Prompt customization

The prompt templates live in `prompts/` and are filled with placeholders like
`{CONTENT}`, `{CONTEXT}`, `{REPOS_MANIFEST}`, `{WORKFLOW_NOTES}` (see `src/runs.ts`'s
`fill()` for the full list):

- `prompts/work-order.md` — fresh `dev`-tier run: routing, worktree/PR rules, reply contract.
- `prompts/chat.md` — fresh `chat`-tier run: read-only teammate, same reply contract.
- `prompts/follow-up.md` — resumed run of either tier (leaner; the session already has context).

Operator-specific process (issue tracker conventions, PR checklist, whatever) belongs
in `config.workflowNotes`, not baked into the templates — it's config, not code, and
it's the one thing dev runs get that chat runs don't.

## Security model

- **Access rules run before any AI does.** `src/triggers.ts` checks `config.access`
  against the message *before* a harness process is ever spawned; an unmatched user
  gets a log line and nothing else.
- **Tier restriction is enforced by the harness's own flags** (`--permission-mode`,
  `--allowedTools`), not by prompt instructions — a `chat`-tier prompt can say "you
  can't edit files" but it's the CLI flags that actually block the attempt.
- **The MCP server binds `127.0.0.1` by default** — it's reachable only from the same
  machine, including by other local Claude Code sessions that add it to `.mcp.json`.
- **Secrets live only in `.env`** (`DISCORD_TOKEN`); `config.json`, `state/`, `logs/`,
  and `workspace/` are all gitignored since they're machine-local.

## Platform notes

Developed and run Windows-first: the timeout kill path uses `taskkill /T /F`, and
worktree removal retries on `EBUSY` (Windows can hold file handles open briefly after
a process exits). A POSIX kill path (`SIGKILL`) exists in `src/runners/claude.ts` for
other platforms but is less exercised. For autostart on Windows, use a `.cmd` that
`cd`s into the repo and runs `node index.js` (appending stdout to a log), wrapped in
a `.vbs` one-liner that launches it hidden (no console flash) — point Task Scheduler
at the `.vbs`. The bot's own singleton lock (`config.lockPort`) makes re-triggering
that launcher harmless.

## Adding a second harness

Harnesses are an adapter seam, not a plugin system. `src/runners/claude.ts` is the
whole contract: a `run({harness, cwd, prompt, resumeId, tier, env, addDirs, onEvent})`
function returning `{code, text, sessionId, err}`, where `onEvent` receives normalized
events (`{type: "init", sessionId}`, `{type: "tool", name, input}`,
`{type: "text", text}`, `{type: "result", isError, text}`) as the run progresses.
Everything specific to Claude Code's `stream-json` output format stays inside that one
file. `config.harness.type` already distinguishes harnesses in the config schema, but
`src/runs.ts` currently imports `./runners/claude` directly rather than dispatching on
it. To add a second harness: write `src/runners/<name>.ts` implementing the same
contract, then switch that import in `src/runs.ts` to pick the module based on
`config.harness.type`.
