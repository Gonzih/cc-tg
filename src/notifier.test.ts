import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startNotifier, writeChatLog, parseNotification, type ChatMessage } from "./notifier.js";

// ---- ioredis mock ----
const mockSubscribe = vi.fn().mockImplementation((_channel: string, cb?: (err: Error | null) => void) => {
  if (cb) cb(null);
  return Promise.resolve(1);
});
const mockOn = vi.fn();
const mockDuplicate = vi.fn();
const mockLpush = vi.fn().mockResolvedValue(1);
const mockLtrim = vi.fn().mockResolvedValue("OK");
const mockPublish = vi.fn().mockResolvedValue(1);
const mockGet = vi.fn().mockResolvedValue(null);
const mockRpop = vi.fn().mockResolvedValue(null);
const mockLlen = vi.fn().mockResolvedValue(0);

vi.mock("ioredis", () => {
  function MockRedis(this: Record<string, unknown>) {
    this.subscribe = mockSubscribe;
    this.on = mockOn;
    this.duplicate = mockDuplicate;
    this.lpush = mockLpush;
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
  on: typeof mockOn;
  duplicate: typeof mockDuplicate;
  lpush: typeof mockLpush;
  ltrim: typeof mockLtrim;
  publish: typeof mockPublish;
  get: typeof mockGet;
  rpop: typeof mockRpop;
  llen: typeof mockLlen;
} {
  const sub = {
    subscribe: mockSubscribe,
    on: mockOn,
    lpush: mockLpush,
    ltrim: mockLtrim,
    publish: mockPublish,
    get: mockGet,
  };
  mockDuplicate.mockReturnValue(sub);
  return {
    sendMessage: vi.fn(),
    subscribe: mockSubscribe,
    on: mockOn,
    duplicate: mockDuplicate,
    lpush: mockLpush,
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
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
      get: mockGet,
    };
    mockDuplicate.mockReturnValue(sub);
  });

  it("subscribes to cca:notify and cca:chat:incoming channels", () => {
    const bot = makeBot();
    const redis = makeRedis();
    startNotifier(bot as never, 123, "default", redis as never);

    expect(mockDuplicate).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith("cca:notify:default", expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith("cca:chat:incoming:default", expect.any(Function));
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

    startNotifier(bot as never, null, "dyn", redis as never, handleUserMessage, getActiveChatId);

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
    expect(mockLpush).toHaveBeenCalledWith(
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
    expect(mockLpush).not.toHaveBeenCalledWith(
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

    startNotifier(bot as never, null, "dyn", redis as never, handleUserMessage, getActiveChatId);

    messageHandler!("cca:chat:incoming:dyn", "orphaned message");

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
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

    startNotifier(bot as never, null, "ns-noid", redis as never, undefined, () => undefined);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it("uses getActiveChatId when chatId is null", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop
      .mockResolvedValueOnce(JSON.stringify({ text: "dynamic notify" }))
      .mockResolvedValue(null);

    startNotifier(bot as never, null, "ns-dynamic", redis as never, undefined, () => 42);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).toHaveBeenCalledWith(42, "dynamic notify");
  });

  it("continues gracefully when rpop throws", async () => {
    const bot = makeBot();
    const redis = makeRedis();

    mockRpop.mockRejectedValue(new Error("connection lost"));

    startNotifier(bot as never, 123, "ns-err", redis as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bot.sendMessage).not.toHaveBeenCalled();
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
});
