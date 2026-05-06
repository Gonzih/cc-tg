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
});
