// src/mcp-server.js — in-process Discord MCP server (Streamable HTTP, stateless).
//
// Serves the same 10 read/write Discord tools the saseq/discord-mcp Java
// container exposes today, over the bot's own already-logged-in discord.js
// client. Tool names and arg shapes are a COMPATIBILITY CONTRACT: other
// repos' Claude skills call them by name (mcp__discord-mcp__read_messages
// etc.) and must keep working unmodified through the container -> in-process
// cutover. Implementations are thin discord.js calls; no session state.
//
// Stateless Streamable HTTP: a fresh McpServer + transport per request (see
// the SDK's simpleStatelessStreamableHttp example) on a bare node:http
// server — no Express, no `sessionIdGenerator`.

const http = require("node:http");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ChannelType } = require("discord.js");

function typeName(t) {
  return ChannelType[t] ?? String(t);
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}
function errText(e) {
  return { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true };
}

function fmtAttachments(msg) {
  return msg.attachments.size ? ` [attachments: ${[...msg.attachments.values()].map((a) => a.name).join(", ")}]` : "";
}
function fmtMessage(m) {
  return `[${m.createdAt.toISOString()}] ${m.author.username} (${m.author.id}) msg:${m.id}: ${m.content || "[no text]"}${fmtAttachments(m)}`;
}

// ---- tool implementations (thin discord.js calls) -----------------------------
function registerTools(server, client, defaultGuildId) {
  function resolveGuild(guildId) {
    const id = guildId || defaultGuildId;
    if (!id) throw new Error("guildId is required: bot is in multiple guilds and no default is configured");
    const guild = client.guilds.cache.get(id);
    if (!guild) throw new Error(`Guild ${id} not found — bot is not a member of that guild`);
    return guild;
  }

  server.registerTool(
    "read_messages",
    {
      description: "Read recent messages from a Discord channel",
      inputSchema: {
        channelId: z.string(),
        count: z.string().optional().describe("Number of messages to fetch (1-100)"),
        before: z.string().optional().describe("Message ID: fetch messages before this one"),
        after: z.string().optional().describe("Message ID: fetch messages after this one"),
        around: z.string().optional().describe("Message ID: fetch messages around this one"),
      },
    },
    async ({ channelId, count, before, after, around }) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error(`Channel ${channelId} is not a text channel`);
        const opts = {};
        if (count) opts.limit = Math.max(1, Math.min(100, parseInt(count, 10) || 50));
        if (before) opts.before = before;
        if (after) opts.after = after;
        if (around) opts.around = around;
        const msgs = await channel.messages.fetch(opts);
        const ordered = [...msgs.values()].reverse(); // oldest first
        return text(ordered.length ? ordered.map(fmtMessage).join("\n") : "(no messages)");
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_forum_posts",
    {
      description: "List forum posts (threads) in a Discord forum channel",
      inputSchema: { channelId: z.string(), guildId: z.string().optional() },
    },
    async ({ channelId }) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.threads) throw new Error(`Channel ${channelId} is not a forum channel`);
        const active = await channel.threads.fetchActive();
        const archived = await channel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
        const all = new Map([...active.threads, ...archived.threads]);
        if (!all.size) return text("(no forum posts)");
        const lines = [...all.values()].map(
          (t) =>
            `${t.name} (id: ${t.id}) — created ${t.createdAt?.toISOString() ?? "?"}, ${t.archived ? "archived" : "active"}, messages: ${t.messageCount ?? "?"}`,
        );
        return text(lines.join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      description: "Get attachment metadata from a message (metadata only, no download)",
      inputSchema: { channelId: z.string(), messageId: z.string(), attachmentId: z.string().optional() },
    },
    async ({ channelId, messageId, attachmentId }) => {
      try {
        const channel = await client.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        let atts = [...message.attachments.values()];
        if (attachmentId) atts = atts.filter((a) => a.id === attachmentId);
        if (!atts.length) return text("(no attachments)");
        return text(
          atts
            .map((a) => `${a.name} (id: ${a.id}) — ${a.size} bytes, ${a.contentType || "unknown type"}, url: ${a.url}`)
            .join("\n"),
        );
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a message to a Discord channel",
      inputSchema: { channelId: z.string(), message: z.string() },
    },
    async ({ channelId, message }) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error(`Channel ${channelId} is not a text channel`);
        const sent = await channel.send(message);
        return text(`Sent message ${sent.id} to #${channel.name ?? channelId}`);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "get_user_id_by_name",
    {
      description: "Look up a Discord user's ID by (partial) username or display name",
      inputSchema: { username: z.string(), guildId: z.string().optional() },
    },
    async ({ username, guildId }) => {
      try {
        const guild = resolveGuild(guildId);
        const members = await guild.members.search({ query: username, limit: 5 });
        if (!members.size) return text(`No members found matching "${username}"`);
        return text([...members.values()].map((m) => `${m.user.username} (display: ${m.displayName}) — id: ${m.id}`).join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "get_channel_info",
    {
      description: "Get information about a Discord channel",
      inputSchema: { channelId: z.string(), guildId: z.string().optional() },
    },
    async ({ channelId }) => {
      try {
        const c = await client.channels.fetch(channelId);
        if (!c) throw new Error(`Channel ${channelId} not found`);
        const lines = [
          `name: ${c.name ?? "(dm)"}`,
          `id: ${c.id}`,
          `type: ${typeName(c.type)}`,
          `guildId: ${c.guildId ?? "(none)"}`,
          `parentId: ${c.parentId ?? "(none)"}`,
          `topic: ${c.topic ?? "(none)"}`,
          `nsfw: ${!!c.nsfw}`,
        ];
        return text(lines.join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "find_channel",
    {
      description: "Find channels in a guild by (partial) name",
      inputSchema: { channelName: z.string(), guildId: z.string().optional() },
    },
    async ({ channelName, guildId }) => {
      try {
        const guild = resolveGuild(guildId);
        const needle = channelName.toLowerCase();
        const matches = guild.channels.cache.filter((c) => c.name?.toLowerCase().includes(needle));
        if (!matches.size) return text(`No channels found matching "${channelName}"`);
        return text([...matches.values()].map((c) => `${c.name} (id: ${c.id}, type: ${typeName(c.type)})`).join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_channels",
    {
      description: "List all channels in a guild",
      inputSchema: { guildId: z.string().optional() },
    },
    async ({ guildId }) => {
      try {
        const guild = resolveGuild(guildId);
        const chans = [...guild.channels.cache.values()];
        return text(
          chans.map((c) => `${c.name} (id: ${c.id}, type: ${typeName(c.type)}, parent: ${c.parentId ?? "-"})`).join("\n"),
        );
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "get_server_info",
    {
      description: "Get information about a Discord server (guild)",
      inputSchema: { guildId: z.string().optional() },
    },
    async ({ guildId }) => {
      try {
        const guild = resolveGuild(guildId);
        const full = await guild.fetch();
        const lines = [
          `name: ${full.name}`,
          `id: ${full.id}`,
          `ownerId: ${full.ownerId}`,
          `memberCount: ${full.memberCount}`,
          `createdAt: ${full.createdAt.toISOString()}`,
          `description: ${full.description ?? "(none)"}`,
          `premiumTier: ${full.premiumTier}`,
        ];
        return text(lines.join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_channel_permission_overwrites",
    {
      description: "List permission overwrites on a Discord channel",
      inputSchema: { channelId: z.string(), guildId: z.string().optional() },
    },
    async ({ channelId }) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.permissionOverwrites) throw new Error(`Channel ${channelId} has no permission overwrites`);
        const overwrites = [...channel.permissionOverwrites.cache.values()];
        if (!overwrites.length) return text("(no permission overwrites)");
        const lines = overwrites.map(
          (o) =>
            `${o.type === 0 ? "role" : "member"} ${o.id}: allow=[${o.allow.toArray().join(",")}] deny=[${o.deny.toArray().join(",")}]`,
        );
        return text(lines.join("\n"));
      } catch (e) {
        return errText(e);
      }
    },
  );
}

// ---- HTTP wiring (stateless Streamable HTTP, no Express) ----------------------
// One McpServer + transport per request — stateless transports cannot be
// reused across requests (the SDK throws if you try).
function startMcpServer(client, { host = "127.0.0.1", port = 8086, path: mcpPath = "/mcp", defaultGuildId } = {}) {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== mcpPath) {
      res.writeHead(404).end();
      return;
    }
    const server = new McpServer({ name: "discord-mcp", version: "1.0.0" });
    registerTools(server, client, defaultGuildId);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res); // transport itself routes GET/POST/DELETE
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });
  httpServer.listen(port, host);
  return httpServer;
}

module.exports = { startMcpServer };
