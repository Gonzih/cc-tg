import { describe, it, expect, beforeEach } from "vitest";
import {
  loadTokens,
  getCurrentToken,
  rotateToken,
  getTokenIndex,
  getTokenCount,
} from "./tokens.js";

// Reset token state before each test by calling loadTokens() with controlled env
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

beforeEach(() => {
  // Clear both env vars and reset module state
  withEnv(
    { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
    () => loadTokens()
  );
});

describe("loadTokens", () => {
  it("returns empty array when no env vars set", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        const result = loadTokens();
        expect(result).toEqual([]);
        expect(getTokenCount()).toBe(0);
      }
    );
  });

  it("falls back to single CLAUDE_CODE_OAUTH_TOKEN", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: "token-a" },
      () => {
        const result = loadTokens();
        expect(result).toEqual(["token-a"]);
        expect(getTokenCount()).toBe(1);
        expect(getCurrentToken()).toBe("token-a");
      }
    );
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKENS over single token", () => {
    withEnv(
      {
        CLAUDE_CODE_OAUTH_TOKENS: "token-1,token-2",
        CLAUDE_CODE_OAUTH_TOKEN: "token-single",
      },
      () => {
        const result = loadTokens();
        expect(result).toEqual(["token-1", "token-2"]);
        expect(getTokenCount()).toBe(2);
      }
    );
  });

  it("trims whitespace around tokens", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: " tok1 , tok2 , tok3 ", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        expect(getTokenCount()).toBe(3);
        expect(getCurrentToken()).toBe("tok1");
      }
    );
  });

  it("resets index to 0 on reload", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: "a,b,c", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        rotateToken(); // index = 1
        loadTokens(); // should reset to 0
        expect(getTokenIndex()).toBe(0);
        expect(getCurrentToken()).toBe("a");
      }
    );
  });
});

describe("single token fallback", () => {
  it("getCurrentToken returns the single token", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: "my-token" },
      () => {
        loadTokens();
        expect(getCurrentToken()).toBe("my-token");
        expect(getTokenIndex()).toBe(0);
        expect(getTokenCount()).toBe(1);
      }
    );
  });

  it("rotateToken wraps back to same token when only one", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: "solo" },
      () => {
        loadTokens();
        const next = rotateToken();
        expect(next).toBe("solo");
        expect(getTokenIndex()).toBe(0);
      }
    );
  });
});

describe("multi-token rotation", () => {
  beforeEach(() => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: "tok1,tok2,tok3", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => loadTokens()
    );
  });

  it("starts at index 0", () => {
    expect(getTokenIndex()).toBe(0);
    expect(getCurrentToken()).toBe("tok1");
    expect(getTokenCount()).toBe(3);
  });

  it("rotateToken advances to next token", () => {
    const next = rotateToken();
    expect(next).toBe("tok2");
    expect(getTokenIndex()).toBe(1);
    expect(getCurrentToken()).toBe("tok2");
  });

  it("rotateToken advances through all tokens sequentially", () => {
    expect(getCurrentToken()).toBe("tok1");
    expect(rotateToken()).toBe("tok2");
    expect(rotateToken()).toBe("tok3");
  });
});

describe("wrap-around", () => {
  it("wraps back to first token after the last", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: "a,b,c", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        rotateToken(); // a → b
        rotateToken(); // b → c
        const wrapped = rotateToken(); // c → a (wrap)
        expect(wrapped).toBe("a");
        expect(getTokenIndex()).toBe(0);
        expect(getCurrentToken()).toBe("a");
      }
    );
  });

  it("wrap-around with two tokens", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: "x,y", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        expect(getCurrentToken()).toBe("x");
        rotateToken();
        expect(getCurrentToken()).toBe("y");
        rotateToken();
        expect(getCurrentToken()).toBe("x"); // back to start
      }
    );
  });
});

describe("all-exhausted detection", () => {
  it("after rotating through all N tokens, index wraps to 0 (all exhausted)", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: "t1,t2,t3", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        const total = getTokenCount(); // 3
        // Simulate all tokens being tried: we started at 0, rotate N-1 times = seen all
        // A full cycle is detected when (rotations % total === 0)
        expect(getTokenIndex()).toBe(0); // start
        rotateToken(); // 1
        rotateToken(); // 2
        // After total-1 rotations we've seen all tokens once
        expect(getTokenIndex()).toBe(total - 1);
        // One more rotation wraps around — signals full cycle
        rotateToken();
        expect(getTokenIndex()).toBe(0);
      }
    );
  });

  it("returns empty string for getCurrentToken when no tokens configured", () => {
    withEnv(
      { CLAUDE_CODE_OAUTH_TOKENS: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      () => {
        loadTokens();
        expect(getCurrentToken()).toBe("");
        expect(rotateToken()).toBe("");
      }
    );
  });
});
