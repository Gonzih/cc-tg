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

  it("parses simple #repo-name at start", () => {
    const result = parseRoutingTag("#cc-agent fix the bug");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("cc-agent");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/cc-agent");
    expect(result!.strippedMessage).toBe("fix the bug");
  });

  it("parses #repo-name anywhere in message", () => {
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
    const result = parseRoutingTag("#cc-agent");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("");
  });

  it("collapses extra whitespace after strip", () => {
    const result = parseRoutingTag("fix  #cc-agent  the bug");
    expect(result).not.toBeNull();
    expect(result!.strippedMessage).toBe("fix the bug");
  });

  it("uses first match only when multiple tags present", () => {
    const result = parseRoutingTag("#repo-a do stuff #repo-b");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("repo-a");
  });

  it("handles underscores and dots in repo name", () => {
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

  it("starts meta-agent when not running (repo already exists)", async () => {
    // Not running initially
    mockGet.mockResolvedValueOnce(null);
    // Poll: not running on first tick, running on second
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "idle" }));
    mockGet.mockResolvedValueOnce(JSON.stringify({ status: "running" }));

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
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValue(JSON.stringify({ status: "running" }));

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
    mockGet.mockResolvedValue(null); // never becomes running
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
});
