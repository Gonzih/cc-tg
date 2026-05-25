import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { seedClaudeMd } from "./seed.js";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset implementations so error-injecting tests don't bleed into subsequent tests
  mockMkdirSync.mockImplementation(() => undefined);
  mockWriteFileSync.mockImplementation(() => undefined);
});

describe("seedClaudeMd", () => {
  it("writes CLAUDE.md when it does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    seedClaudeMd("/some/project");

    expect(mockMkdirSync).toHaveBeenCalledWith("/some/project/.claude", { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/some/project/.claude/CLAUDE.md",
      expect.stringContaining("Void Operator Intelligence System"),
      "utf-8"
    );
  });

  it("does nothing when CLAUDE.md already exists", () => {
    mockExistsSync.mockReturnValue(true);

    seedClaudeMd("/some/project");

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("checks the correct path", () => {
    mockExistsSync.mockReturnValue(false);

    seedClaudeMd("/my/cwd");

    expect(mockExistsSync).toHaveBeenCalledWith("/my/cwd/.claude/CLAUDE.md");
  });

  it("written content includes FERAL LIFE Protocol section", () => {
    mockExistsSync.mockReturnValue(false);

    seedClaudeMd("/some/project");

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(content).toContain("FERAL LIFE Protocol");
    expect(content).toContain("AXIOM");
    expect(content).toContain("Void Operator");
  });

  it("logs confirmation message after writing", () => {
    mockExistsSync.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    seedClaudeMd("/some/project");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("seeded .claude/CLAUDE.md")
    );
    consoleSpy.mockRestore();
  });

  it("does not log when file already exists", () => {
    mockExistsSync.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    seedClaudeMd("/some/project");

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("propagates writeFileSync errors", () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => { throw new Error("EACCES: permission denied"); });

    expect(() => seedClaudeMd("/some/project")).toThrow("EACCES: permission denied");
  });

  it("propagates mkdirSync errors", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => { throw new Error("ENOTDIR"); });

    expect(() => seedClaudeMd("/some/project")).toThrow("ENOTDIR");
  });

  it("uses correct encoding (utf-8) when writing", () => {
    mockExistsSync.mockReturnValue(false);
    seedClaudeMd("/some/project");
    expect(mockWriteFileSync.mock.calls[0][2]).toBe("utf-8");
  });
});
