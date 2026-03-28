import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleJobEvent,
  buildDecisionPrompt,
  parseDecision,
  type JobEvent,
  type HandlerDeps,
} from "./cc-agent-events.js";

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
} {
  return {
    askClaude: vi.fn().mockResolvedValue('{"action":"SILENT"}'),
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
    spawnFollowupAgent: vi.fn().mockResolvedValue(undefined),
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

  it("handles Claude error gracefully — no crash, no action", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockRejectedValue(new Error("Claude crashed")),
    });
    const event = makeEvent({ status: "done" });

    // Must not throw
    await expect(handleJobEvent(JSON.stringify(event), deps)).resolves.toBeUndefined();
    expect(deps.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("handles malformed Claude JSON gracefully", async () => {
    const deps = makeDeps({
      askClaude: vi.fn().mockResolvedValue("I cannot decide right now."),
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
});

describe("buildDecisionPrompt", () => {
  it("includes all required fields", () => {
    const event = makeEvent();
    const prompt = buildDecisionPrompt(event);
    expect(prompt).toContain(event.title);
    expect(prompt).toContain(event.repoUrl);
    expect(prompt).toContain(event.status);
    expect(prompt).toContain(event.lastLines[0]);
    expect(prompt).toContain("NOTIFY_ONLY");
    expect(prompt).toContain("SPAWN_FOLLOWUP");
    expect(prompt).toContain("SILENT");
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
