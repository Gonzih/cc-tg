import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startNotifier, writeChatLog, parseNotification, isDiscordOnly, shouldSkipForTelegram, type ChatMessage } from "./notifier.js";

// ---- ioredis mock ----
const mockSubscribe = vi.fn().mockImplementation((_channel: string, cb?: (err: Error | null) => void) => {
  if (cb) cb(null);
  return Promise.resolve(1);
});
const mockPsubscribe = vi.fn().mockImplementation((_pattern: string, cb?: (err: Error | null) => void) => {
  if (cb) cb(null);
  return Promise.resolve(1);
});
const mockOn = vi.fn();
const mockDuplicate = vi.fn();
const mockLpush = vi.fn().mockResolvedValue(1);
const mockRpush = vi.fn().mockResolvedValue(1);
const mockLtrim = vi.fn().mockResolvedValue("OK");
const mockPublish = vi.fn().mockResolvedValue(1);
const mockGet = vi.fn().mockResolvedValue(null);
const mockRpop = vi.fn().mockResolvedValue(null);
const mockLlen = vi.fn().mockResolvedValue(0);

vi.mock("ioredis", () => {
  function MockRedis(this: Record<string, unknown>) {
    this.subscribe = mockSubscribe;
    this.psubscribe = mockPsubscribe;
    this.on = mockOn;
    this.duplicate = mockDuplicate;
    this.lpush = mockLpush;
    this.rpush = mockRpush;
    this.ltrim = mockLtrim;
    this.publish = mockPublish;
    this.get = mockGet;
    this.rpop = mockRpop;
    this.llen = mockLlen;
  }
  return { Redis: MockRedis };
});

function makeBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
  };
}

function makeRedis(): ReturnType<typeof makeBot> & {
  subscribe: typeof mockSubscribe;
  psubscribe: typeof mockPsubscribe;
  on: typeof mockOn;
  duplicate: typeof mockDuplicate;
  lpush: typeof mockLpush;
  rpush: typeof mockRpush;
  ltrim: typeof mockLtrim;
  publish: typeof mockPublish;
  get: typeof mockGet;
  rpop: typeof mockRpop;
  llen: typeof mockLlen;
} {
  const sub = {
    subscribe: mockSubscribe,
    psubscribe: mockPsubscribe,
    on: mockOn,
    lpush: mockLpush,
    rpush: mockRpush,
    ltrim: mockLtrim,
    publish: mockPublish,
    get: mockGet,
  };
  mockDuplicate.mockReturnValue(sub);
  return {
    sendMessage: vi.fn(),
    subscribe: mockSubscribe,
    psubscribe: mockPsubscribe,
    on: mockOn,
    duplicate: mockDuplicate,
    lpush: mockLpush,
    rpush: mockRpush,
    ltrim: mockLtrim,
    publish: mockPublish,
    get: mockGet,
    rpop: mockRpop,
    llen: mockLlen,
  };
}

describe("startNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null); // default: no meta-agent running
    mockRpop.mockResolvedValue(null); // default: empty list
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      rpush: mockRpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  it("subscribes to cca:notify and cca:chat:incoming channels, psubscribes to cca:chat:outgoing:*", () => {
    const bot = makeBot();
    const redis = makeRedis();
    startNotifier(bot as never, 123, "default", redis as never);

    expect(mockDuplicate).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith("cca:notify:default", expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith("cca:chat:incoming:default", expect.any(Function));
    expect(mockPsubscribe).toHaveBeenCalledWith("cca:chat:outgoing:*", expect.any(Function));
  });

  it("forwards notify channel messages to Telegram", () => {
    const bot = makeBot();
    const redis = makeRedis();

    // Capture the message handler
    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 456, "myns", redis as never);

    expect(messageHandler).toBeDefined();
    messageHandler!("cca:notify:myns", "Job done: my-task");
    expect(bot.sendMessage).toHaveBeenCalledWith(456, "Job done: my-task");
  });

  it("echoes UI messages to Telegram and calls handleUserMessage", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 789, "ns1", redis as never, handleUserMessage);

    messageHandler!("cca:chat:incoming:ns1", "hello from UI");

    await new Promise((r) => setTimeout(r, 0));

    expect(bot.sendMessage).toHaveBeenCalledWith(789, "📱 [from UI]: hello from UI");
    expect(handleUserMessage).toHaveBeenCalledWith(789, "hello from UI");
  });

  it("parses JSON content from incoming UI message", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 111, "x", redis as never, handleUserMessage);

    messageHandler!("cca:chat:incoming:x", JSON.stringify({ content: "extracted content" }));

    await new Promise((r) => setTimeout(r, 0));

    expect(bot.sendMessage).toHaveBeenCalledWith(111, "📱 [from UI]: extracted content");
    expect(handleUserMessage).toHaveBeenCalledWith(111, "extracted content");
  });

  it("passes retryStrategy to duplicated subscriber for backoff reconnect", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let capturedOpts: { retryStrategy?: (times: number) => number } | undefined;
    mockDuplicate.mockImplementation((opts: unknown) => {
      capturedOpts = opts as typeof capturedOpts;
      return {
        subscribe: mockSubscribe,
        psubscribe: mockPsubscribe,
        on: mockOn,
        lpush: mockLpush,
        ltrim: mockLtrim,
        publish: mockPublish,
      };
    });

    startNotifier(bot as never, 123, "default", redis as never);

    expect(capturedOpts?.retryStrategy).toBeTypeOf("function");
    // Verify exponential backoff: 1s, 2s, 4s, ..., capped at 30s
    const s = capturedOpts!.retryStrategy!;
    expect(s(1)).toBe(1000);
    expect(s(2)).toBe(2000);
    expect(s(3)).toBe(4000);
    expect(s(10)).toBe(30_000); // capped
  });

  it("registers a close handler that does not throw", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let closeHandler: (() => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "close") closeHandler = handler as () => void;
    });

    startNotifier(bot as never, 123, "default", redis as never);

    expect(closeHandler).toBeDefined();
    expect(() => closeHandler!()).not.toThrow();
  });

  it("ignores messages on unrecognized channels", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 999, "z", redis as never);

    messageHandler!("some:other:channel", "noise");
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("uses getActiveChatId when chatId is null (dynamic chat bridge mode)", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const getActiveChatId = vi.fn().mockReturnValue(42);

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, null, "dyn", redis as never, handleUserMessage, undefined, getActiveChatId);

    messageHandler!("cca:chat:incoming:dyn", "hello dynamic");

    await new Promise((r) => setTimeout(r, 0));

    expect(getActiveChatId).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(42, "📱 [from UI]: hello dynamic");
    expect(handleUserMessage).toHaveBeenCalledWith(42, "hello dynamic");
  });

  it("skips notify channel message when chatId is null", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, null, "dyn", redis as never);

    messageHandler!("cca:notify:dyn", "Job done");
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("routes to meta-agent input queue when meta-agent is running", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();

    mockGet.mockResolvedValue(JSON.stringify({ status: "running" }));

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 100, "ns-meta", redis as never, handleUserMessage);

    messageHandler!("cca:chat:incoming:ns-meta", "hello meta");

    // Give the async IIFE time to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(mockGet).toHaveBeenCalledWith("cca:meta-agent:status:ns-meta");
    expect(mockRpush).toHaveBeenCalledWith(
      "cca:meta:ns-meta:input",
      expect.stringContaining('"content":"hello meta"')
    );
    expect(handleUserMessage).not.toHaveBeenCalled();
    // Still echoes to Telegram
    expect(bot.sendMessage).toHaveBeenCalledWith(100, "📱 [from UI]: hello meta");
  });

  it("falls back to handleUserMessage when meta-agent status is not running", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();

    mockGet.mockResolvedValue(JSON.stringify({ status: "idle" }));

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 200, "ns-idle", redis as never, handleUserMessage);

    messageHandler!("cca:chat:incoming:ns-idle", "hello coord");

    await new Promise((r) => setTimeout(r, 0));

    expect(handleUserMessage).toHaveBeenCalledWith(200, "hello coord");
    expect(mockRpush).not.toHaveBeenCalledWith(
      "cca:meta:ns-idle:input",
      expect.anything()
    );
  });

  it("falls back to handleUserMessage when meta-agent status check throws", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();

    mockGet.mockRejectedValue(new Error("redis connection lost"));

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 300, "ns-err", redis as never, handleUserMessage);

    messageHandler!("cca:chat:incoming:ns-err", "error fallback");

    await new Promise((r) => setTimeout(r, 0));

    expect(handleUserMessage).toHaveBeenCalledWith(300, "error fallback");
  });

  it("does not call handleUserMessage when getActiveChatId returns undefined", () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const getActiveChatId = vi.fn().mockReturnValue(undefined);

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, null, "dyn", redis as never, handleUserMessage, undefined, getActiveChatId);

    messageHandler!("cca:chat:incoming:dyn", "orphaned message");

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it("forwardNotification is called for notify pub/sub, handleUserMessage is NOT called", () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const forwardNotification = vi.fn();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 500, "testns", redis as never, handleUserMessage, forwardNotification);

    messageHandler!("cca:notify:testns", "job finished");

    expect(bot.sendMessage).toHaveBeenCalledWith(500, "job finished");
    expect(forwardNotification).toHaveBeenCalledWith(500, "job finished");
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it("handleUserMessage is still called for cca:chat:incoming (unchanged)", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const forwardNotification = vi.fn();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 600, "testns2", redis as never, handleUserMessage, forwardNotification);

    messageHandler!("cca:chat:incoming:testns2", "hello from UI");

    await new Promise((r) => setTimeout(r, 0));

    expect(bot.sendMessage).toHaveBeenCalledWith(600, "📱 [from UI]: hello from UI");
    expect(handleUserMessage).toHaveBeenCalledWith(600, "hello from UI");
    expect(forwardNotification).not.toHaveBeenCalled();
  });
});

describe("meta-agent outgoing (pmessage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function capturePmessageHandler(): (pattern: string, channel: string, message: string) => void {
    let handler: ((pattern: string, channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, h: unknown) => {
      if (event === "pmessage") handler = h as typeof handler;
    });
    return (...args) => {
      if (!handler) throw new Error("pmessage handler not registered");
      handler(...args);
    };
  }

  it("buffers source=claude lines and flushes after 1.5s debounce", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    const line1 = JSON.stringify({ source: "claude", content: "Hello", role: "assistant" });
    const line2 = JSON.stringify({ source: "claude", content: "World", role: "assistant" });
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns", line1);
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns", line2);

    // Before debounce fires — no message yet
    expect(bot.sendMessage).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(42, "← [ns] Hello\nWorld");
  });

  it("filters out non-claude sources (echo guard)", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    // These should all be ignored
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "cc-tg", content: "loop!" }));
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "telegram", content: "echo" }));
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "ui", content: "from ui" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores non-JSON lines silently", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns", "not json at all");

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("extracts namespace from channel name (multi-namespace)", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 99, "money-brain", redis as never);

    // Message from a different namespace — isoc-nevada
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:isoc-nevada",
      JSON.stringify({ source: "claude", content: "isoc response" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).toHaveBeenCalledWith(99, "← [isoc-nevada] isoc response");
  });

  it("resets debounce timer when new line arrives within 1.5s", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "line 1" }));

    // Advance 1000ms (within debounce window) — no flush yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.sendMessage).not.toHaveBeenCalled();

    // New line resets timer
    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "line 2" }));

    // Advance another 1000ms — still within new 1.5s window
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.sendMessage).not.toHaveBeenCalled();

    // Advance remaining 500ms to complete the 1.5s debounce
    await vi.advanceTimersByTimeAsync(500);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(42, "← [ns] line 1\nline 2");
  });

  it("uses getActiveChatId when chatId is null", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const getActiveChatId = vi.fn().mockReturnValue(77);
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, null, "ns", redis as never, undefined, undefined, getActiveChatId);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "dynamic chat" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).toHaveBeenCalledWith(77, "← [ns] dynamic chat");
  });

  it("drops message when no chatId is available", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const getActiveChatId = vi.fn().mockReturnValue(undefined);
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, null, "ns", redis as never, undefined, undefined, getActiveChatId);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "orphaned" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("strips ANSI escape codes before sending", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "\x1B[32mgreen text\x1B[0m" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).toHaveBeenCalledWith(42, "← [ns] green text");
  });

  it("skips lines with empty content", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const pmessage = capturePmessageHandler();

    startNotifier(bot as never, 42, "ns", redis as never);

    pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:ns",
      JSON.stringify({ source: "claude", content: "" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  describe("registerRoutedChatId", () => {
    it("routes response to registered chatId instead of fixed chatId", async () => {
      const bot = makeBot();
      const redis = makeRedis();
      const pmessage = capturePmessageHandler();

      // Fixed chatId=99 (e.g., money-brain), but we route from chatId=777
      const notifier = startNotifier(bot as never, 99, "money-brain", redis as never);
      notifier.registerRoutedChatId("of-stack", 777);

      pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:of-stack",
        JSON.stringify({ source: "claude", content: "done routing" }));

      await vi.advanceTimersByTimeAsync(1500);

      // Must go to 777 (originating chat), not 99 (fixed chat)
      expect(bot.sendMessage).toHaveBeenCalledWith(777, "← [of-stack] done routing");
      expect(bot.sendMessage).not.toHaveBeenCalledWith(99, "← [of-stack] done routing");
    });

    it("falls back to fixed chatId when no routing registered for namespace", async () => {
      const bot = makeBot();
      const redis = makeRedis();
      const pmessage = capturePmessageHandler();

      const notifier = startNotifier(bot as never, 99, "money-brain", redis as never);
      // Register for a different namespace — should not affect of-stack
      notifier.registerRoutedChatId("other-ns", 888);

      pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:of-stack",
        JSON.stringify({ source: "claude", content: "unregistered namespace" }));

      await vi.advanceTimersByTimeAsync(1500);

      // Falls back to fixed chatId=99
      expect(bot.sendMessage).toHaveBeenCalledWith(99, "← [of-stack] unregistered namespace");
    });

    it("last registerRoutedChatId call wins for same namespace", async () => {
      const bot = makeBot();
      const redis = makeRedis();
      const pmessage = capturePmessageHandler();

      const notifier = startNotifier(bot as never, 99, "money-brain", redis as never);
      notifier.registerRoutedChatId("of-stack", 111);
      notifier.registerRoutedChatId("of-stack", 222); // overwrites

      pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:of-stack",
        JSON.stringify({ source: "claude", content: "overwritten" }));

      await vi.advanceTimersByTimeAsync(1500);

      expect(bot.sendMessage).toHaveBeenCalledWith(222, "← [of-stack] overwritten");
    });

    it("falls back to getActiveChatId when no fixed chatId and no routing for namespace", async () => {
      const bot = makeBot();
      const redis = makeRedis();
      const getActiveChatId = vi.fn().mockReturnValue(555);
      const pmessage = capturePmessageHandler();

      const notifier = startNotifier(bot as never, null, "money-brain", redis as never, undefined, undefined, getActiveChatId);
      // Register for a different namespace — of-stack not registered
      notifier.registerRoutedChatId("other-ns", 999);

      pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:of-stack",
        JSON.stringify({ source: "claude", content: "dynamic fallback" }));

      await vi.advanceTimersByTimeAsync(1500);

      // Falls back to getActiveChatId()
      expect(bot.sendMessage).toHaveBeenCalledWith(555, "← [of-stack] dynamic fallback");
    });

    it("per-namespace registry does not interfere with primary namespace routing", async () => {
      const bot = makeBot();
      const redis = makeRedis();
      const pmessage = capturePmessageHandler();

      const notifier = startNotifier(bot as never, 99, "money-brain", redis as never);
      notifier.registerRoutedChatId("of-stack", 777);

      // Primary namespace response — should still go to fixed chatId=99
      pmessage("cca:chat:outgoing:*", "cca:chat:outgoing:money-brain",
        JSON.stringify({ source: "claude", content: "primary response" }));

      await vi.advanceTimersByTimeAsync(1500);

      expect(bot.sendMessage).toHaveBeenCalledWith(99, "← [money-brain] primary response");
    });
  });
});

describe("notify list poller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not send anything when the list is empty", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValue(null);

    startNotifier(bot as never, 123, "ns-poll", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("drains list items and sends them to Telegram", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    // Two items then empty
    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "First notification" }))
      .mockResolvedValueOnce(JSON.stringify({ text: "Second notification" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 555, "ns-drain", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(555, "First notification");
    expect(bot.sendMessage).toHaveBeenCalledWith(555, "Second notification");
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("sends raw string when item is not JSON", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce("plain text notification")
      .mockResolvedValue(null);

    startNotifier(bot as never, 777, "ns-raw", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(777, "plain text notification");
  });

  it("sends '...and N more' summary when list exceeds 20 items", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    // Return 20 items then null to fill the cycle, leaving 5 more in the list
    const items = Array.from({ length: 20 }, (_, i) => JSON.stringify({ text: `msg ${i + 1}` }));
    mockRpop.mockImplementation(() => {
      const item = items.shift();
      return Promise.resolve(item ?? null);
    });
    mockLlen.mockResolvedValue(5);

    startNotifier(bot as never, 888, "ns-overflow", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    // 20 messages + 1 summary
    expect(bot.sendMessage).toHaveBeenCalledTimes(21);
    expect(bot.sendMessage).toHaveBeenLastCalledWith(888, "...and 5 more notifications");
  });

  it("does not send summary when exactly 20 items and list is now empty", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    const items = Array.from({ length: 20 }, (_, i) => JSON.stringify({ text: `msg ${i + 1}` }));
    mockRpop.mockImplementation(() => {
      const item = items.shift();
      return Promise.resolve(item ?? null);
    });
    mockLlen.mockResolvedValue(0);

    startNotifier(bot as never, 999, "ns-exact20", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledTimes(20);
    expect(bot.sendMessage).not.toHaveBeenCalledWith(999, expect.stringContaining("more notifications"));
  });

  it("skips polling when no chatId is available", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello" })).mockResolvedValue(null);

    startNotifier(bot as never, null, "ns-noid", redis as never, undefined, undefined, () => undefined);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("uses getActiveChatId when chatId is null", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "dynamic notify" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, null, "ns-dynamic", redis as never, undefined, undefined, () => 42);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(42, "dynamic notify");
  });

  it("calls forwardNotification (not handleUserMessage) for each polled notify item", async () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const forwardNotification = vi.fn();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "Task complete" }))
      .mockResolvedValueOnce(JSON.stringify({ text: "Another job done" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 555, "ns-hum", redis as never, handleUserMessage, forwardNotification);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(555, "Task complete");
    expect(bot.sendMessage).toHaveBeenCalledWith(555, "Another job done");
    expect(forwardNotification).toHaveBeenCalledWith(555, "Task complete");
    expect(forwardNotification).toHaveBeenCalledWith(555, "Another job done");
    expect(forwardNotification).toHaveBeenCalledTimes(2);
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it("does not call handleUserMessage when it is undefined (poll path)", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "Silent notify" }))
      .mockResolvedValue(null);

    // No handleUserMessage — should not throw
    startNotifier(bot as never, 555, "ns-nohum", redis as never);

    await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.not.toThrow();
    expect(bot.sendMessage).toHaveBeenCalledWith(555, "Silent notify");
  });

  it("continues gracefully when rpop throws", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop.mockRejectedValue(new Error("connection lost"));

    startNotifier(bot as never, 123, "ns-err", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("does not call forwardNotification when it is undefined (poll path)", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "Silent notify" }))
      .mockResolvedValue(null);

    // No forwardNotification — should not throw
    startNotifier(bot as never, 555, "ns-nofwd", redis as never);

    await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.not.toThrow();
    expect(bot.sendMessage).toHaveBeenCalledWith(555, "Silent notify");
  });
});

describe("parseNotification", () => {
  it("returns raw string when input is not JSON", () => {
    expect(parseNotification("plain text")).toBe("plain text");
  });

  it("extracts text field from JSON", () => {
    expect(parseNotification(JSON.stringify({ text: "Job done" }))).toBe("Job done");
  });

  it("adds [claude] badge when driver is 'claude'", () => {
    expect(parseNotification(JSON.stringify({ text: "Job done", driver: "claude" }))).toBe("Job done\n[claude]");
  });

  it("strips driver prefix from model in claude badge", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "claude", model: "claude-sonnet-4-6" }))
    ).toBe("Job done\n[claude:sonnet-4-6]");
  });

  it("adds no badge when driver is absent", () => {
    expect(parseNotification(JSON.stringify({ text: "Job done" }))).toBe("Job done");
  });

  it("appends [driver:model] badge when driver and model are set", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "openrouter", model: "qwen2.5-72b" }))
    ).toBe("Job done\n[openrouter:qwen2.5-72b]");
  });

  it("appends driver-only badge when model is absent", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "openai" }))
    ).toBe("Job done\n[openai]");
  });

  it("appends driver-only badge when model is empty string", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "openai", model: "" }))
    ).toBe("Job done\n[openai]");
  });

  it("strips vendor/ prefix from model name", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "openrouter", model: "openai/gpt-4o" }))
    ).toBe("Job done\n[openrouter:gpt-4o]");
  });

  it("appends cost when cost field is present", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Job done", driver: "claude", model: "claude-sonnet-4-6", cost: 1.234 }))
    ).toBe("Job done\n[claude:sonnet-4-6] cost: $1.234");
  });

  it("appends cost without badge when driver is absent but cost is present", () => {
    // driver absent → no badge; cost not shown either (no driver = raw text path)
    expect(
      parseNotification(JSON.stringify({ text: "Job done", cost: 0.5 }))
    ).toBe("Job done");
  });

  it("formats cost to 3 decimal places", () => {
    expect(
      parseNotification(JSON.stringify({ text: "Done", driver: "openai", cost: 0.04 }))
    ).toBe("Done\n[openai] cost: $0.040");
  });

  it("returns raw string when JSON has no text field", () => {
    expect(parseNotification(JSON.stringify({ foo: "bar" }))).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("pub/sub handler calls forwardNotification (not handleUserMessage) with same text sent to Telegram", () => {
    const bot = makeBot();
    const redis = makeRedis();
    const handleUserMessage = vi.fn();
    const forwardNotification = vi.fn();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 456, "myns", redis as never, handleUserMessage, forwardNotification);

    messageHandler!("cca:notify:myns", "Job done: my-task");
    expect(bot.sendMessage).toHaveBeenCalledWith(456, "Job done: my-task");
    expect(forwardNotification).toHaveBeenCalledWith(456, "Job done: my-task");
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it("pub/sub handler does not call handleUserMessage when it is undefined", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    // No handleUserMessage passed — should not throw
    startNotifier(bot as never, 456, "myns", redis as never);

    expect(() => messageHandler!("cca:notify:myns", "Job done")).not.toThrow();
    expect(bot.sendMessage).toHaveBeenCalledWith(456, "Job done");
  });

  it("pub/sub handler skips discord_only:true notifications (nothing sent to Telegram)", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 456, "myns", redis as never);

    messageHandler!("cca:notify:myns", JSON.stringify({ text: "hello", discord_only: true }));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("pub/sub handler sends discord_only:false notifications normally", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 456, "myns", redis as never);

    messageHandler!("cca:notify:myns", JSON.stringify({ text: "hello", discord_only: false }));
    expect(bot.sendMessage).toHaveBeenCalledWith(456, "hello");
  });

  it("pub/sub handler uses parseNotification — JSON badge appears in sent message", () => {
    // This is an integration check through the message handler
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 42, "ns", redis as never);
    messageHandler!("cca:notify:ns", JSON.stringify({ text: "Task done", driver: "openrouter", model: "qwen2.5-72b" }));

    expect(bot.sendMessage).toHaveBeenCalledWith(42, "Task done\n[openrouter:qwen2.5-72b]");
  });

  it("pub/sub handler includes cost badge", () => {
    const bot = makeBot();
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") {
        messageHandler = handler as (channel: string, message: string) => void;
      }
    });

    startNotifier(bot as never, 42, "ns2", redis as never);
    messageHandler!("cca:notify:ns2", JSON.stringify({ text: "✅ done", driver: "claude", model: "claude-sonnet-4-6", cost: 1.23 }));

    expect(bot.sendMessage).toHaveBeenCalledWith(42, "✅ done\n[claude:sonnet-4-6] cost: $1.230");
  });
});

describe("isDiscordOnly", () => {
  it("returns false for plain string", () => {
    expect(isDiscordOnly("plain text")).toBe(false);
  });

  it("returns false when discord_only is absent", () => {
    expect(isDiscordOnly(JSON.stringify({ text: "hello" }))).toBe(false);
  });

  it("returns false when discord_only is false", () => {
    expect(isDiscordOnly(JSON.stringify({ text: "hello", discord_only: false }))).toBe(false);
  });

  it("returns true when discord_only is true", () => {
    expect(isDiscordOnly(JSON.stringify({ text: "hello", discord_only: true }))).toBe(true);
  });

  it("returns false for invalid JSON", () => {
    expect(isDiscordOnly("{bad json")).toBe(false);
  });
});

describe("notify list poller — discord_only filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips discord_only:true items in the list (nothing sent to Telegram)", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "discord only", discord_only: true }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 111, "ns-discord", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("sends items without discord_only flag normally", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "normal notification" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 222, "ns-normal", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(222, "normal notification");
  });

  it("sends items with discord_only:false normally", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "not discord only", discord_only: false }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 333, "ns-not-discord", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(333, "not discord only");
  });

  it("skips discord_only items but still sends regular items in the same batch", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "send me", discord_only: false }))
      .mockResolvedValueOnce(JSON.stringify({ text: "skip me", discord_only: true }))
      .mockResolvedValueOnce(JSON.stringify({ text: "send me too" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 444, "ns-mixed", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.sendMessage).toHaveBeenCalledWith(444, "send me");
    expect(bot.sendMessage).toHaveBeenCalledWith(444, "send me too");
  });
});

describe("shouldSkipForTelegram", () => {
  it("returns false for plain string", () => {
    expect(shouldSkipForTelegram("plain text")).toBe(false);
  });

  it("returns false when routing is absent", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello" }))).toBe(false);
  });

  it("returns false when routing is empty array", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", routing: [] }))).toBe(false);
  });

  it("returns false when routing includes telegram", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", routing: ["telegram"] }))).toBe(false);
  });

  it("returns false when routing includes telegram and discord", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", routing: ["discord", "telegram"] }))).toBe(false);
  });

  it("returns true when routing is discord only", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", routing: ["discord"] }))).toBe(true);
  });

  it("returns true when routing has other targets but not telegram", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", routing: ["slack", "email"] }))).toBe(true);
  });

  it("returns true when discord_only is true (legacy flag)", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", discord_only: true }))).toBe(true);
  });

  it("returns false when discord_only is false and no routing", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", discord_only: false }))).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    expect(shouldSkipForTelegram("{bad json")).toBe(false);
  });

  it("discord_only:true takes priority even when routing includes telegram", () => {
    expect(shouldSkipForTelegram(JSON.stringify({ text: "hello", discord_only: true, routing: ["telegram"] }))).toBe(true);
  });
});

describe("routing field — pub/sub handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      rpush: mockRpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  function captureMessageHandler() {
    let handler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, h: unknown) => {
      if (event === "message") handler = h as typeof handler;
    });
    return (channel: string, message: string) => {
      if (!handler) throw new Error("message handler not registered");
      handler(channel, message);
    };
  }

  it('sends when routing is absent', () => {
    const bot = makeBot();
    const redis = makeRedis();
    const send = captureMessageHandler();
    startNotifier(bot as never, 1, "ns", redis as never);
    send("cca:notify:ns", JSON.stringify({ text: "hello" }));
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('sends when routing: ["telegram"]', () => {
    const bot = makeBot();
    const redis = makeRedis();
    const send = captureMessageHandler();
    startNotifier(bot as never, 1, "ns", redis as never);
    send("cca:notify:ns", JSON.stringify({ text: "hello", routing: ["telegram"] }));
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('skips when routing: ["discord"]', () => {
    const bot = makeBot();
    const redis = makeRedis();
    const send = captureMessageHandler();
    startNotifier(bot as never, 1, "ns", redis as never);
    send("cca:notify:ns", JSON.stringify({ text: "hello", routing: ["discord"] }));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends when routing: ["discord", "telegram"]', () => {
    const bot = makeBot();
    const redis = makeRedis();
    const send = captureMessageHandler();
    startNotifier(bot as never, 1, "ns", redis as never);
    send("cca:notify:ns", JSON.stringify({ text: "hello", routing: ["discord", "telegram"] }));
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('sends when routing is empty array', () => {
    const bot = makeBot();
    const redis = makeRedis();
    const send = captureMessageHandler();
    startNotifier(bot as never, 1, "ns", redis as never);
    send("cca:notify:ns", JSON.stringify({ text: "hello", routing: [] }));
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });
});

describe("routing field — list poller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends when routing is absent', async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello" })).mockResolvedValue(null);
    startNotifier(bot as never, 1, "ns", redis as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('sends when routing: ["telegram"]', async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello", routing: ["telegram"] })).mockResolvedValue(null);
    startNotifier(bot as never, 1, "ns", redis as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('skips when routing: ["discord"]', async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello", routing: ["discord"] })).mockResolvedValue(null);
    startNotifier(bot as never, 1, "ns", redis as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends when routing: ["discord", "telegram"]', async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello", routing: ["discord", "telegram"] })).mockResolvedValue(null);
    startNotifier(bot as never, 1, "ns", redis as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });

  it('sends when routing is empty array', async () => {
    const bot = makeBot();
    const redis = makeRedis();
    mockRpop.mockResolvedValueOnce(JSON.stringify({ text: "hello", routing: [] })).mockResolvedValue(null);
    startNotifier(bot as never, 1, "ns", redis as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello");
  });
});

describe("writeChatLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes message to Redis log and publishes to outgoing channel", () => {
    const redis = {
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
    };

    const msg: ChatMessage = {
      id: "test-1",
      source: "telegram",
      role: "user",
      content: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      chatId: 42,
    };

    writeChatLog(redis as never, "myns", msg);

    expect(mockLpush).toHaveBeenCalledWith("cca:chat:log:myns", JSON.stringify(msg));
    expect(mockLtrim).toHaveBeenCalledWith("cca:chat:log:myns", 0, 499);
    expect(mockPublish).toHaveBeenCalledWith("cca:chat:outgoing:myns", JSON.stringify(msg));
  });

  it("logs console.warn when lpush fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockLpush.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const redis = { lpush: mockLpush, ltrim: mockLtrim, publish: mockPublish };
    const msg: ChatMessage = {
      id: "2", source: "telegram", role: "user", content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z", chatId: 42,
    };

    writeChatLog(redis as never, "ns", msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "writeChatLog lpush failed:", "ECONNREFUSED");
    warnSpy.mockRestore();
  });

  it("logs console.warn when ltrim fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockLtrim.mockRejectedValueOnce(new Error("ltrim timeout"));
    const redis = { lpush: mockLpush, ltrim: mockLtrim, publish: mockPublish };
    const msg: ChatMessage = {
      id: "3", source: "telegram", role: "user", content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z", chatId: 42,
    };

    writeChatLog(redis as never, "ns", msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "writeChatLog ltrim failed:", "ltrim timeout");
    warnSpy.mockRestore();
  });

  it("logs console.warn when publish fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPublish.mockRejectedValueOnce(new Error("publish error"));
    const redis = { lpush: mockLpush, ltrim: mockLtrim, publish: mockPublish };
    const msg: ChatMessage = {
      id: "4", source: "telegram", role: "user", content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z", chatId: 42,
    };

    writeChatLog(redis as never, "ns", msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "writeChatLog publish failed:", "publish error");
    warnSpy.mockRestore();
  });
});

describe("subscribe / psubscribe error callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      rpush: mockRpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  it("logs console.error when subscribe callback returns an error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First subscribe call (notifyChannel) gets an error
    mockSubscribe.mockImplementationOnce((_channel: string, cb?: (err: Error | null) => void) => {
      if (cb) cb(new Error("connection refused"));
      return Promise.resolve(0);
    });

    const bot = makeBot();
    const redis = makeRedis();
    startNotifier(bot as never, 123, "default", redis as never);

    expect(errorSpy).toHaveBeenCalledWith(
      "[notifier]",
      "subscribe cca:notify:default failed:",
      "connection refused"
    );
    errorSpy.mockRestore();
  });

  it("logs console.error when psubscribe callback returns an error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPsubscribe.mockImplementationOnce((_pattern: string, cb?: (err: Error | null) => void) => {
      if (cb) cb(new Error("psubscribe denied"));
      return Promise.resolve(0);
    });

    const bot = makeBot();
    const redis = makeRedis();
    startNotifier(bot as never, 123, "default", redis as never);

    expect(errorSpy).toHaveBeenCalledWith(
      "[notifier]",
      "psubscribe cca:chat:outgoing:* failed:",
      "psubscribe denied"
    );
    errorSpy.mockRestore();
  });

  it("logs console.warn when subscriber emits an error event", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let errorHandler: ((err: Error) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "error") errorHandler = handler as (err: Error) => void;
    });

    const bot = makeBot();
    const redis = makeRedis();
    startNotifier(bot as never, 123, "default", redis as never);

    expect(errorHandler).toBeDefined();
    errorHandler!(new Error("Redis connection lost"));

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "subscriber error:", "Redis connection lost");
    warnSpy.mockRestore();
  });
});

describe("sendMessage error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue(null);
    mockRpop.mockResolvedValue(null);
    mockLlen.mockResolvedValue(0);
    const sub = {
      subscribe: mockSubscribe,
      psubscribe: mockPsubscribe,
      on: mockOn,
      lpush: mockLpush,
      rpush: mockRpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs warn when notify channel sendMessage fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    bot.sendMessage.mockRejectedValueOnce(new Error("Telegram 429"));
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") messageHandler = handler as typeof messageHandler;
    });

    startNotifier(bot as never, 999, "notify-err", redis as never);
    messageHandler!("cca:notify:notify-err", "Job done");

    // Flush the microtask queue so .catch fires
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "sendMessage failed:", "Telegram 429");
  });

  it("logs warn when UI echo sendMessage fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    bot.sendMessage.mockRejectedValueOnce(new Error("Telegram timeout"));
    const redis = makeRedis();

    let messageHandler: ((channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "message") messageHandler = handler as typeof messageHandler;
    });

    startNotifier(bot as never, 888, "ui-err", redis as never);
    messageHandler!("cca:chat:incoming:ui-err", "hello");

    // Flush microtask queue (the .catch fires asynchronously)
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "sendMessage (UI echo) failed:", "Telegram timeout");
  });

  it("logs warn when notify list sendMessage fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    bot.sendMessage.mockRejectedValue(new Error("rate limited"));
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "Done" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, 777, "poll-err", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "notify list sendMessage failed:", "rate limited");
  });

  it("logs warn when llen fails after draining 20 items", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    const redis = makeRedis();

    // Fill exactly 20 items so llen is called
    const items = Array.from({ length: 20 }, () => JSON.stringify({ text: "msg" }));
    mockRpop.mockImplementation(() => {
      const item = items.shift();
      return Promise.resolve(item ?? null);
    });
    mockLlen.mockRejectedValueOnce(new Error("llen failed"));

    startNotifier(bot as never, 111, "llen-err", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "notify list llen failed:", "llen failed");
  });

  it("logs warn when summary sendMessage fails (overflow path)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    // First 20 sendMessages succeed, the summary fails
    bot.sendMessage
      .mockResolvedValue({}) // regular messages ok
      .mockRejectedValueOnce(new Error("summary rate limit")); // summary fails
    // Actually sendMessage is called in order, so summary is call #21
    // Re-mock: first 20 succeed, 21st (summary) fails
    bot.sendMessage.mockReset();
    bot.sendMessage.mockImplementation((_chatId: unknown, text: unknown) => {
      if (typeof text === "string" && text.includes("more notifications")) {
        return Promise.reject(new Error("summary rate limit"));
      }
      return Promise.resolve({});
    });
    const redis = makeRedis();

    const items = Array.from({ length: 20 }, () => JSON.stringify({ text: "msg" }));
    mockRpop.mockImplementation(() => {
      const item = items.shift();
      return Promise.resolve(item ?? null);
    });
    mockLlen.mockResolvedValue(5);

    startNotifier(bot as never, 222, "summary-err", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(warnSpy).toHaveBeenCalledWith("[notifier]", "notify list summary sendMessage failed:", "summary rate limit");
  });

  it("logs warn when flushMetaAgentBuffer sendMessage fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = makeBot();
    bot.sendMessage.mockRejectedValue(new Error("flush failed"));
    const redis = makeRedis();

    let pmessageHandler: ((pattern: string, channel: string, message: string) => void) | undefined;
    mockOn.mockImplementation((event: string, handler: unknown) => {
      if (event === "pmessage") pmessageHandler = handler as typeof pmessageHandler;
    });

    startNotifier(bot as never, 333, "flush-err", redis as never);

    pmessageHandler!("cca:chat:outgoing:*", "cca:chat:outgoing:flush-err",
      JSON.stringify({ source: "claude", content: "hello from meta-agent" }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(warnSpy).toHaveBeenCalledWith(
      "[notifier]",
      "meta-agent flush sendMessage failed (ns=flush-err):",
      "flush failed"
    );
  });
});
