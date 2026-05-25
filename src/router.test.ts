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

  it("logs routing confirmation when message is routed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockRpush.mockResolvedValue(1);
    const redis = makeRedis();

    await routeToMetaAgent("my-ns", "do the thing", redis);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("routed message to meta-agent namespace=my-ns"));
    logSpy.mockRestore();
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

  it("throws with 'unknown error' when ok:false payload has no error field", async () => {
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    mockExecSync.mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue(JSON.stringify({ ok: false }));
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis)
    ).rejects.toThrow("start_meta_agent failed: unknown error");
  });

  it("throws when gh repo create also fails", async () => {
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    // gh repo view fails, then gh repo create also fails
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockImplementationOnce(() => { throw new Error("API rate limit exceeded"); });

    const callTool = vi.fn();
    const redis = makeRedis();

    await expect(
      ensureMetaAgent("fail-ns", "https://github.com/gonzih/fail-ns", callTool, redis)
    ).rejects.toThrow("Failed to create repo gonzih/fail-ns: API rate limit exceeded");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("falls through when status key has corrupt JSON (not valid JSON)", async () => {
    // Corrupt status key → falls through to state key check
    mockGet.mockResolvedValueOnce("not-valid-json"); // status key corrupt
    mockGet.mockResolvedValueOnce(null);              // state key absent → proceed
    // Poll: immediately ready on first tick
    mockGet.mockResolvedValue(JSON.stringify({ status: "idle" }));

    mockExecSync.mockReturnValue("");
    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Fell through the corrupt status key and proceeded to start_meta_agent
    expect(callTool).toHaveBeenCalledWith("start_meta_agent", expect.objectContaining({ namespace: "cc-agent" }));
  });

  it("falls through when state key has corrupt JSON", async () => {
    mockGet.mockResolvedValueOnce(null);        // status key absent
    mockGet.mockResolvedValueOnce("bad-json");  // state key corrupt → falls through
    // Poll resolves immediately
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" }));

    mockExecSync.mockReturnValue("");
    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("ns2", "https://github.com/gonzih/ns2", callTool, redis);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(callTool).toHaveBeenCalled();
  });

  it("logs 'already ready' when status key is running", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "running" }));
    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("cc-agent", "https://github.com/gonzih/cc-agent", callTool, redis);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already ready"));
    logSpy.mockRestore();
  });

  it("logs 'workspace exists' when state key is idle", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGet.mockResolvedValueOnce(null);                                 // status key absent
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" }));  // state key present
    const callTool = vi.fn();
    const redis = makeRedis();

    await ensureMetaAgent("ns", "https://github.com/gonzih/ns", callTool, redis);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("workspace exists"));
    logSpy.mockRestore();
  });

  it("logs repo creation when gh repo view fails but create succeeds", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGet.mockResolvedValueOnce(null); // status key
    mockGet.mockResolvedValueOnce(null); // state key
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" })); // poll

    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockReturnValue("");

    const callTool = vi.fn().mockResolvedValue("ok");
    const redis = makeRedis();

    process.env.META_AGENT_TIMEOUT_MS = "5000";
    vi.useFakeTimers();

    const promise = ensureMetaAgent("new-ns", "https://github.com/gonzih/new-ns", callTool, redis);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("created repo gonzih/new-ns"));
    logSpy.mockRestore();
  });
});
