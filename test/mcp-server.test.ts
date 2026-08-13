// The 10 Discord MCP tools, over a structural fake of discord.js and a real
// Streamable HTTP round trip on an ephemeral port (never 8085 — production owns
// that one). Tool names and arg shapes are a compatibility contract: other
// repos' Claude configs call them by name.
import { CHANNEL, GUILD, USER } from "./helpers";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChannelType, Collection } from "discord.js";
import type { Client } from "discord.js";
import { startMcpServer } from "../dist/mcp-server";

const TEXT_CHANNEL = CHANNEL;
const FORUM_CHANNEL = "400000000000000005";
const VOICE_CHANNEL = "400000000000000006";
const CATEGORY = "400000000000000007";

const att = (id: string, name: string, size: number, contentType: string | null) => ({
  id,
  name,
  size,
  contentType,
  url: `https://cdn.example/${id}/${name}`,
});
const msg = (id: string, username: string, authorId: string, content: string, attachments: unknown[] = []) => ({
  id,
  content,
  createdAt: new Date(`2024-05-0${id}T00:00:00.000Z`),
  author: { username, id: authorId },
  attachments: new Collection(attachments.map((a: any) => [a.id, a])),
});

// Newest first, the way Discord returns history.
const HISTORY = [
  msg("3", "ada", USER, "and one with a file", [att("A1", "diff.patch", 1234, "text/plain")]),
  msg("2", "somebot", "888", ""),
  msg("1", "ada", USER, "first message"),
];

const textChannel: any = {
  id: TEXT_CHANNEL,
  name: "general",
  type: ChannelType.GuildText,
  guildId: GUILD,
  parentId: CATEGORY,
  topic: "the main channel",
  nsfw: false,
  isTextBased: () => true,
  lastFetch: null as any,
  messages: {
    fetch: async (arg: any) => {
      if (typeof arg === "string") {
        const found = HISTORY.find((m) => m.id === arg);
        if (!found) throw new Error(`Unknown Message ${arg}`);
        return found;
      }
      textChannel.lastFetch = arg;
      return new Collection(HISTORY.map((m) => [m.id, m]));
    },
  },
  send: async (content: string) => ({ id: `sent-${content.length}` }),
  permissionOverwrites: {
    cache: new Collection<string, any>([
      ["role-1", { id: "role-1", type: 0, allow: { toArray: () => ["ViewChannel"] }, deny: { toArray: () => [] } }],
      ["mem-1", { id: "mem-1", type: 1, allow: { toArray: () => [] }, deny: { toArray: () => ["SendMessages"] } }],
    ]),
  },
};

const forumChannel: any = {
  id: FORUM_CHANNEL,
  name: "forum-help",
  type: ChannelType.GuildForum,
  guildId: GUILD,
  parentId: null,
  isTextBased: () => false,
  threads: {
    fetchActive: async () => ({
      threads: new Collection<string, any>([
        [
          "t1",
          { id: "t1", name: "live post", createdAt: new Date("2024-05-01T00:00:00.000Z"), archived: false, messageCount: 4 },
        ],
      ]),
    }),
    fetchArchived: async () => {
      throw new Error("missing permission"); // the tool must degrade to active-only
    },
  },
};

const voiceChannel: any = {
  id: VOICE_CHANNEL,
  name: "general-voice",
  type: ChannelType.GuildVoice,
  guildId: GUILD,
  parentId: null,
  isTextBased: () => false,
};

const channels = new Collection<string, any>([
  [TEXT_CHANNEL, textChannel],
  [FORUM_CHANNEL, forumChannel],
  [VOICE_CHANNEL, voiceChannel],
]);

const guild: any = {
  id: GUILD,
  name: "Fixture Server",
  channels: { cache: channels },
  members: {
    search: async ({ query }: { query: string }) =>
      new Collection<string, any>(
        [{ id: USER, user: { username: "ada" }, displayName: "Ada L." }]
          .filter((m) => m.user.username.includes(query) || m.displayName.toLowerCase().includes(query.toLowerCase()))
          .map((m) => [m.id, m]),
      ),
  },
  fetch: async () => ({
    name: "Fixture Server",
    id: GUILD,
    ownerId: USER,
    memberCount: 3,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    description: null,
    premiumTier: 0,
  }),
};

const discord = {
  channels: {
    fetch: async (id: string) => {
      const c = channels.get(id);
      if (!c) throw new Error(`Unknown Channel ${id}`);
      return c;
    },
  },
  guilds: { cache: new Collection<string, any>([[GUILD, guild]]) },
} as unknown as Client;

// Two servers: one with a default guild, one without, to pin both branches of
// the guild resolution.
async function connect(defaultGuildId?: string) {
  const http = startMcpServer(discord, { port: 0, host: "127.0.0.1", path: "/mcp", defaultGuildId });
  await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  const client = new McpClient({ name: "atdev-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    port,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const res: any = await client.callTool({ name, arguments: args });
      return { text: String(res.content[0]?.text ?? ""), isError: !!res.isError };
    },
    list: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    close: async () => {
      await client.close();
      http.close();
    },
  };
}

let mcp: Awaited<ReturnType<typeof connect>>;
let noDefault: Awaited<ReturnType<typeof connect>>;
before(async () => {
  mcp = await connect(GUILD);
  noDefault = await connect();
});
after(async () => {
  await mcp.close();
  await noDefault.close();
});

test("all 10 contract tools are registered under their exact names", async () => {
  assert.deepEqual(await mcp.list(), [
    "find_channel",
    "get_attachment",
    "get_channel_info",
    "get_server_info",
    "get_user_id_by_name",
    "list_channel_permission_overwrites",
    "list_channels",
    "list_forum_posts",
    "read_messages",
    "send_message",
  ]);
});

test("read_messages: oldest first, with author, id, and attachment names", async () => {
  const { text } = await mcp.call("read_messages", { channelId: TEXT_CHANNEL });
  assert.deepEqual(text.split("\n"), [
    "[2024-05-01T00:00:00.000Z] ada (200000000000000002) msg:1: first message",
    "[2024-05-02T00:00:00.000Z] somebot (888) msg:2: [no text]",
    "[2024-05-03T00:00:00.000Z] ada (200000000000000002) msg:3: and one with a file [attachments: diff.patch]",
  ]);
});

test("read_messages: count is a string, clamped to 1..100; paging args pass through", async () => {
  await mcp.call("read_messages", { channelId: TEXT_CHANNEL });
  assert.deepEqual(textChannel.lastFetch, {}, "no count means no limit — the API default stands");

  await mcp.call("read_messages", { channelId: TEXT_CHANNEL, count: "5" });
  assert.equal(textChannel.lastFetch.limit, 5);
  await mcp.call("read_messages", { channelId: TEXT_CHANNEL, count: "500" });
  assert.equal(textChannel.lastFetch.limit, 100, "clamped high");
  await mcp.call("read_messages", { channelId: TEXT_CHANNEL, count: "0" });
  assert.equal(textChannel.lastFetch.limit, 50, "unparseable/zero falls back to 50");
  await mcp.call("read_messages", { channelId: TEXT_CHANNEL, count: "-4" });
  assert.equal(textChannel.lastFetch.limit, 1, "clamped low");

  await mcp.call("read_messages", { channelId: TEXT_CHANNEL, before: "3", after: "1", around: "2" });
  assert.deepEqual(textChannel.lastFetch, { before: "3", after: "1", around: "2" });
});

test("read_messages: non-text and unknown channels come back as tool errors", async () => {
  const notText = await mcp.call("read_messages", { channelId: VOICE_CHANNEL });
  assert.ok(notText.isError && notText.text.includes("is not a text channel"));
  const missing = await mcp.call("read_messages", { channelId: "999" });
  assert.ok(missing.isError && missing.text.includes("Unknown Channel"));
});

test("find_channel matches on a substring, case-insensitively", async () => {
  const { text } = await mcp.call("find_channel", { channelName: "GENERAL" });
  assert.deepEqual(text.split("\n"), [
    `general (id: ${TEXT_CHANNEL}, type: GuildText)`,
    `general-voice (id: ${VOICE_CHANNEL}, type: GuildVoice)`,
  ]);
  assert.equal((await mcp.call("find_channel", { channelName: "nope" })).text, 'No channels found matching "nope"');
});

test("guild resolution: default, explicit, unknown, and none configured", async () => {
  assert.ok((await mcp.call("list_channels")).text.includes("general"), "defaultGuildId did not fill in");
  assert.ok((await mcp.call("list_channels", { guildId: GUILD })).text.includes("general"), "explicit guildId ignored");

  const unknown = await mcp.call("list_channels", { guildId: "111111111111111111" });
  assert.ok(unknown.isError && unknown.text.includes("bot is not a member of that guild"));

  const none = await noDefault.call("list_channels");
  assert.ok(none.isError && none.text.includes("guildId is required"));
});

test("list_channels reports type and parent for every channel", async () => {
  const { text } = await mcp.call("list_channels");
  assert.equal(text.split("\n").length, 3);
  assert.ok(text.includes(`general (id: ${TEXT_CHANNEL}, type: GuildText, parent: ${CATEGORY})`));
  assert.ok(text.includes(`forum-help (id: ${FORUM_CHANNEL}, type: GuildForum, parent: -)`));
});

test("send_message returns the posted message id and the channel it landed in", async () => {
  const { text, isError } = await mcp.call("send_message", { channelId: TEXT_CHANNEL, message: "hello" });
  assert.equal(isError, false);
  assert.equal(text, "Sent message sent-5 to #general");

  const bad = await mcp.call("send_message", { channelId: VOICE_CHANNEL, message: "hi" });
  assert.ok(bad.isError && bad.text.includes("is not a text channel"));
});

test("get_attachment: metadata only, filterable by id", async () => {
  assert.equal(
    (await mcp.call("get_attachment", { channelId: TEXT_CHANNEL, messageId: "3" })).text,
    "diff.patch (id: A1) — 1234 bytes, text/plain, url: https://cdn.example/A1/diff.patch",
  );
  assert.equal((await mcp.call("get_attachment", { channelId: TEXT_CHANNEL, messageId: "1" })).text, "(no attachments)");
  assert.equal(
    (await mcp.call("get_attachment", { channelId: TEXT_CHANNEL, messageId: "3", attachmentId: "nope" })).text,
    "(no attachments)",
  );
});

test("get_channel_info fills every field, with placeholders for the absent ones", async () => {
  const { text } = await mcp.call("get_channel_info", { channelId: FORUM_CHANNEL });
  assert.deepEqual(text.split("\n"), [
    "name: forum-help",
    `id: ${FORUM_CHANNEL}`,
    "type: GuildForum",
    `guildId: ${GUILD}`,
    "parentId: (none)",
    "topic: (none)",
    "nsfw: false",
  ]);
});

test("list_forum_posts degrades to the active threads when archived are unreadable", async () => {
  const { text } = await mcp.call("list_forum_posts", { channelId: FORUM_CHANNEL });
  assert.equal(text, "live post (id: t1) — created 2024-05-01T00:00:00.000Z, active, messages: 4");
  const notForum = await mcp.call("list_forum_posts", { channelId: VOICE_CHANNEL });
  assert.ok(notForum.isError && notForum.text.includes("is not a forum channel"));
});

test("get_user_id_by_name searches the guild and reports the display name", async () => {
  assert.equal((await mcp.call("get_user_id_by_name", { username: "ad" })).text, `ada (display: Ada L.) — id: ${USER}`);
  assert.equal((await mcp.call("get_user_id_by_name", { username: "zzz" })).text, 'No members found matching "zzz"');
});

test("get_server_info reports the fetched guild, not the cached stub", async () => {
  const { text } = await mcp.call("get_server_info");
  assert.ok(text.includes("memberCount: 3") && text.includes("createdAt: 2020-01-01T00:00:00.000Z"));
  assert.ok(text.includes("description: (none)"));
});

test("list_channel_permission_overwrites labels roles and members", async () => {
  const { text } = await mcp.call("list_channel_permission_overwrites", { channelId: TEXT_CHANNEL });
  assert.deepEqual(text.split("\n"), ["role role-1: allow=[ViewChannel] deny=[]", "member mem-1: allow=[] deny=[SendMessages]"]);
  const none = await mcp.call("list_channel_permission_overwrites", { channelId: VOICE_CHANNEL });
  assert.ok(none.isError && none.text.includes("has no permission overwrites"));
});
