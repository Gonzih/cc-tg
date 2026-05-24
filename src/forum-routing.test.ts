import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- hoisted mocks (must come before imports) ----
const mocks = vi.hoisted(() => ({
  tgSendMessage: vi.fn().mockResolvedValue({}),
  tgSendChatAction: vi.fn().mockResolvedValue({}),
  tgSetMyCommands: vi.fn().mockResolvedValue({}),
  tgOn: vi.fn(),
  tgStopPolling: vi.fn(),
  tgGetMe: vi.fn().mockResolvedValue({ id: 999, username: "testbot" }),
  claudeOn: vi.fn(),
  claudeSendPrompt: vi.fn(),
  claudeKill: vi.fn(),
  cronList: vi.fn().mockReturnValue([]),
  cronAdd: vi.fn().mockReturnValue(null),
  cronRemove: vi.fn().mockReturnValue(false),
  cronClearAll: vi.fn().mockReturnValue(0),
  cronUpdate: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(false),
  writeChatLog: vi.fn(),
  mockEnsureMetaAgent: vi.fn().mockResolvedValue(undefined),
  mockRouteToMetaAgent: vi.fn().mockResolvedValue(undefined),
  mockParseRoutingTag: vi.fn().mockReturnValue(null),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: vi.fn(function MockTelegramBot() {
    return {
      on: mocks.tgOn,
      sendMessage: mocks.tgSendMessage,
      sendDocument: vi.fn().mockResolvedValue({}),
      sendChatAction: mocks.tgSendChatAction,
      setMyCommands: mocks.tgSetMyCommands,
      stopPolling: mocks.tgStopPolling,
      getFileLink: vi.fn().mockResolvedValue("https://example.com/file"),
      getMe: mocks.tgGetMe,
    };
  }),
}));

vi.mock("./claude.js", () => ({
  ClaudeProcess: vi.fn(function MockClaudeProcess() {
    return {
      sendPrompt: mocks.claudeSendPrompt,
      sendImage: vi.fn(),
      kill: mocks.claudeKill,
      exited: false,
      on: mocks.claudeOn,
    };
  }),
  extractText: vi.fn((msg: Record<string, unknown>) => {
    const payload = msg.payload as Record<string, unknown>;
    return (payload?.result as string) ?? "";
  }),
}));

vi.mock("./cron.js", () => ({
  CronManager: vi.fn(function MockCronManager() {
    return {
      list: mocks.cronList,
      add: mocks.cronAdd,
      remove: mocks.cronRemove,
      clearAll: mocks.cronClearAll,
      update: mocks.cronUpdate,
    };
  }),
}));

vi.mock("./voice.js", () => ({
  isVoiceAvailable: vi.fn().mockReturnValue(false),
  transcribeVoice: vi.fn().mockResolvedValue(""),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mocks.existsSyncMock };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execSync: vi.fn().mockReturnValue(""), spawn: vi.fn() };
});

vi.mock("./notifier.js", () => ({
  writeChatLog: mocks.writeChatLog,
}));

vi.mock("./router.js", () => ({
  parseRoutingTag: (...args: unknown[]) => mocks.mockParseRoutingTag(...args),
  ensureMetaAgent: (...args: unknown[]) => mocks.mockEnsureMetaAgent(...args),
  routeToMetaAgent: (...args: unknown[]) => mocks.mockRouteToMetaAgent(...args),
}));

import { CcTgBot, normalizeTopicNamespace } from "./bot.js";
import type { Redis } from "ioredis";

// ---- helpers ----
function makeRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue(null),
    rpush: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

// chat.type intentionally omitted so isGroup=false — same pattern as bot.test.ts
function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 42 },
    from: { id: 100 },
    text: "hello",
    ...overrides,
  };
}

// ===========================================================================
// normalizeTopicNamespace
// ===========================================================================
describe("normalizeTopicNamespace", () => {
  it("lowercases the name", () => {
    expect(normalizeTopicNamespace("MyTopic")).toBe("mytopic");
  });

  it("replaces spaces with hyphens", () => {
    expect(normalizeTopicNamespace("CC Suite")).toBe("cc-suite");
  });

  it("strips leading # chars", () => {
    expect(normalizeTopicNamespace("#research")).toBe("research");
    expect(normalizeTopicNamespace("##deep")).toBe("deep");
  });

  it("leaves already-normalized names unchanged", () => {
    expect(normalizeTopicNamespace("of-stack")).toBe("of-stack");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTopicNamespace("foo   bar")).toBe("foo-bar");
  });

  it("collapses multiple hyphens", () => {
    expect(normalizeTopicNamespace("foo---bar")).toBe("foo-bar");
  });

  it("replaces special chars with hyphens and trims them", () => {
    // trailing ! becomes -, which is trimmed by the final replace
    expect(normalizeTopicNamespace("My Topic!")).toBe("my-topic");
    expect(normalizeTopicNamespace("topic!")).toBe("topic");
  });

  it("handles mixed case, spaces, and # together", () => {
    expect(normalizeTopicNamespace("#CC Suite")).toBe("cc-suite");
  });
});

// ===========================================================================
// Forum routing in handleTelegram
// ===========================================================================
describe("Forum topic meta-agent routing", () => {
  let bot: CcTgBot;
  let redis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.cronList.mockReturnValue([]);
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);
    delete process.env.FORUM_META_AGENT_ROUTING;
    delete process.env.DEFAULT_GITHUB_ORG;

    redis = makeRedis();
    bot = new CcTgBot({ telegramToken: "test-token", redis });
  });

  afterEach(() => {
    bot.stop();
  });

  async function sendMsg(overrides: Record<string, unknown> = {}) {
    await (bot as unknown as { handleTelegram(m: unknown): Promise<void> }).handleTelegram(
      makeMsg(overrides)
    );
  }

  // ---- topic name caching from service messages ----

  it("caches topic name from forum_topic_created service message", async () => {
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_created: { name: "My Topic" },
    });
    const cache = (bot as unknown as { topicNameCache: Map<string, string> }).topicNameCache;
    expect(cache.get("42:5")).toBe("My Topic");
  });

  it("updates cached topic name from forum_topic_edited service message", async () => {
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_created: { name: "Old Name" },
    });
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_edited: { name: "New Name" },
    });
    const cache = (bot as unknown as { topicNameCache: Map<string, string> }).topicNameCache;
    expect(cache.get("42:5")).toBe("New Name");
  });

  it("does not overwrite cached name when forum_topic_edited has no name field", async () => {
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_created: { name: "Stable Name" },
    });
    // Edited event with only icon change (no name field)
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_edited: { icon_color: 123 },
    });
    const cache = (bot as unknown as { topicNameCache: Map<string, string> }).topicNameCache;
    expect(cache.get("42:5")).toBe("Stable Name");
  });

  it("caches topic name from reply_to_message.forum_topic_created on first real message", async () => {
    await sendMsg({
      message_thread_id: 7,
      text: "hello in topic",
      reply_to_message: { forum_topic_created: { name: "Dev Chat" } },
    });
    const cache = (bot as unknown as { topicNameCache: Map<string, string> }).topicNameCache;
    expect(cache.get("42:7")).toBe("Dev Chat");
  });

  // ---- routing logic ----

  it("routes message to meta-agent when topic name is cached and routing=auto", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    // Cache the topic name via service message
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_created: { name: "of-stack" },
    });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);

    await sendMsg({ message_thread_id: 5, text: "fix the bug" });

    // Should ack routing in the correct thread
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      "→ #of-stack (meta-agent)",
      expect.objectContaining({ message_thread_id: 5 })
    );
    expect(mocks.mockEnsureMetaAgent).toHaveBeenCalledWith(
      "of-stack",
      expect.stringContaining("gonzih/of-stack"),
      expect.any(Function),
      redis
    );
    expect(mocks.mockRouteToMetaAgent).toHaveBeenCalledWith("of-stack", "fix the bug", redis);
  });

  it("uses DEFAULT_GITHUB_ORG when building repo URL", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    process.env.DEFAULT_GITHUB_ORG = "myorg";
    await sendMsg({
      message_thread_id: 3,
      text: undefined,
      forum_topic_created: { name: "my-project" },
    });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);

    await sendMsg({ message_thread_id: 3, text: "do work" });

    expect(mocks.mockEnsureMetaAgent).toHaveBeenCalledWith(
      "my-project",
      "https://github.com/myorg/my-project",
      expect.any(Function),
      redis
    );
  });

  it("does NOT route when FORUM_META_AGENT_ROUTING=off", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "off";
    await sendMsg({
      message_thread_id: 5,
      text: undefined,
      forum_topic_created: { name: "of-stack" },
    });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);

    await sendMsg({ message_thread_id: 5, text: "hello" });

    expect(mocks.mockEnsureMetaAgent).not.toHaveBeenCalled();
    expect(mocks.mockRouteToMetaAgent).not.toHaveBeenCalled();
  });

  it("routes only listed topics when FORUM_META_AGENT_ROUTING is comma-separated", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "of-stack,cc-suite";

    // Cache two topic names
    await sendMsg({ message_thread_id: 1, text: undefined, forum_topic_created: { name: "of-stack" } });
    await sendMsg({ message_thread_id: 2, text: undefined, forum_topic_created: { name: "other-topic" } });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);

    // "of-stack" is in the allowlist → should route
    await sendMsg({ message_thread_id: 1, text: "work on it" });
    expect(mocks.mockEnsureMetaAgent).toHaveBeenCalledWith(
      "of-stack",
      expect.any(String),
      expect.any(Function),
      redis
    );

    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);

    // "other-topic" is NOT in allowlist → should not route
    await sendMsg({ message_thread_id: 2, text: "work on it" });
    expect(mocks.mockEnsureMetaAgent).not.toHaveBeenCalled();
  });

  it("does NOT route when topic name is not in cache", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    // No cache population — topic name never seen for threadId 99

    await sendMsg({ message_thread_id: 99, text: "hello" });

    expect(mocks.mockEnsureMetaAgent).not.toHaveBeenCalled();
    expect(mocks.mockRouteToMetaAgent).not.toHaveBeenCalled();
  });

  it("does NOT route when message is not in a forum topic (no threadId)", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";

    await sendMsg({ text: "hello" }); // no message_thread_id

    expect(mocks.mockEnsureMetaAgent).not.toHaveBeenCalled();
    expect(mocks.mockRouteToMetaAgent).not.toHaveBeenCalled();
  });

  it("does NOT route when Redis is not configured", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    const botNoRedis = new CcTgBot({ telegramToken: "test-token" });
    // Manually prime its cache
    (botNoRedis as unknown as { topicNameCache: Map<string, string> }).topicNameCache.set(
      "42:5",
      "of-stack"
    );

    await (botNoRedis as unknown as { handleTelegram(m: unknown): Promise<void> }).handleTelegram(
      makeMsg({ message_thread_id: 5, text: "hello" })
    );

    expect(mocks.mockEnsureMetaAgent).not.toHaveBeenCalled();
    botNoRedis.stop();
  });

  it("sends failure message in thread when ensureMetaAgent throws", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    await sendMsg({ message_thread_id: 5, text: undefined, forum_topic_created: { name: "bad-topic" } });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockRejectedValue(new Error("agent exploded"));

    await sendMsg({ message_thread_id: 5, text: "do something" });

    const calls = mocks.tgSendMessage.mock.calls as [number, string, unknown?][];
    const errorCall = calls.find(([, msg]) => (msg as string).includes("Failed to route"));
    expect(errorCall).toBeDefined();
    expect(errorCall![1]).toContain("agent exploded");
    // Error reply must be in the same thread
    expect(errorCall![2]).toMatchObject({ message_thread_id: 5 });
  });

  it("normalizes topic name before routing (spaces → hyphens, lowercase)", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    await sendMsg({ message_thread_id: 9, text: undefined, forum_topic_created: { name: "CC Suite" } });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.mockParseRoutingTag.mockReturnValue(null);
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);

    await sendMsg({ message_thread_id: 9, text: "deploy please" });

    expect(mocks.mockEnsureMetaAgent).toHaveBeenCalledWith(
      "cc-suite",
      expect.stringContaining("cc-suite"),
      expect.any(Function),
      redis
    );
    expect(mocks.mockRouteToMetaAgent).toHaveBeenCalledWith("cc-suite", "deploy please", redis);
  });

  it("hashtag routing takes priority over forum routing", async () => {
    process.env.FORUM_META_AGENT_ROUTING = "auto";
    // Cache a topic name
    await sendMsg({ message_thread_id: 5, text: undefined, forum_topic_created: { name: "of-stack" } });
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    // Hashtag routing returns a match
    mocks.mockParseRoutingTag.mockReturnValue({
      namespace: "other-repo",
      repoUrl: "https://github.com/gonzih/other-repo",
      strippedMessage: "fix the bug",
    });
    mocks.mockEnsureMetaAgent.mockResolvedValue(undefined);
    mocks.mockRouteToMetaAgent.mockResolvedValue(undefined);

    await sendMsg({ message_thread_id: 5, text: "#other-repo fix the bug" });

    // Should route to "other-repo" (hashtag routing), NOT "of-stack" (forum routing)
    expect(mocks.mockRouteToMetaAgent).toHaveBeenCalledWith("other-repo", "fix the bug", redis);
    // The forum routing ack "(meta-agent)" should NOT appear — hashtag routing sends its own ack
    const sendCalls = mocks.tgSendMessage.mock.calls as [number, string, unknown?][];
    const forumAck = sendCalls.find(([, msg]) => (msg as string).includes("(meta-agent)"));
    expect(forumAck).toBeUndefined();
  });
});
