/**
 * Unit tests for exported helper functions in bot.ts:
 *   - listSkills (fs-dependent)
 *   - enrichPromptWithUrls (https-dependent)
 *
 * These are kept separate from bot.test.ts to avoid polluting the
 * existing heavy mock setup with additional fs/https mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — before any module imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(false),
  readdirSyncMock: vi.fn().mockReturnValue([]),
  readFileSyncMock: vi.fn().mockReturnValue(""),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024, isFile: () => true }),
  httpsGetMock: vi.fn(),
  execSyncMock: vi.fn().mockReturnValue(""),
  writeChatLog: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

// Mock fs so we control existsSync, readdirSync, readFileSync
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    readdirSync: mocks.readdirSyncMock,
    readFileSync: mocks.readFileSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
  };
});

// Mock https so fetchUrlViaJina is controllable
vi.mock("https", () => ({
  default: { get: mocks.httpsGetMock },
}));

// Mock http (same shape, just in case)
vi.mock("http", () => ({
  default: { get: vi.fn() },
}));

// Mock heavy dependencies that bot.ts imports
vi.mock("node-telegram-bot-api", () => ({
  default: vi.fn(function MockTelegramBot() {
    return {
      on: vi.fn(),
      sendMessage: vi.fn(),
      sendDocument: vi.fn(),
      sendChatAction: vi.fn(),
      setMyCommands: vi.fn(),
      stopPolling: vi.fn(),
      getFileLink: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1, username: "bot" }),
    };
  }),
}));

vi.mock("./claude.js", () => ({
  ClaudeProcess: vi.fn(function () {
    return { on: vi.fn(), sendPrompt: vi.fn(), kill: vi.fn(), exited: false };
  }),
  extractText: vi.fn().mockReturnValue(""),
}));

vi.mock("./cron.js", () => ({
  CronManager: vi.fn(function () {
    return { list: vi.fn().mockReturnValue([]), add: vi.fn(), remove: vi.fn(), clearAll: vi.fn() };
  }),
}));

vi.mock("./voice.js", () => ({
  isVoiceAvailable: vi.fn().mockReturnValue(false),
  transcribeVoice: vi.fn(),
}));

vi.mock("./notifier.js", () => ({
  writeChatLog: mocks.writeChatLog,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execSync: mocks.execSyncMock };
});

import { listSkills, enrichPromptWithUrls } from "./bot.js";

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.readdirSyncMock.mockReturnValue([]);
    mocks.readFileSyncMock.mockReturnValue("");
  });

  it("returns 'No skills directory found' when skills dir does not exist", () => {
    mocks.existsSyncMock.mockReturnValue(false);
    const result = listSkills();
    expect(result).toContain("No skills directory found");
  });

  it("returns 'No skills found' when directory is empty", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue([]);
    const result = listSkills();
    expect(result).toContain("No skills found");
  });

  it("returns 'Could not read skills directory' when readdirSync throws", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    const result = listSkills();
    expect(result).toContain("Could not read skills directory");
  });

  it("lists .md files with their descriptions from frontmatter", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["commit.md", "review.md"]);
    mocks.readFileSyncMock.mockImplementation((path: string) => {
      if ((path as string).endsWith("commit.md")) {
        return "---\nname: commit\ndescription: Create a git commit\n---\nBody here";
      }
      return "---\nname: review\ndescription: Review a PR\n---\nBody here";
    });

    const result = listSkills();
    expect(result).toContain("/commit — Create a git commit");
    expect(result).toContain("/review — Review a PR");
  });

  it("lists skill name without description when frontmatter has no description field", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["nodesc.md"]);
    mocks.readFileSyncMock.mockReturnValue("---\nname: nodesc\n---\nNo description here.");

    const result = listSkills();
    expect(result).toContain("/nodesc");
    expect(result).not.toContain("—"); // no dash if no description
  });

  it("lists skill name only when readFileSync throws", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["broken.md"]);
    mocks.readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = listSkills();
    expect(result).toContain("/broken");
  });

  it("skips non-.md files", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["skill.md", "README.txt", "config.json"]);
    mocks.readFileSyncMock.mockReturnValue("---\ndescription: A skill\n---\n");

    const result = listSkills();
    expect(result).toContain("/skill");
    expect(result).not.toContain("README");
    expect(result).not.toContain("config");
  });

  it("sorts skills alphabetically", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["zebra.md", "alpha.md", "mango.md"]);
    mocks.readFileSyncMock.mockReturnValue("");

    const result = listSkills();
    const alphaIdx = result.indexOf("/alpha");
    const mangoIdx = result.indexOf("/mango");
    const zebraIdx = result.indexOf("/zebra");
    expect(alphaIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it("returns 'Available skills:' header when skills exist", () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readdirSyncMock.mockReturnValue(["test.md"]);
    mocks.readFileSyncMock.mockReturnValue("");

    const result = listSkills();
    expect(result).toMatch(/^Available skills:/);
  });
});

// ---------------------------------------------------------------------------
// enrichPromptWithUrls
// ---------------------------------------------------------------------------

/** Set up the https.get mock to return a fake response with given body */
function setupHttpsResponse(body: string, statusCode = 200) {
  mocks.httpsGetMock.mockImplementation((_url: string, cb: (res: unknown) => void) => {
    const chunks: Buffer[] = [Buffer.from(body)];
    const res = {
      statusCode,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") handler(chunks[0]);
        if (event === "end") handler();
        if (event === "error") { /* not triggered */ }
      }),
    };
    cb(res);
    return { on: vi.fn().mockReturnThis() };
  });
}

describe("enrichPromptWithUrls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns original text when no URLs are present", async () => {
    const text = "Hello, no URLs here!";
    const result = await enrichPromptWithUrls(text);
    expect(result).toBe(text);
    expect(mocks.httpsGetMock).not.toHaveBeenCalled();
  });

  it("returns original text when text is empty", async () => {
    const result = await enrichPromptWithUrls("");
    expect(result).toBe("");
  });

  it("fetches URL via Jina and prepends content to prompt", async () => {
    setupHttpsResponse("Web page content here");
    const result = await enrichPromptWithUrls("Check https://example.com for info");
    expect(result).toContain("Web page content here");
    expect(result).toContain("Check https://example.com for info");
    // Jina content should come before original text
    const contentIdx = result.indexOf("Web page content here");
    const originalIdx = result.indexOf("Check https://example.com");
    expect(contentIdx).toBeLessThan(originalIdx);
  });

  it("skips r.jina.ai URLs to avoid recursion", async () => {
    const text = "See https://r.jina.ai/something for content";
    const result = await enrichPromptWithUrls(text);
    expect(result).toBe(text);
    expect(mocks.httpsGetMock).not.toHaveBeenCalled();
  });

  it("returns original text when all URL fetches fail", async () => {
    mocks.httpsGetMock.mockImplementation((_url: string, _cb: unknown) => {
      const req = { on: vi.fn().mockReturnThis() };
      // Trigger network error
      setTimeout(() => {
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        req.on.mock.calls.forEach(([event, handler]: [string, (...args: unknown[]) => void]) => {
          handlers[event] = handler;
        });
        if (handlers["error"]) handlers["error"](new Error("ECONNREFUSED"));
      }, 0);
      return req;
    });

    mocks.httpsGetMock.mockImplementation(() => {
      throw new Error("ECONNREFUSED");
    });

    const text = "Check https://broken.example.com";
    const result = await enrichPromptWithUrls(text);
    expect(result).toBe(text);
  });

  it("skips URL when Jina returns empty content", async () => {
    setupHttpsResponse("   "); // whitespace only
    const text = "See https://example.com";
    const result = await enrichPromptWithUrls(text);
    expect(result).toBe(text); // no prefix added for empty content
  });

  it("includes [Web content from <url>] label in prefix", async () => {
    setupHttpsResponse("Useful content");
    const result = await enrichPromptWithUrls("Visit https://example.com");
    expect(result).toContain("[Web content from https://example.com]");
  });

  it("truncates Jina response to 2000 chars by default", async () => {
    const longContent = "A".repeat(5000);
    setupHttpsResponse(longContent);
    const result = await enrichPromptWithUrls("See https://example.com");
    // The fetched content is sliced to 2000 chars before prepending
    const aCount = (result.match(/A/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(2000);
  });
});
