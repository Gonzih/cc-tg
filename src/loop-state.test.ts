/**
 * Tests for loop state tracking: classifyMessage, checkCompletionGate, and
 * the loop flow wired into CcTgBot.handleClaudeMessage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Hoisted stubs
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  tgSendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  tgSendChatAction: vi.fn().mockResolvedValue({}),
  tgSetMyCommands: vi.fn().mockResolvedValue({}),
  tgStopPolling: vi.fn(),
  tgGetMe: vi.fn().mockResolvedValue({ id: 999, username: "testbot" }),
  claudeInstance: null as null | ClaudeStub,
  existsSyncMock: vi.fn().mockReturnValue(false),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024, isFile: () => true }),
  readFileSyncMock: vi.fn().mockReturnValue("{}"),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  execSyncMock: vi.fn().mockReturnValue(""),
}));

class ClaudeStub extends EventEmitter {
  sendPrompt = vi.fn();
  sendImage = vi.fn();
  kill = vi.fn();
  exited = false;
}

vi.mock("node-telegram-bot-api", () => ({
  default: vi.fn(function MockTelegramBot() {
    return {
      on: vi.fn(),
      sendMessage: mocks.tgSendMessage,
      sendChatAction: mocks.tgSendChatAction,
      setMyCommands: mocks.tgSetMyCommands,
      stopPolling: mocks.tgStopPolling,
      getMe: mocks.tgGetMe,
      sendDocument: vi.fn().mockResolvedValue({}),
      getFileLink: vi.fn().mockResolvedValue("https://example.com/file"),
    };
  }),
}));

vi.mock("./claude.js", () => ({
  ClaudeProcess: vi.fn(function MockClaudeProcess() {
    const inst = new ClaudeStub();
    mocks.claudeInstance = inst;
    return inst;
  }),
  extractText: vi.fn(function extractText(msg: Record<string, unknown>) {
    const payload = msg.payload as Record<string, unknown>;
    if (msg.type === "result") return (payload?.result as string) ?? "";
    return "";
  }),
}));

vi.mock("./voice.js", () => ({
  isVoiceAvailable: vi.fn().mockReturnValue(false),
  transcribeVoice: vi.fn().mockResolvedValue(""),
}));

vi.mock("./cron.js", () => ({
  CronManager: vi.fn(function MockCronManager() {
    return { list: vi.fn().mockReturnValue([]), add: vi.fn(), remove: vi.fn(), clearAll: vi.fn(), update: vi.fn() };
  }),
}));

vi.mock("./notifier.js", () => ({
  writeChatLog: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    readFileSync: mocks.readFileSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    readdirSync: vi.fn().mockReturnValue([]),
    createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), end: vi.fn() }),
  };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execSync: mocks.execSyncMock, spawn: vi.fn() };
});

import { classifyMessage, checkCompletionGate, CcTgBot } from "./bot.js";

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------
describe("classifyMessage", () => {
  it("classifies imperative goal verbs as goal", () => {
    expect(classifyMessage("implement it now")).toBe("goal");
    expect(classifyMessage("Add loop state to sessions")).toBe("goal");
    expect(classifyMessage("fix the bug in bot.ts")).toBe("goal");
    expect(classifyMessage("deploy the release")).toBe("goal");
    expect(classifyMessage("publish the npm package now")).toBe("goal");
  });

  it("classifies explicit loop/verify intent as goal", () => {
    expect(classifyMessage("please iterate until it passes")).toBe("goal");
    expect(classifyMessage("verify the PR was merged")).toBe("goal");
  });

  it("classifies file references as goal", () => {
    expect(classifyMessage("update the config in settings.json")).toBe("goal");
    expect(classifyMessage("review changes to src/bot.ts file")).toBe("goal");
  });

  it("classifies VCS references as goal", () => {
    expect(classifyMessage("create a pull request for this change")).toBe("goal");
    expect(classifyMessage("merge the branch and npm publish")).toBe("goal");
  });

  it("classifies question-word prefixes as question", () => {
    expect(classifyMessage("what is the current version?")).toBe("question");
    expect(classifyMessage("How does the loop state work?")).toBe("question");
    expect(classifyMessage("why is the test failing")).toBe("question");
    expect(classifyMessage("can you explain this?")).toBe("question");
  });

  it("classifies messages ending with ? as question", () => {
    expect(classifyMessage("Please implement this feature?")).toBe("question");
  });

  it("classifies short messages as question", () => {
    expect(classifyMessage("fix it")).toBe("question");
    expect(classifyMessage("go")).toBe("question");
  });

  it("classifies slash-commands as question", () => {
    expect(classifyMessage("/compact")).toBe("question");
    expect(classifyMessage("/effort high")).toBe("question");
  });

  it("classifies ambiguous long non-imperative messages as question", () => {
    expect(classifyMessage("the session seems to hang sometimes when the context is large")).toBe("question");
  });
});

// ---------------------------------------------------------------------------
// checkCompletionGate
// ---------------------------------------------------------------------------
describe("checkCompletionGate", () => {
  it("passes on GitHub PR URL", () => {
    const result = checkCompletionGate(
      "Done! PR created: https://github.com/Gonzih/cc-tg/pull/123"
    );
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("pr_url");
  });

  it("passes on npm publish confirmation with version", () => {
    const result = checkCompletionGate("npm publish successful @gonzih/cc-tg@0.9.63");
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("npm_published");
  });

  it("passes on merge confirmation", () => {
    const result = checkCompletionGate("PR merged successfully into main.");
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("merge_confirmed");
  });

  it("passes on AGENT_SCORE line", () => {
    const result = checkCompletionGate("Work complete.\n\nAGENT_SCORE: 1.0");
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("agent_score");
  });

  it("passes on release tag pattern", () => {
    const result = checkCompletionGate("Tagged and released v1.2.3");
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("released");
  });

  it("fails when response contains no completion signal", () => {
    const result = checkCompletionGate(
      "I've started working on the implementation. Here is the plan:\n1. Add interface\n2. Wire up handlers"
    );
    expect(result.passed).toBe(false);
    expect(result.gate).toBe("completion_signal");
    expect(result.reason).toBeTruthy();
  });

  it("fails on partial progress with no artifact", () => {
    const result = checkCompletionGate("Created branch feat/my-feature and pushed changes.");
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loop flow integration tests — CcTgBot
// ---------------------------------------------------------------------------

function makeMsg(overrides: Record<string, unknown> = {}) {
  return { chat: { id: 42 }, from: { id: 100 }, text: "hello", ...overrides };
}

function emitResult(text: string) {
  mocks.claudeInstance!.emit("message", { type: "result", payload: { result: text }, raw: {} });
}

describe("CcTgBot — loop state flow", () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue("{}");
    bot = new CcTgBot({ telegramToken: "tok" });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it("does NOT initialize loopState for question-classified messages", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "what is the status?" }));
    // Session is created but loopState must not be initialized for questions
    const session = [...(bot as any).sessions.values()][0];
    if (session) {
      expect(session.loopState).toBeUndefined();
    }
    // Confirm classifyMessage correctly returns "question" for this input
    expect(classifyMessage("what is the status?")).toBe("question");
  });

  it("initializes loopState for goal-classified messages", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the loop state tracking feature" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session).toBeDefined();
    expect(session.loopState).toBeDefined();
    expect(session.loopState.goal).toBe("implement the loop state tracking feature");
    expect(session.loopState.iteration).toBe(0);
    expect(session.loopState.max_iterations).toBe(3);
    expect(session.loopState.gate_failures).toEqual([]);
  });

  it("flushes response to user when completion gate passes", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the feature in src/bot.ts" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session.loopState).toBeDefined();

    // Emit a result with a PR URL (passes gate)
    emitResult("Done! https://github.com/Gonzih/cc-tg/pull/42");

    // flushTimer fires after FLUSH_DELAY_MS
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    // loopState should be cleared
    expect(session.loopState).toBeUndefined();
    // Message should be flushed to user
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("https://github.com/Gonzih/cc-tg/pull/42"),
      expect.anything()
    );
  });

  it("re-prompts Claude (no user flush) when gate fails and iterations remain", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the feature in src/bot.ts" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session.loopState).toBeDefined();

    mocks.claudeInstance!.sendPrompt.mockClear();

    // Emit a result with no completion signal
    emitResult("I've started working on the feature. Here is the initial plan.");

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    // No message sent to Telegram
    expect(mocks.tgSendMessage).not.toHaveBeenCalled();
    // Claude was re-prompted
    expect(mocks.claudeInstance!.sendPrompt).toHaveBeenCalledWith(
      expect.stringContaining("[loop-iteration-1/3]")
    );
    // iteration incremented, gate_failures recorded
    expect(session.loopState).toBeDefined();
    expect(session.loopState!.iteration).toBe(1);
    expect(session.loopState!.gate_failures).toHaveLength(1);
    expect(session.loopState!.gate_failures[0].gate).toBe("completion_signal");
  });

  it("flushes with exhaustion trace when max_iterations reached", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the feature in src/bot.ts" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session.loopState).toBeDefined();

    const noCompletionText = "Still working on it, no PR yet.";

    // max_iterations=3 means 3 responses trigger exhaustion:
    //   response 1: iteration 0→1 (re-prompt)
    //   response 2: iteration 1→2 (re-prompt)
    //   response 3: iteration 2→3, 3 >= 3 → exhaust
    for (let i = 0; i < 3; i++) {
      mocks.claudeInstance!.sendPrompt.mockClear();
      emitResult(noCompletionText);
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    }

    // Advance enough for the flush debounce to fire on the exhaustion result
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(session.loopState).toBeUndefined();
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("[loop exhausted after 3 iterations — handing off]"),
      expect.anything()
    );
    // Should also include the failure trace
    const flushedText = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(flushedText).toContain("Gate failure trace:");
  });

  it("does not enter loop mode for session-less reply (question short message)", async () => {
    // Short message = question classification, no loopState
    await (bot as any).handleTelegram(makeMsg({ text: "hello?" }));
    // No sessions created (text is a question)
    const sessions = [...(bot as any).sessions.values()];
    // If session was somehow created, it should have no loopState
    for (const s of sessions) {
      expect(s.loopState).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// /loop_status and /loop_stop commands
// ---------------------------------------------------------------------------
describe("CcTgBot — /loop_status and /loop_stop", () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue("{}");
    bot = new CcTgBot({ telegramToken: "tok" });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it("/loop_status returns 'No active session.' when no session", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_status" }));
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, "No active session.");
  });

  it("/loop_stop returns 'No active session.' when no session", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_stop" }));
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, "No active session.");
  });

  it("/loop_status returns 'No active loop.' when session has no loop", async () => {
    // Create session via a question message
    await (bot as any).handleTelegram(makeMsg({ text: "what is the current status of the project?" }));
    vi.clearAllMocks();
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_status" }));
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, "No active loop.");
  });

  it("/loop_stop returns 'No active loop.' when session has no loop", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "what is the current status of the project?" }));
    vi.clearAllMocks();
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_stop" }));
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, "No active loop.");
  });

  it("/loop_status shows goal and iteration when loop is active", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the feature in src/bot.ts" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session.loopState).toBeDefined();

    // Fail once to increment iteration
    emitResult("Still working, no PR yet.");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    vi.clearAllMocks();
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_status" }));

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("Loop active");
    expect(msg).toContain("implement the feature in src/bot.ts");
    expect(msg).toContain("1/3");
  });

  it("/loop_stop clears loopState and confirms", async () => {
    await (bot as any).handleTelegram(makeMsg({ text: "implement the feature in src/bot.ts" }));
    const session = [...(bot as any).sessions.values()][0];
    expect(session.loopState).toBeDefined();

    vi.clearAllMocks();
    await (bot as any).handleTelegram(makeMsg({ text: "/loop_stop" }));

    expect(session.loopState).toBeUndefined();
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, "Loop stopped.");
  });
});
