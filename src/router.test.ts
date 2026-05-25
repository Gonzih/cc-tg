import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRoutingTag, ensureMetaAgent, routeToMetaAgent } from "./router.js";

// ---- child_process mock ----
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// ---- ioredis mock ----
const mockGet = vi.fn();
const mockRpush = vi.fn().mockResolvedValue(1);

function makeRedis() {
  return { get: mockGet, rpush: mockRpush } as unknown as import("ioredis").Redis;
}

// ---- helpers ----
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DEFAULT_GITHUB_ORG;
  delete process.env.META_AGENT_TIMEOUT_MS;
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// parseRoutingTag
// ===========================================================================

describe("parseRoutingTag", () => {
  it("returns null when no # tag present", () => {
    expect(parseRoutingTag("hello world")).toBeNull();
    expect(parseRoutingTag("fix the bug please")).toBeNull();
  });

  it("returns null for #repo-name when DEFAULT_GITHUB_ORG is not set", () => {
    expect(parseRoutingTag("#cc-agent fix the bug")).toBeNull();
    expect(parseRoutingTag("please help with #of-stack this issue")).toBeNull();
  });

  it("parses simple #repo-name at start when DEFAULT_GITHUB_ORG is set", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("#cc-agent fix the bug");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("cc-agent");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/cc-agent");
    expect(result!.strippedMessage).toBe("fix the bug");
  });

  it("parses #repo-name anywhere in message when DEFAULT_GITHUB_ORG is set", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("please help with #of-stack this issue");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("of-stack");
    expect(result!.strippedMessage).toBe("please help with this issue");
  });

  it("parses #org/repo format", () => {
    const result = parseRoutingTag("#gonzih/of-stack deploy it");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("of-stack");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/of-stack");
    expect(result!.strippedMessage).toBe("deploy it");
  });

  it("parses #org/repo with different org", () => {
    const result = parseRoutingTag("#myorg/myrepo do something");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("myrepo");
    expect(result!.repoUrl).toBe("https://github.com/myorg/myrepo");
  });

  it("uses DEFAULT_GITHUB_ORG env var when set", () => {
    process.env.DEFAULT_GITHUB_ORG = "mycompany";
    const result = parseRoutingTag("#my-service do stuff");
    expect(result).not.toBeNull();
    expect(result!.repoUrl).toBe("https://github.com/mycompany/my-service");
  });

  it("strips only the tag token, preserves rest of message", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("#cc-agent");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("");
  });

  it("collapses extra whitespace after strip", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("fix  #cc-agent  the bug");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("fix the bug");
  });

  it("uses first match only when multiple tags present", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("#repo-a do stuff #repo-b");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("repo-a");
  });

  it("handles underscores and dots in repo name", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("#my_repo.v2 task");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("my_repo.v2");
  });

  it("returns null for bare # with no following word char", () => {
    expect(parseRoutingTag("hello # world")).toBeNull();
  });

  it("returns null when tag starts with a dash (#-repo is invalid)", () => {
    // Regex requires [a-zA-Z0-9] as first char after #
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    expect(parseRoutingTag("#-repo fix it")).toBeNull();
  });

  it("handles repo name with dots and underscores (#org/my_repo.v2)", () => {
    const result = parseRoutingTag("#gonzih/my_repo.v2 deploy");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("my_repo.v2");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/my_repo.v2");
  });

  it("tag-only message results in empty strippedMessage for #org/repo", () => {
    const result = parseRoutingTag("#gonzih/cc-agent");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("");
  });

  it("strips tag from end of message", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("fix the bug #cc-agent");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("fix the bug");
  });
});

// ===========================================================================
// routeToMetaAgent
// ===========================================================================

describe("routeToMetaAgent", () => {
  it("RPUSHes a JSON entry to cca:meta:{namespace}:input", async () => {
    mockRpush.mockResolvedValue(1);
    const redis = makeRedis();

    await routeToMetaAgent("cc-agent", "fix the bug", redis);

    expect(mockRpush).toHaveBeenCalledOnce();
    const [key, rawEntry] = mockRpush.mock.calls[0] as [string, string];
    expect(key).toBe("cca:meta:cc-agent:input");

    const entry = JSON.parse(rawEntry) as { id: string; content: string; timestamp: string };
    expect(entry.content).toBe("fix the bug");
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(entry.timestamp).toBeTruthy();
  });

  it("is a no-op when strippedMessage is empty", async () => {
    const redis = makeRedis();
    await routeToMetaAgent("cc-agent", "", redis);
    expect(mockRpush).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ensureMetaAgent
// ===========================================================================

describe("ensureMetaAgent", () => {
  it("returns early when meta-agent is already running", async () => {
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" }));
    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);

    expect(callTool).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns early when meta-agent is idle (idle = ready)", async () => {
    mockGet.mockResolvedValue(JSON.stringify({ status: "idle" }));
    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);

    expect(callTool).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("resolves in poll loop when status becomes idle", async () => {
    // Fast path: both keys absent
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    // Poll: idle on first tick → should resolve immediately
    mockGet.mockResolvedValue(JSON.stringify({ status: "idle" }));

    mockExecSync.mockReturnValue("");
    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callTool).toHaveBeenCalledOnce();
  });

  it("starts meta-agent when not running (repo already exists)", async () => {
    // Fast path: both keys absent
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    // Poll: idle on first tick → resolves (idle = ready)
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" })); // poll status key

    // gh repo view succeeds (repo exists)
    mockExecSync.mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue('{"started":true}');
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);

    // Advance through poll ticks
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(callTool).toHaveBeenCalledWith("start_meta_agent", {
      namespace: "cc-agent",
      repo_url: "https://github.com/gonzih/cc-agent",
    });
    // gh repo view called with correct orgRepo
    expect(mockExecSync).toHaveBeenCalledWith("gh repo view gonzih/cc-agent", { stdio: "ignore" });
  });

  it("creates repo when gh repo view fails, then starts meta-agent", async () => {
    // Fast path: both keys absent
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" })); // poll

    // gh repo view throws (not found), gh repo create succeeds
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("my-ns", "https://github.com/gonzih/my-ns", callTool, redis);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(mockExecSync).toHaveBeenNthCalledWith(1, "gh repo view gonzih/my-ns", { stdio: "ignore" });
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `gh repo create gonzih/my-ns --public --description "Meta-agent workspace for my-ns"`,
      { stdio: "pipe" }
    );
  });

  it("throws when start_meta_agent tool returns null", async () => {
    mockGet.mockResolvedValue(null);
    mockExecSync.mockReturnValue(""); // repo exists

    const callTool = vi.fn().mockResolvedValue(null);
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis)
    ).rejects.toThrow("start_meta_agent returned null");
  });

  it("throws on timeout when meta-agent never becomes ready", async () => {
    mockGet.mockResolvedValue(null); // never becomes running — both status and state keys absent
    mockExecSync.mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "3000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);
    // Attach rejection handler immediately to prevent unhandled rejection warning
    const caught = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did not become ready within 3000ms");
  });

  // The root-cause fix: start_meta_agent writes cca:meta:{namespace} (state key) but NOT
  // cca:meta-agent:status:{namespace} (status key). The poll must check both.
  it("resolves when state key appears after start_meta_agent (core bug fix)", async () => {
    // Fast path: both keys absent
    mockGet.mockResolvedValueOnce(null); // fast path: status key
    mockGet.mockResolvedValueOnce(null); // fast path: state key
    // Poll iteration 1: status key absent, state key has idle (written by startMetaAgent)
    mockGet.mockResolvedValueOnce(null);                                      // poll: status key
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" }));        // poll: state key

    mockExecSync.mockReturnValue("");
    const callTool = vi.fn().mockResolvedValue(
      JSON.stringify({ ok: true, namespace: "of-stack", status: "idle" })
    );
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("of-stack", "https://github.com/gonzih/of-stack", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callTool).toHaveBeenCalledWith("start_meta_agent", {
      namespace: "of-stack",
      repo_url: "https://github.com/gonzih/of-stack",
    });
  });

  it("returns early on fast path when state key shows idle (workspace pre-exists)", async () => {
    // Status key absent, state key present with idle — workspace already created
    mockGet.mockResolvedValueOnce(null);                                 // status key
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" }));  // state key

    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("of-stack", "https://github.com/gonzih/of-stack", callTool, redis);

    expect(callTool).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("throws when start_meta_agent returns ok:false error payload", async () => {
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    mockExecSync.mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue(
      JSON.stringify({ ok: false, error: "git clone failed: repository not found" })
    );
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("of-stack", "https://github.com/gonzih/of-stack", callTool, redis)
    ).rejects.toThrow("start_meta_agent failed: git clone failed: repository not found");
  });

  it("throws 'unknown error' when ok:false payload has no error field", async () => {
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValueOnce(null);
    mockExecSync.mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue(JSON.stringify({ ok: false }));
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis)
    ).rejects.toThrow("start_meta_agent failed: unknown error");
  });

  it("falls through corrupted status JSON and continues to state key check", async () => {
    // Status key has corrupted JSON → falls through to stateKey
    mockGet.mockResolvedValueOnce("{not valid json}"); // corrupted status key
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" }));  // state key has idle

    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis);

    // Should not have started the meta-agent (state key was idle)
    expect(callTool).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("falls through corrupted state JSON and proceeds to start meta-agent", async () => {
    // Both fast-path keys have corrupted JSON → must start fresh
    mockGet.mockResolvedValueOnce("{bad}");   // corrupted status key
    mockGet.mockResolvedValueOnce("{bad}");   // corrupted state key
    // Poll: returns running on first tick
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" }));

    mockExecSync.mockReturnValue("");
    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callTool).toHaveBeenCalledWith("start_meta_agent", expect.objectContaining({ namespace: "ns" }));
  });

  it("throws when gh repo create fails", async () => {
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValueOnce(null);

    // gh repo view throws (not found), gh repo create also throws
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockImplementationOnce(() => { throw new Error("already exists remotely"); });

    const callTool = vi.fn();
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis)
    ).rejects.toThrow("Failed to create repo gonzih/ns");
  });

  it("non-JSON plain text result from start_meta_agent does not throw", async () => {
    // Fast path: both keys absent
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValueOnce(null);
    // Poll: idle on first tick
    mockGet.mockResolvedValue(JSON.stringify({ status: "idle" }));

    mockExecSync.mockReturnValue("");
    // Plain text (SyntaxError) — should not throw, continue to poll
    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callTool).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// routeToMetaAgent — additional edge cases
// ===========================================================================

describe("routeToMetaAgent — additional cases", () => {
  it("routes single-word stripped message", async () => {
    mockRpush.mockResolvedValue(1);
    const redis = makeRedis();

    await routeToMetaAgent("ns", "deploy", redis);

    expect(mockRpush).toHaveBeenCalledOnce();
    const [key, raw] = mockRpush.mock.calls[0] as [string, string];
    expect(key).toBe("cca:meta:ns:input");
    const entry = JSON.parse(raw) as { content: string; id: string; timestamp: string };
    expect(entry.content).toBe("deploy");
  });

  it("does not route whitespace-only stripped message (empty after trim)", async () => {
    const redis = makeRedis();
    // The function only checks `if (!strippedMessage)` — empty string is falsy
    await routeToMetaAgent("ns", "", redis);
    expect(mockRpush).not.toHaveBeenCalled();
  });

  it("timestamp in routed entry is a valid ISO 8601 string", async () => {
    mockRpush.mockResolvedValue(1);
    const redis = makeRedis();
    await routeToMetaAgent("ns", "hello", redis);
    const raw = (mockRpush.mock.calls[0] as [string, string])[1];
    const entry = JSON.parse(raw) as { timestamp: string };
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
  });
});
