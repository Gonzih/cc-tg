/**
 * OAuth token pool management.
 *
 * Supports CLAUDE_CODE_OAUTH_TOKENS (comma-separated list of tokens).
 * Falls back to CLAUDE_CODE_OAUTH_TOKEN for single-token / backwards compat.
 */

let tokens: string[] = [];
let currentIndex = 0;
let initialized = false;

/**
 * Load tokens from env vars. Called on startup; also re-callable in tests.
 * Priority: CLAUDE_CODE_OAUTH_TOKENS > CLAUDE_CODE_OAUTH_TOKEN > (empty)
 */
export function loadTokens(): string[] {
  const multi = process.env.CLAUDE_CODE_OAUTH_TOKENS;
  if (multi) {
    tokens = multi.split(",").map((t) => t.trim()).filter(Boolean);
  } else {
    const single = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    tokens = single ? [single] : [];
  }
  currentIndex = 0;
  initialized = true;
  return tokens;
}

function ensureInitialized(): void {
  if (!initialized) loadTokens();
}

/** Returns the current active token, or empty string if none configured. */
export function getCurrentToken(): string {
  ensureInitialized();
  return tokens[currentIndex] ?? "";
}

/**
 * Advance to the next token (wraps around).
 * Returns the new current token.
 */
export function rotateToken(): string {
  ensureInitialized();
  if (tokens.length === 0) return "";
  currentIndex = (currentIndex + 1) % tokens.length;
  return tokens[currentIndex];
}

/** Zero-based index of the current token. */
export function getTokenIndex(): number {
  ensureInitialized();
  return currentIndex;
}

/** Total number of tokens in the pool. */
export function getTokenCount(): number {
  ensureInitialized();
  return tokens.length;
}
