/**
 * Unit tests for ClaudeProcess class and resolveClaude path resolution.
 *
 * Strategy: mock child_process.spawn to return a fake EventEmitter-based
 * process whose stdout/stderr/exit/error events we can trigger manually.
 * This lets us test drainBuffer, sendPrompt, kill, and resolveClaude
 * without spawning a real subprocess.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be before any imports that trigger the module
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Fake writable stream with .write() we can spy on
  function makeStdin() {
    return { write: vi.fn() };
  }

  // Fake stdout/stderr as EventEmitter-based streams
  function makeStream() {
    const em = new EventEmitter();
    return em;
  }

  function makeProc() {
    const stdout = makeStream();
    const stderr = makeStream();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      stderr: typeof stderr;
      stdin: ReturnType<typeof makeStdin>;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = makeStdin();
    proc.kill = vi.fn();
    return proc;
  }

  const spawnMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);

  return { spawnMock, existsSyncMock, makeProc };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: mocks.spawnMock };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mocks.existsSyncMock };
});

import { ClaudeProcess } from "./claude.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ClaudeProcess backed by a fake proc we control */
function makeClaudeProcess(opts?: ConstructorParameters<typeof ClaudeProcess>[0]) {
  const fakeProc = mocks.makeProc();
  mocks.spawnMock.mockReturnValue(fakeProc);
  const cp = new ClaudeProcess(opts ?? {});
  return { cp, proc: fakeProc };
}

/** Push a JSON line into Claude's stdout buffer */
function pushStdout(proc: ReturnType<typeof mocks.makeProc>, json: unknown) {
  proc.stdout.emit("data", Buffer.from(JSON.stringify(json) + "\n"));
}

// ---------------------------------------------------------------------------
// Constructor + event wiring
// ---------------------------------------------------------------------------

describe("ClaudeProcess constructor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("spawns the claude binary with required flags", () => {
    makeClaudeProcess();
    expect(mocks.spawnMock).toHaveBeenCalledOnce();
    const [bin, args] = mocks.spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("claude"); // fallback when not found in PATH
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--continue");
    expect(args).toContain("--print");
  });

  it("passes --system-prompt when provided", () => {
    makeClaudeProcess({ systemPrompt: "You are helpful." });
    const [, args] = mocks.spawnMock.mock.calls[0] as [string, string[]];
    const idx = args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("You are helpful.");
  });

  it("sets ANTHROPIC_API_KEY for sk-ant-api tokens and deletes OAuth key", () => {
    makeClaudeProcess({ token: "sk-ant-api03-test" });
    const opts = mocks.spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-test");
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("sets CLAUDE_CODE_OAUTH_TOKEN for OAuth tokens and deletes API key", () => {
    makeClaudeProcess({ token: "sk-ant-oat01-xxx" });
    const opts = mocks.spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-xxx");
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses custom cwd when provided", () => {
    makeClaudeProcess({ cwd: "/custom/path" });
    const opts = mocks.spawnMock.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe("/custom/path");
  });

  it("emits exit event when proc exits", () => {
    const { cp, proc } = makeClaudeProcess();
    const onExit = vi.fn();
    cp.on("exit", onExit);
    proc.emit("exit", 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("sets exited=true when proc exits", () => {
    const { cp, proc } = makeClaudeProcess();
    expect(cp.exited).toBe(false);
    proc.emit("exit", 0);
    expect(cp.exited).toBe(true);
  });

  it("emits error event when proc has an error", () => {
    const { cp, proc } = makeClaudeProcess();
    const onError = vi.fn();
    cp.on("error", onError);
    const err = new Error("spawn ENOENT");
    proc.emit("error", err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("emits stderr event when proc writes to stderr", () => {
    const { cp, proc } = makeClaudeProcess();
    const onStderr = vi.fn();
    cp.on("stderr", onStderr);
    proc.stderr.emit("data", Buffer.from("startup warning\n"));
    expect(onStderr).toHaveBeenCalledWith("startup warning\n");
  });
});

// ---------------------------------------------------------------------------
// resolveClaude — tested indirectly via constructor PATH resolution
// ---------------------------------------------------------------------------

describe("resolveClaude (via ClaudeProcess constructor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("uses first claude binary found in PATH", () => {
    // Only the second PATH entry has claude
    mocks.existsSyncMock.mockImplementation((p: string) =>
      p === "/usr/local/bin/claude"
    );
    const origPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/usr/local/bin:/usr/sbin";
    makeClaudeProcess();
    process.env.PATH = origPath;

    const [bin] = mocks.spawnMock.mock.calls[0] as [string];
    expect(bin).toBe("/usr/local/bin/claude");
  });

  it("tries homebrew fallback when not in PATH", () => {
    mocks.existsSyncMock.mockImplementation((p: string) =>
      p === "/opt/homebrew/bin/claude"
    );
    const origPath = process.env.PATH;
    process.env.PATH = "/no/such/path";
    makeClaudeProcess();
    process.env.PATH = origPath;

    const [bin] = mocks.spawnMock.mock.calls[0] as [string];
    expect(bin).toBe("/opt/homebrew/bin/claude");
  });

  it("falls back to bare 'claude' when not found anywhere", () => {
    mocks.existsSyncMock.mockReturnValue(false);
    const origPath = process.env.PATH;
    process.env.PATH = "/no/such/path";
    makeClaudeProcess();
    process.env.PATH = origPath;

    const [bin] = mocks.spawnMock.mock.calls[0] as [string];
    expect(bin).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

describe("ClaudeProcess.sendPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("writes JSON payload to proc.stdin", () => {
    const { cp, proc } = makeClaudeProcess();
    cp.sendPrompt("Hello");
    expect(proc.stdin.write).toHaveBeenCalledOnce();
    const written = proc.stdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toBe("Hello");
  });

  it("throws when process has exited", () => {
    const { cp, proc } = makeClaudeProcess();
    proc.emit("exit", 1);
    expect(() => cp.sendPrompt("After exit")).toThrow("Claude process has exited");
  });
});

// ---------------------------------------------------------------------------
// sendImage
// ---------------------------------------------------------------------------

describe("ClaudeProcess.sendImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("sends image content block without caption", () => {
    const { cp, proc } = makeClaudeProcess();
    cp.sendImage("base64data", "image/jpeg");
    const written = proc.stdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0].type).toBe("image");
    expect(parsed.message.content[0].source.data).toBe("base64data");
    expect(parsed.message.content[0].source.media_type).toBe("image/jpeg");
  });

  it("sends text block before image when caption provided", () => {
    const { cp, proc } = makeClaudeProcess();
    cp.sendImage("base64data", "image/png", "Here is a screenshot");
    const written = proc.stdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.message.content).toHaveLength(2);
    expect(parsed.message.content[0].type).toBe("text");
    expect(parsed.message.content[0].text).toBe("Here is a screenshot");
    expect(parsed.message.content[1].type).toBe("image");
  });

  it("throws when process has exited", () => {
    const { cp, proc } = makeClaudeProcess();
    proc.emit("exit", 1);
    expect(() => cp.sendImage("data", "image/jpeg")).toThrow("Claude process has exited");
  });
});

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

describe("ClaudeProcess.kill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("calls kill on the underlying proc", () => {
    const { cp, proc } = makeClaudeProcess();
    cp.kill();
    expect(proc.kill).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// drainBuffer — message parsing and event emission
// ---------------------------------------------------------------------------

describe("ClaudeProcess drainBuffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it("emits 'message' for each complete JSON line", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    pushStdout(proc, { type: "system", session_id: "s1", payload: {} });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0].type).toBe("system");
  });

  it("buffers incomplete lines and emits when complete", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    const partial = '{"type":"assistant"';
    proc.stdout.emit("data", Buffer.from(partial));
    expect(onMessage).not.toHaveBeenCalled(); // incomplete

    const rest = ',"session_id":"s1"}\n';
    proc.stdout.emit("data", Buffer.from(rest));
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0].type).toBe("assistant");
  });

  it("skips non-JSON lines silently (startup noise)", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    proc.stdout.emit("data", Buffer.from("Claude Code version 1.0.0\n"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("skips empty/whitespace lines", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    proc.stdout.emit("data", Buffer.from("\n   \n\t\n"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("emits 'usage' for message_start events with usage block", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 25,
        },
      },
    });

    expect(onUsage).toHaveBeenCalledOnce();
    const usage = onUsage.mock.calls[0][0];
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(0); // always 0 at message_start
    expect(usage.cacheReadTokens).toBe(50);
    expect(usage.cacheWriteTokens).toBe(25);
  });

  it("does not emit 'usage' for message_start without usage block", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, { type: "message_start", message: {} });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("emits 'usage' for message_delta events with output_tokens", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, {
      type: "message_delta",
      usage: { output_tokens: 200 },
    });

    expect(onUsage).toHaveBeenCalledOnce();
    const usage = onUsage.mock.calls[0][0];
    expect(usage.outputTokens).toBe(200);
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it("does not emit 'usage' for message_delta with zero output_tokens", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, {
      type: "message_delta",
      usage: { output_tokens: 0 },
    });

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not emit 'usage' for message_delta without usage block", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, { type: "message_delta" });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("emits both 'usage' and 'message' for message_start", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    const onMessage = vi.fn();
    cp.on("usage", onUsage);
    cp.on("message", onMessage);

    pushStdout(proc, {
      type: "message_start",
      message: { usage: { input_tokens: 10 } },
    });

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("includes session_id and uuid from raw payload in ClaudeMessage", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    pushStdout(proc, {
      type: "result",
      session_id: "sess-xyz",
      uuid: "uuid-abc",
      result: "Done",
    });

    const msg = onMessage.mock.calls[0][0];
    expect(msg.session_id).toBe("sess-xyz");
    expect(msg.uuid).toBe("uuid-abc");
  });

  it("handles multiple JSON lines in a single data chunk", () => {
    const { cp, proc } = makeClaudeProcess();
    const onMessage = vi.fn();
    cp.on("message", onMessage);

    const chunk =
      JSON.stringify({ type: "system" }) + "\n" +
      JSON.stringify({ type: "assistant" }) + "\n" +
      JSON.stringify({ type: "result", result: "ok" }) + "\n";

    proc.stdout.emit("data", Buffer.from(chunk));
    expect(onMessage).toHaveBeenCalledTimes(3);
  });

  it("uses cache_read_input_tokens and cache_creation_input_tokens from message_start", () => {
    const { cp, proc } = makeClaudeProcess();
    const onUsage = vi.fn();
    cp.on("usage", onUsage);

    pushStdout(proc, {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 999,
          cache_creation_input_tokens: 888,
        },
      },
    });

    const usage = onUsage.mock.calls[0][0];
    expect(usage.cacheReadTokens).toBe(999);
    expect(usage.cacheWriteTokens).toBe(888);
  });
});
