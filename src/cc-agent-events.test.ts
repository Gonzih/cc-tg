import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleJobEvent,
  buildDecisionPrompt,
  parseDecision,
  writeCoordinatorPlan,
  defaultReadJobOutput,
  defaultReadCoordinatorPlan,
  defaultGetRunningJobCount,
  replayStreamEvents,
  parseStreamFields,
  streamEntryToMessage,
  type JobEvent,
  type HandlerDeps,
  type CoordinatorPlan,
} from "./cc-agent-events.js";

// Mock ioredis for tests that use Redis directly
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockLrange = vi.fn().mockResolvedValue([]);
const mockGet = vi.fn().mockResolvedValue(null);
const mockSet = vi.fn().mockResolvedValue("OK");
const mockXread = vi.fn().mockResolvedValue(null);
const mockScan = vi.fn().mockResolvedValue(["0", []]);
const mockSmembers = vi.fn().mockResolvedValue([]);

vi.mock("ioredis", () => {
  // Must use a regular function (not arrow) so it can be used as a constructor with `new`
  function MockRedis() {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      lrange: mockLrange,
      get: mockGet,
      set: mockSet,
      xread: mockXread,
      scan: mockScan,
      smembers: mockSmembers,
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      on: () => {},
    };
  }
  return { Redis: MockRedis };
});

function makeEvent(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: "job-123",
    status: "done",
    title: "feat: add new feature",
    repoUrl: "https://github.com/foo/bar",
    lastLines: ["All tests pass", "PR merged", "Published v1.2.3"],
    score: 1.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps & {
  askClaude: ReturnType<typeof vi.fn>;
  sendTelegramMessage: ReturnType<typeof vi.fn>;
  spawnFollowupAgent: ReturnType<typeof vi.fn>;
  readJobOutput: ReturnType<typeof vi.fn>;
  readCoordinatorPlan: ReturnType<typeof vi.fn>;
  getRunningJobCount: ReturnType<typeof vi.fn>;
  getActiveChatIds: ReturnType<typeof vi.fn>;
} {
  return {
    askClaude: vi.fn().mockResolvedValue('{"action":"SILENT"}'),
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
    spawnFollowupAgent: vi.fn().mockResolvedValue(undefined),
    readJobOutput: vi.fn().mockResolvedValue([]),
    readCoordinatorPlan: vi.fn().mockResolvedValue(null),
    getRunningJobCount: vi.fn().mockResolvedValue(0),
    getActiveChatIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("handleJobEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Claude with correct prompt for a done event", async () => {
    const deps = makeDeps();
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.askClaude).toHaveBeenCalledOnce();
    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("feat: add new feature");
    expect(prompt).toContain("https://github.com/foo/bar");
    expect(prompt).toContain("done");
    expect(prompt).toContain("NOTIFY_ONLY");
    expect(prompt).toContain("SPAWN_FOLLOWUP");
    expect(prompt).toContain("SILENT");
  });

  it("calls Claude with correct prompt for a failed event", async () => {
    const deps = makeDeps();
    const event = makeEvent({ status: "failed", title: "fix: broken build" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.askClaude).toHaveBeenCalledOnce();
    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("fix: broken build");
    expect(prompt).toContain("failed");
  });

  it("ignores running events — Claude not called", async () => {
    const deps = makeDeps();
    const event = makeEvent({ status: "running" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("ignores cancelled events — Claude not called", async () => {
    const deps = makeDeps();
    const event = makeEvent({ status: "cancelled" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("SILENT — no Telegram send, no spawn", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(JSON.stringify({ action: "SILENT" })),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
    expect(deps.spawnFollowupAgent).not.toHaveBeenCalled();
  });

  it("NOTIFY_ONLY — sends Telegram message to all active chat IDs", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Job done successfully!" })
      ),
      getActiveChatIds: vi.fn().mockResolvedValue([12345]),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).toHaveBeenCalledOnce();
    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(12345, "Job done successfully!");
    expect(deps.spawnFollowupAgent).not.toHaveBeenCalled();
  });

  it("NOTIFY_ONLY — skips silently if no active chat IDs", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Done!" })
      ),
      getActiveChatIds: vi.fn().mockResolvedValue([]),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("NOTIFY_ONLY — uses fallback message if none provided", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY" })
      ),
      getActiveChatIds: vi.fn().mockResolvedValue([99]),
    });
    const event = makeEvent({ title: "my cool job" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(99, "Job completed: my cool job");
  });

  it("SPAWN_FOLLOWUP — calls spawnFollowupAgent with correct params", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "SPAWN_FOLLOWUP",
          followup: { repo_url: "https://github.com/foo/bar", task: "fix the tests" },
        })
      ),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).toHaveBeenCalledOnce();
    expect(deps.spawnFollowupAgent).toHaveBeenCalledWith(
      "https://github.com/foo/bar",
      "fix the tests"
    );
  });

  it("SPAWN_FOLLOWUP — sends Telegram notification to all active chat IDs", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "SPAWN_FOLLOWUP",
          followup: { repo_url: "https://github.com/foo/bar", task: "fix the tests" },
        })
      ),
      getRunningJobCount: vi.fn().mockResolvedValue(3),
      getActiveChatIds: vi.fn().mockResolvedValue([777]),
    });
    const event = makeEvent({ status: "done", score: 0.85, title: "backtesting harness" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).toHaveBeenCalledOnce();
    expect(deps.sendTelegramMessage).toHaveBeenCalledOnce();
    const [chatId, msg] = deps.sendTelegramMessage.mock.calls[0] as [number, string];
    expect(chatId).toBe(777);
    expect(msg).toContain("✓ backtesting harness done");
    expect(msg).toContain("0.85");
    expect(msg).toContain("fix the tests");
    expect(msg).toContain("3 jobs running");
  });

  it("SPAWN_FOLLOWUP — no Telegram when no active chat IDs", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "SPAWN_FOLLOWUP",
          followup: { repo_url: "https://github.com/foo/bar", task: "fix the tests" },
        })
      ),
      getActiveChatIds: vi.fn().mockResolvedValue([]),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).toHaveBeenCalledOnce();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("SPAWN_FOLLOWUP without followup details — logs warning, no crash", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "SPAWN_FOLLOWUP" })
      ),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).not.toHaveBeenCalled();
  });

  it("handles Claude error gracefully — falls back to NOTIFY_ONLY (no chatIds = no telegram)", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
      getActiveChatIds: vi.fn().mockResolvedValue([]),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("Claude error with active chatIds — falls back to NOTIFY_ONLY and sends telegram", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
      getActiveChatIds: vi.fn().mockResolvedValue([42]),
    });
    const event = makeEvent({ status: "done", title: "my job" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(42, "Job completed: my job");
  });

  it("failed job + Claude error — fallback uses failure format", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
      getActiveChatIds: vi.fn().mockResolvedValue([42]),
    });
    const event = makeEvent({ status: "failed", title: "broken build", lastLines: ["error: build failed"] });

    await handleJobEvent(JSON.stringify(event), deps);
    const [, msg] = deps.sendTelegramMessage.mock.calls[0] as [number, string];
    expect(msg).toContain("✗ broken build failed");
    expect(msg).toContain("error: build failed");
  });

  it("handles malformed Claude JSON gracefully — falls back to NOTIFY_ONLY", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue("I cannot decide right now."),
      getActiveChatIds: vi.fn().mockResolvedValue([]),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("handles malformed event message gracefully", async () => {
    const deps = makeDeps();
    await expect(handleJobEvent("not valid json", deps)).resolves.toBeUndefined();
    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("handles Telegram send failure gracefully — no crash", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Done!" })
      ),
      sendTelegramMessage: vi.fn().mockRejectedValue(new Error("Telegram API down")),
      getActiveChatIds: vi.fn().mockResolvedValue([42]),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
  });

  it("calls readJobOutput with the job ID", async () => {
    const deps = makeDeps({
      readJobOutput: vi.fn().mockResolvedValue(["line1", "line2", "## LEARNINGS", "- What worked: X"]),
    });
    const event = makeEvent({ jobId: "job-abc" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.readJobOutput).toHaveBeenCalledWith("job-abc");
  });

  it("uses readJobOutput lines in the prompt", async () => {
    const deps = makeDeps({
      readJobOutput: vi.fn().mockResolvedValue(["REDIS_LINE_1", "REDIS_LINE_2"]),
    });
    const event = makeEvent();
    await handleJobEvent(JSON.stringify(event), deps);

    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("REDIS_LINE_1");
    expect(prompt).toContain("REDIS_LINE_2");
  });

  it("falls back to event.lastLines when readJobOutput returns empty array", async () => {
    const deps = makeDeps({
      readJobOutput: vi.fn().mockResolvedValue([]),
    });
    const event = makeEvent({ lastLines: ["fallback line"] });
    await handleJobEvent(JSON.stringify(event), deps);

    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("fallback line");
  });

  it("falls back gracefully when readJobOutput throws", async () => {
    const deps = makeDeps({
      readJobOutput: vi.fn().mockRejectedValue(new Error("Redis down")),
    });
    const event = makeEvent({ lastLines: ["fallback line"] });
    await handleJobEvent(JSON.stringify(event), deps);

    // Should still proceed using event.lastLines
    expect(deps.askClaude).toHaveBeenCalledOnce();
    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("fallback line");
  });

  it("calls readCoordinatorPlan with the job ID", async () => {
    const deps = makeDeps();
    const event = makeEvent({ jobId: "job-xyz" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.readCoordinatorPlan).toHaveBeenCalledWith("job-xyz");
  });

  it("includes coordinator plan in the prompt when present (no nextStep — slow path)", async () => {
    // Plans without nextStep still go through Claude so it can see the context
    const plan: CoordinatorPlan = {
      summary: "phase 2 of migration — run integration tests next",
    };
    const deps = makeDeps({
      readCoordinatorPlan: vi.fn().mockResolvedValue(plan),
    });
    const event = makeEvent();
    await handleJobEvent(JSON.stringify(event), deps);

    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("phase 2 of migration");
  });

  it("fast path: coordinator plan with nextStep — spawns directly without calling Claude", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue("should not be called"),
      getActiveChatIds: vi.fn().mockResolvedValue([42]),
      readCoordinatorPlan: vi.fn().mockResolvedValue({
        nextStep: { repo_url: "https://github.com/foo/bar", task: "run integration tests" },
        summary: "phase 2",
      }),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.askClaude).not.toHaveBeenCalled();
    expect(deps.spawnFollowupAgent).toHaveBeenCalledWith(
      "https://github.com/foo/bar",
      "run integration tests"
    );
    expect(deps.sendTelegramMessage).toHaveBeenCalledOnce();
  });

  it("fast path: notification message includes title, score, and repo short name", async () => {
    const deps = makeDeps({
      getActiveChatIds: vi.fn().mockResolvedValue([99]),
      readCoordinatorPlan: vi.fn().mockResolvedValue({
        nextStep: { repo_url: "https://github.com/acme/my-service", task: "run smoke tests" },
        summary: "deploy then test",
      }),
    });
    const event = makeEvent({ title: "deploy v2", score: 0.9, status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    const [chatId, msg] = deps.sendTelegramMessage.mock.calls[0] as [number, string];
    expect(chatId).toBe(99);
    expect(msg).toContain("✓ deploy v2 done");
    expect(msg).toContain("0.9");
    expect(msg).toContain("my-service");
  });

  it("fast path: no Telegram when no active chat IDs", async () => {
    const deps = makeDeps({
      getActiveChatIds: vi.fn().mockResolvedValue([]),
      readCoordinatorPlan: vi.fn().mockResolvedValue({
        nextStep: { repo_url: "https://github.com/foo/bar", task: "do thing" },
        summary: "phase 2",
      }),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).toHaveBeenCalledOnce();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("parses markdown-fenced JSON from Claude and fires SPAWN_FOLLOWUP (no coordinator nextStep)", async () => {
    const fencedResponse = [
      "Here is my decision:",
      "```json",
      JSON.stringify({
        action: "SPAWN_FOLLOWUP",
        followup: { repo_url: "https://github.com/foo/bar", task: "run integration tests" },
      }),
      "```",
    ].join("\n");

    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(fencedResponse),
      getActiveChatIds: vi.fn().mockResolvedValue([42]),
      readCoordinatorPlan: vi.fn().mockResolvedValue(null),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.spawnFollowupAgent).toHaveBeenCalledWith(
      "https://github.com/foo/bar",
      "run integration tests"
    );
    expect(deps.sendTelegramMessage).toHaveBeenCalledOnce();
  });

  it("falls back gracefully when readCoordinatorPlan throws", async () => {
    const deps = makeDeps({
      readCoordinatorPlan: vi.fn().mockRejectedValue(new Error("Redis down")),
    });
    const event = makeEvent();
    await handleJobEvent(JSON.stringify(event), deps);

    // Should still proceed without coordinator plan
    expect(deps.askClaude).toHaveBeenCalledOnce();
    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("none"); // coordinator plan fallback
  });
});

describe("buildDecisionPrompt", () => {
  it("includes all required fields", () => {
    const event = makeEvent();
    const prompt = buildDecisionPrompt(event, event.lastLines, null);
    expect(prompt).toContain(event.title);
    expect(prompt).toContain(event.repoUrl);
    expect(prompt).toContain(event.status);
    expect(prompt).toContain(event.lastLines[0]);
    expect(prompt).toContain("NOTIFY_ONLY");
    expect(prompt).toContain("SPAWN_FOLLOWUP");
    expect(prompt).toContain("SILENT");
  });

  it("includes score in prompt", () => {
    const event = makeEvent({ score: 0.75 });
    const prompt = buildDecisionPrompt(event, event.lastLines, null);
    expect(prompt).toContain("0.75");
  });

  it("uses n/a for missing score", () => {
    const event = makeEvent({ score: undefined });
    const prompt = buildDecisionPrompt(event, event.lastLines, null);
    expect(prompt).toContain("n/a");
  });

  it("includes coordinator plan when present", () => {
    const event = makeEvent();
    const plan: CoordinatorPlan = {
      nextStep: { repo_url: "https://github.com/x/y", task: "deploy to prod" },
      summary: "production rollout",
    };
    const prompt = buildDecisionPrompt(event, event.lastLines, plan);
    expect(prompt).toContain("deploy to prod");
    expect(prompt).toContain("production rollout");
  });

  it("shows none for null coordinator plan", () => {
    const event = makeEvent();
    const prompt = buildDecisionPrompt(event, event.lastLines, null);
    expect(prompt).toContain("none");
  });

  it("uses last40lines, not event.lastLines directly", () => {
    const event = makeEvent({ lastLines: ["original"] });
    const last40 = ["redis line 1", "redis line 2"];
    const prompt = buildDecisionPrompt(event, last40, null);
    expect(prompt).toContain("redis line 1");
    expect(prompt).toContain("redis line 2");
  });
});

describe("parseDecision", () => {
  it("parses valid SILENT response", () => {
    const result = parseDecision('{"action":"SILENT"}');
    expect(result.action).toBe("SILENT");
  });

  it("parses valid NOTIFY_ONLY response with message", () => {
    const result = parseDecision('{"action":"NOTIFY_ONLY","message":"All done!"}');
    expect(result.action).toBe("NOTIFY_ONLY");
    expect(result.message).toBe("All done!");
  });

  it("parses JSON embedded in prose", () => {
    const raw = `Here is my decision:\n{"action":"SILENT"}\nDone.`;
    const result = parseDecision(raw);
    expect(result.action).toBe("SILENT");
  });

  it("throws on missing JSON", () => {
    expect(() => parseDecision("No JSON here")).toThrow("No JSON found");
  });

  it("throws on unknown action", () => {
    expect(() => parseDecision('{"action":"UNKNOWN"}')).toThrow("Unknown action");
  });

  it("parses JSON wrapped in ```json fences", () => {
    const raw = "```json\n{\"action\":\"NOTIFY_ONLY\",\"message\":\"all done\"}\n```";
    const result = parseDecision(raw);
    expect(result.action).toBe("NOTIFY_ONLY");
    expect(result.message).toBe("all done");
  });

  it("parses JSON wrapped in plain ``` fences", () => {
    const raw = "```\n{\"action\":\"SILENT\"}\n```";
    const result = parseDecision(raw);
    expect(result.action).toBe("SILENT");
  });
});

describe("defaultReadJobOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockLrange.mockResolvedValue(["line1", "line2"]);
  });

  it("queries the correct Redis key with last 40 lines", async () => {
    const lines = await defaultReadJobOutput("job-abc");
    expect(mockLrange).toHaveBeenCalledWith("cca:job:job-abc:output", -40, -1);
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("disconnects after reading", async () => {
    await defaultReadJobOutput("job-abc");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("disconnects even when lrange throws", async () => {
    mockLrange.mockRejectedValue(new Error("Redis error"));
    await expect(defaultReadJobOutput("job-abc")).rejects.toThrow("Redis error");
    expect(mockDisconnect).toHaveBeenCalled();
  });
});

describe("defaultReadCoordinatorPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("returns null when key does not exist", async () => {
    mockGet.mockResolvedValue(null);
    const result = await defaultReadCoordinatorPlan("job-abc");
    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledWith("cca:coordinator:plan:job-abc");
  });

  it("parses and returns the plan when key exists", async () => {
    const plan: CoordinatorPlan = { nextStep: { repo_url: "https://github.com/x/y", task: "do thing" }, summary: "test plan" };
    mockGet.mockResolvedValue(JSON.stringify(plan));
    const result = await defaultReadCoordinatorPlan("job-abc");
    expect(result).toEqual(plan);
  });

  it("disconnects after reading", async () => {
    mockGet.mockResolvedValue(null);
    await defaultReadCoordinatorPlan("job-abc");
    expect(mockDisconnect).toHaveBeenCalled();
  });
});

describe("defaultGetRunningJobCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockScan.mockResolvedValue(["0", []]);
    mockSmembers.mockResolvedValue([]);
    mockGet.mockResolvedValue(null);
  });

  it("returns 0 when no namespace sets exist", async () => {
    mockScan.mockResolvedValue(["0", []]);
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(0);
  });

  it("returns 0 when namespace set is empty", async () => {
    mockScan.mockResolvedValue(["0", ["cca:jobs:myns"]]);
    mockSmembers.mockResolvedValue([]);
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(0);
    expect(mockSmembers).toHaveBeenCalledWith("cca:jobs:myns");
  });

  it("counts jobs with status=running", async () => {
    mockScan.mockResolvedValue(["0", ["cca:jobs:myns"]]);
    mockSmembers.mockResolvedValue(["job-1", "job-2", "job-3"]);
    mockGet
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "done" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }));
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(2);
    expect(mockGet).toHaveBeenCalledWith("cca:job:job-1");
    expect(mockGet).toHaveBeenCalledWith("cca:job:job-2");
    expect(mockGet).toHaveBeenCalledWith("cca:job:job-3");
  });

  it("deduplicates job IDs across multiple namespace sets", async () => {
    mockScan.mockResolvedValue(["0", ["cca:jobs:ns1", "cca:jobs:ns2"]]);
    mockSmembers
      .mockResolvedValueOnce(["job-1", "job-2"])
      .mockResolvedValueOnce(["job-2", "job-3"]);
    mockGet
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "done" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }));
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(2);
    // job-2 deduplicated — only 3 get calls total
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it("skips jobs with missing or null records", async () => {
    mockScan.mockResolvedValue(["0", ["cca:jobs:myns"]]);
    mockSmembers.mockResolvedValue(["job-1", "job-2"]);
    mockGet
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }))
      .mockResolvedValueOnce(null);
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(1);
  });

  it("skips malformed job JSON without crashing", async () => {
    mockScan.mockResolvedValue(["0", ["cca:jobs:myns"]]);
    mockSmembers.mockResolvedValue(["job-bad", "job-good"]);
    mockGet
      .mockResolvedValueOnce("NOT_JSON")
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }));
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(1);
  });

  it("returns 0 and disconnects when Redis connect fails", async () => {
    mockConnect.mockRejectedValue(new Error("connection refused"));
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(0);
  });

  it("handles paginated SCAN (multiple cursor iterations)", async () => {
    mockScan
      .mockResolvedValueOnce(["42", ["cca:jobs:ns1"]])
      .mockResolvedValueOnce(["0", ["cca:jobs:ns2"]]);
    mockSmembers
      .mockResolvedValueOnce(["job-1"])
      .mockResolvedValueOnce(["job-2"]);
    mockGet
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "running" }));
    const result = await defaultGetRunningJobCount();
    expect(result).toBe(2);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it("disconnects after counting", async () => {
    await defaultGetRunningJobCount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});

describe("writeCoordinatorPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockSet.mockResolvedValue("OK");
  });

  it("writes plan to correct Redis key with 7-day TTL", async () => {
    const plan = { nextStep: { repo_url: "https://github.com/a/b", task: "run tests" }, summary: "phase 2" };
    await writeCoordinatorPlan("job-abc", plan);

    expect(mockSet).toHaveBeenCalledWith(
      "cca:coordinator:plan:job-abc",
      JSON.stringify(plan),
      "EX",
      7 * 24 * 60 * 60
    );
  });

  it("disconnects after writing", async () => {
    await writeCoordinatorPlan("job-abc", { summary: "test" });
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("disconnects even when set throws", async () => {
    mockSet.mockRejectedValue(new Error("Redis error"));
    await expect(writeCoordinatorPlan("job-abc", { summary: "test" })).rejects.toThrow("Redis error");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("works without nextStep", async () => {
    await writeCoordinatorPlan("job-xyz", { summary: "done, no followup needed" });
    expect(mockSet).toHaveBeenCalledWith(
      "cca:coordinator:plan:job-xyz",
      JSON.stringify({ summary: "done, no followup needed" }),
      "EX",
      7 * 24 * 60 * 60
    );
  });
});

describe("parseStreamFields", () => {
  it("converts flat field array to record", () => {
    const result = parseStreamFields(["jobId", "job-1", "status", "done", "title", "my job"]);
    expect(result).toEqual({ jobId: "job-1", status: "done", title: "my job" });
  });

  it("returns empty record for empty array", () => {
    expect(parseStreamFields([])).toEqual({});
  });

  it("ignores trailing unpaired key", () => {
    const result = parseStreamFields(["a", "1", "orphan"]);
    expect(result).toEqual({ a: "1" });
  });
});

describe("streamEntryToMessage", () => {
  it("builds a valid JSON event message from stream fields", () => {
    const fields = {
      jobId: "job-42",
      status: "done",
      title: "feat: new feature",
      repoUrl: "https://github.com/foo/bar",
      lastLines: JSON.stringify(["line1", "line2"]),
      score: "0.85",
      timestamp: "1711234567890",
    };
    const msg = streamEntryToMessage(fields);
    expect(msg).not.toBeNull();
    const event = JSON.parse(msg!) as JobEvent;
    expect(event.jobId).toBe("job-42");
    expect(event.status).toBe("done");
    expect(event.score).toBe(0.85);
    expect(event.lastLines).toEqual(["line1", "line2"]);
  });

  it("returns null score when score field is empty", () => {
    const fields = {
      jobId: "job-1", status: "done", title: "t", repoUrl: "u",
      lastLines: "[]", score: "", timestamp: "0",
    };
    const msg = streamEntryToMessage(fields);
    const event = JSON.parse(msg!) as JobEvent;
    expect(event.score).toBeUndefined();
  });

  it("returns null score when score field is absent", () => {
    const fields = {
      jobId: "job-1", status: "done", title: "t", repoUrl: "u",
      lastLines: "[]", timestamp: "0",
    };
    const msg = streamEntryToMessage(fields);
    const event = JSON.parse(msg!) as JobEvent;
    expect(event.score).toBeUndefined();
  });

  it("returns null on malformed lastLines JSON", () => {
    const fields = {
      jobId: "job-1", status: "done", title: "t", repoUrl: "u",
      lastLines: "not json", timestamp: "0",
    };
    expect(streamEntryToMessage(fields)).toBeNull();
  });
});

describe("replayStreamEvents", () => {
  function makeMockRedis(overrides: Record<string, unknown> = {}) {
    return {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      xread: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when xread returns null (no stream entries)", async () => {
    const redis = makeMockRedis();
    const deps = makeDeps();
    await replayStreamEvents(redis as never, deps, "test-bot");

    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("reads last-id from Redis and passes it to xread", async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue("1234567890-0"),
    });
    const deps = makeDeps();
    await replayStreamEvents(redis as never, deps, "test-bot");

    expect(redis.xread).toHaveBeenCalledWith("COUNT", 20, "STREAMS", "cca:event-stream", "1234567890-0");
  });

  it("uses '0' as default last-id when Redis key is missing", async () => {
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(null) });
    const deps = makeDeps();
    await replayStreamEvents(redis as never, deps, "test-bot");

    expect(redis.xread).toHaveBeenCalledWith("COUNT", 20, "STREAMS", "cca:event-stream", "0");
  });

  it("handles a stream entry and updates last-id", async () => {
    const entry: [string, string[]] = [
      "1711234567890-0",
      [
        "jobId", "job-stream-1",
        "status", "done",
        "title", "stream job",
        "repoUrl", "https://github.com/foo/bar",
        "lastLines", JSON.stringify(["done"]),
        "score", "1.0",
        "timestamp", "1711234567890",
      ],
    ];
    const xreadResult: Array<[string, Array<[string, string[]]>]> = [
      ["cca:event-stream", [entry]],
    ];
    const redis = makeMockRedis({ xread: vi.fn().mockResolvedValue(xreadResult) });
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue('{"action":"SILENT"}'),
    });

    await replayStreamEvents(redis as never, deps, "test-bot");

    expect(deps.askClaude).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledWith("cca:event-stream:last-id:test-bot", "1711234567890-0");
  });

  it("continues gracefully when xread throws", async () => {
    const redis = makeMockRedis({ xread: vi.fn().mockRejectedValue(new Error("stream error")) });
    const deps = makeDeps();
    await expect(replayStreamEvents(redis as never, deps, "test-bot")).resolves.toBeUndefined();
    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("continues gracefully when get throws (uses default last-id '0')", async () => {
    const redis = makeMockRedis({ get: vi.fn().mockRejectedValue(new Error("Redis down")) });
    const deps = makeDeps();
    await replayStreamEvents(redis as never, deps, "test-bot");

    expect(redis.xread).toHaveBeenCalledWith("COUNT", 20, "STREAMS", "cca:event-stream", "0");
  });

  it("skips malformed stream entries without crashing", async () => {
    const badEntry: [string, string[]] = [
      "111-0",
      ["jobId", "job-bad", "status", "done", "title", "t", "repoUrl", "u",
       "lastLines", "NOT_JSON", "timestamp", "0"],
    ];
    const xreadResult: Array<[string, Array<[string, string[]]>]> = [
      ["cca:event-stream", [badEntry]],
    ];
    const redis = makeMockRedis({ xread: vi.fn().mockResolvedValue(xreadResult) });
    const deps = makeDeps();
    await expect(replayStreamEvents(redis as never, deps, "test-bot")).resolves.toBeUndefined();
    expect(deps.askClaude).not.toHaveBeenCalled();
    // last-id still updated even for skipped entries
    expect(redis.set).toHaveBeenCalledWith("cca:event-stream:last-id:test-bot", "111-0");
  });
});
