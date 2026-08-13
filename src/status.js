// src/status.js — live status message + tool-use descriptions.
//
// One Discord message per run, edited in place: a header (state + elapsed +
// tool count) over a code-block tail of recent activity. Edits are throttled
// and skipped when nothing changed.

const { DEFAULTS } = require("./config");
const { log } = require("./log");

function fmtElapsed(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}

class StatusReporter {
  constructor(message, cfg = DEFAULTS) {
    this.message = message;
    this.cfg = cfg;
    this.statusMsg = null;
    this.lines = [];
    this.toolCount = 0;
    this.started = Date.now();
    this.header = "🔄 **Working**";
    this.done = false;
    this.dirty = false;
    this.timer = null;
    this.lastEditAt = 0;
    this.lastContent = "";
  }

  async start() {
    try {
      this.statusMsg = await this.message.reply({ content: this.render(), allowedMentions: { repliedUser: false } });
    } catch (e) {
      log(`Status message create failed: ${e?.message || e}`);
    }
    // Heartbeat so the elapsed time ticks even during long silent tool calls.
    this.heartbeat = setInterval(() => {
      if (!this.done) this.markDirty();
    }, 30_000);
  }

  note(line) {
    if (!line) return;
    const stamp = fmtElapsed(Date.now() - this.started);
    this.lines.push(`[${stamp.padStart(3)}] ${line}`.slice(0, 130));
    if (this.lines.length > this.cfg.statusTail) this.lines.splice(0, this.lines.length - this.cfg.statusTail);
    this.markDirty();
  }

  tool(line) {
    this.toolCount++;
    this.note(line);
  }

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.lastEditAt + this.cfg.statusEditMinMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, wait);
  }

  render() {
    const head = `${this.header} — ${fmtElapsed(Date.now() - this.started)} · ${this.toolCount} tool uses`;
    if (!this.lines.length) return head;
    const tail = this.lines.map((l) => l.replaceAll("```", "'''")).join("\n");
    return `${head}\n\`\`\`\n${tail}\n\`\`\``.slice(0, this.cfg.replyLimit);
  }

  async flush() {
    if (!this.statusMsg || !this.dirty) return;
    this.dirty = false;
    const content = this.render();
    if (content === this.lastContent) return;
    this.lastContent = content;
    this.lastEditAt = Date.now();
    try {
      await this.statusMsg.edit(content);
    } catch (e) {
      log(`Status edit failed: ${e?.message || e}`);
    }
  }

  async finish(header) {
    this.done = true;
    this.header = header;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.dirty = true;
    await this.flush();
  }
}

// Compact one-line description of a tool use for the status tail.
function describeToolUse(name, input = {}) {
  const clip = (s, n = 100) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  switch (name) {
    case "Bash":
    case "PowerShell":
      return `$ ${clip(input.description || input.command)}`;
    case "Read":
      return `read  ${clip(input.file_path)}`;
    case "Edit":
      return `edit  ${clip(input.file_path)}`;
    case "Write":
      return `write ${clip(input.file_path)}`;
    case "NotebookEdit":
      return `edit  ${clip(input.notebook_path)}`;
    case "Grep":
      return `grep  ${clip(input.pattern)}`;
    case "Glob":
      return `glob  ${clip(input.pattern)}`;
    case "Task":
    case "Agent":
      return `agent ${clip(input.description || input.prompt)}`;
    case "WebFetch":
      return `fetch ${clip(input.url)}`;
    case "WebSearch":
      return `search ${clip(input.query)}`;
    case "Skill":
      return `skill /${clip(input.skill || input.command)}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return null; // bookkeeping noise
    default:
      return name.startsWith("mcp__") ? `mcp   ${clip(name.replace(/^mcp__/, ""))}` : clip(name);
  }
}

module.exports = { StatusReporter, describeToolUse, fmtElapsed };
