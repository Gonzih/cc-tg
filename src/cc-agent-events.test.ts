import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleJobEvent,
  buildDecisionPrompt,
  parseDecision,
  writeCoordinatorPlan,
  defaultReadJobOutput,
  defaultReadCoordinatorPlan,
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

vi.mock("ioredis", () => {
  // Must use a regular function (not arrow) so it can be used as a constructor with `new`
  function MockRedis() {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      lrange: mockLrange,
      get: mockGet,
      set: mockSet,
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
} {
  return {
    askClaude: vi.fn().mockResolvedValue('{"action":"SILENT"}'),
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
    spawnFollowupAgent: vi.fn().mockResolvedValue(undefined),
    readJobOutput: vi.fn().mockResolvedValue([]),
    readCoordinatorPlan: vi.fn().mockResolvedValue(null),
    getRunningJobCount: vi.fn().mockResolvedValue(0),
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

  it("NOTIFY_ONLY — sends Telegram message with CC_AGENT_NOTIFY_CHAT_ID", async () => {
    const originalEnv = process.env.CC_AGENT_NOTIFY_CHAT_ID;
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "12345";

    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Job done successfully!" })
      ),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).toHaveBeenCalledOnce();
    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(12345, "Job done successfully!");
    expect(deps.spawnFollowupAgent).not.toHaveBeenCalled();

    process.env.CC_AGENT_NOTIFY_CHAT_ID = originalEnv;
  });

  it("NOTIFY_ONLY — skips silently if CC_AGENT_NOTIFY_CHAT_ID not set", async () => {
    const originalEnv = process.env.CC_AGENT_NOTIFY_CHAT_ID;
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;

    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Done!" })
      ),
    });
    const event = makeEvent({ status: "done" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();

    process.env.CC_AGENT_NOTIFY_CHAT_ID = originalEnv;
  });

  it("NOTIFY_ONLY — uses fallback message if none provided", async () => {
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "99";
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY" })
      ),
    });
    const event = makeEvent({ title: "my cool job" });
    await handleJobEvent(JSON.stringify(event), deps);

    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(99, "Job completed: my cool job");
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;
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

  it("SPAWN_FOLLOWUP — sends Telegram notification when CC_AGENT_NOTIFY_CHAT_ID is set", async () => {
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "777";
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "SPAWN_FOLLOWUP",
          followup: { repo_url: "https://github.com/foo/bar", task: "fix the tests" },
        })
      ),
      getRunningJobCount: vi.fn().mockResolvedValue(3),
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
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;
  });

  it("SPAWN_FOLLOWUP — no Telegram when CC_AGENT_NOTIFY_CHAT_ID not set", async () => {
    const originalEnv = process.env.CC_AGENT_NOTIFY_CHAT_ID;
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;

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
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();

    process.env.CC_AGENT_NOTIFY_CHAT_ID = originalEnv;
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

  it("handles Claude error gracefully — falls back to NOTIFY_ONLY (no chatId = no telegram)", async () => {
    const originalEnv = process.env.CC_AGENT_NOTIFY_CHAT_ID;
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;

    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();

    process.env.CC_AGENT_NOTIFY_CHAT_ID = originalEnv;
  });

  it("Claude error with chatId set — falls back to NOTIFY_ONLY and sends telegram", async () => {
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "42";
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
    });
    const event = makeEvent({ status: "done", title: "my job" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).toHaveBeenCalledWith(42, "Job completed: my job");
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;
  });

  it("failed job + Claude error — fallback uses failure format", async () => {
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "42";
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
    });
    const event = makeEvent({ status: "failed", title: "broken build", lastLines: ["error: build failed"] });

    await handleJobEvent(JSON.stringify(event), deps);
    const [, msg] = deps.sendTelegramMessage.mock.calls[0] as [number, string];
    expect(msg).toContain("✗ broken build failed");
    expect(msg).toContain("error: build failed");
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;
  });

  it("handles malformed Claude JSON gracefully — falls back to NOTIFY_ONLY", async () => {
    const originalEnv = process.env.CC_AGENT_NOTIFY_CHAT_ID;
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;

    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue("I cannot decide right now."),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();

    process.env.CC_AGENT_NOTIFY_CHAT_ID = originalEnv;
  });

  it("handles malformed event message gracefully", async () => {
    const deps = makeDeps();
    await expect(handleJobEvent("not valid json", deps)).resolves.toBeUndefined();
    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  it("handles Telegram send failure gracefully — no crash", async () => {
    process.env.CC_AGENT_NOTIFY_CHAT_ID = "42";
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue(
        JSON.stringify({ action: "NOTIFY_ONLY", message: "Done!" })
      ),
      sendTelegramMessage: vi.fn().mockRejectedValue(new Error("Telegram API down")),
    });
    const event = makeEvent({ status: "done" });

    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    delete process.env.CC_AGENT_NOTIFY_CHAT_ID;
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

  it("includes coordinator plan in the prompt when present", async () => {
    const plan: CoordinatorPlan = {
      nextStep: { repo_url: "https://github.com/a/b", task: "run integration tests" },
      summary: "phase 2 of migration",
    };
    const deps = makeDeps({
      readCoordinatorPlan: vi.fn().mockResolvedValue(plan),
    });
    const event = makeEvent();
    await handleJobEvent(JSON.stringify(event), deps);

    const prompt = deps.askClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("run integration tests");
    expect(prompt).toContain("phase 2 of migration");
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
