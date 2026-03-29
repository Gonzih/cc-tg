import { describe, it, expect, vi, beforeEach } from "vitest";
import { startNotifier, writeChatLog, type ChatMessage } from "./notifier.js";

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

vi.mock("ioredis", () => {
  function MockRedis(this: Record<string, unknown>) {
    this.subscribe = mockSubscribe;
    this.on = mockOn;
    this.duplicate = mockDuplicate;
    this.lpush = mockLpush;
    this.ltrim = mockLtrim;
    this.publish = mockPublish;
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
} {
  const sub = {
    subscribe: mockSubscribe,
    on: mockOn,
    lpush: mockLpush,
    ltrim: mockLtrim,
    publish: mockPublish,
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
  };
}

describe("startNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const sub = {
      subscribe: mockSubscribe,
      on: mockOn,
      lpush: mockLpush,
      ltrim: mockLtrim,
      publish: mockPublish,
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

  it("echoes UI messages to Telegram and calls handleUserMessage", () => {
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

    expect(bot.sendMessage).toHaveBeenCalledWith(789, "📱 [from UI]: hello from UI");
    expect(handleUserMessage).toHaveBeenCalledWith(789, "hello from UI");
  });

  it("parses JSON content from incoming UI message", () => {
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

    expect(bot.sendMessage).toHaveBeenCalledWith(111, "📱 [from UI]: extracted content");
    expect(handleUserMessage).toHaveBeenCalledWith(111, "extracted content");
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
