# Plan: Comprehensive Unit Tests for Utility Modules

## Task restatement

Add tests for uncovered code paths, error handling, boundary conditions, and all conditional
branches in the utility/helper/library modules: formatter.ts, tokens.ts, usage-limit.ts,
cron.ts, router.ts, voice.ts, and seed.ts.

## Approach

Add tests directly to the existing test files — no new files needed. Each file already
has a consistent vi/vitest style to follow.

## Key gaps to cover

### formatter.ts
- `htmlEscape()` directly (never called in isolation)
- `splitLongMessage` with a `<pre>` block covering the only split point → `coveringPre` branch
- `formatForTelegram` with `---` mid-sentence (should NOT convert)
- `formatForTelegram` with bold spanning newlines (`s` flag)
- `splitLongMessage` empty remaining after loop → no trailing chunk

### tokens.ts
- Empty string `CLAUDE_CODE_OAUTH_TOKENS=""` → empty array (split+filter)
- Whitespace-only tokens `"  ,  "` → filtered to []
- Lazy init via `getCurrentToken` without prior `loadTokens`

### usage-limit.ts
- Text with both usage AND rate_limit keywords → usage_exhausted wins
- `detected:false` branch → reason/retryAfterMs/humanMessage defaults

### cron.ts
- `clearAll` when no jobs → does NOT call persist (count=0 branch)
- `load()` with corrupted JSON → logs error, doesn't crash
- `load()` with valid persisted jobs → restores and schedules them
- `update` with empty `{}` (no-op update) → still recreates timer

### router.ts
- `parseRoutingTag` with `#-repo` (dash start → no match)
- `ensureMetaAgent` with corrupted status JSON → falls through
- `ensureMetaAgent` with corrupted state JSON → falls through
- `ensureMetaAgent` with `ok:false` no `error` field → "unknown error"
- `ensureMetaAgent` when `gh repo create` throws → propagates error
- `routeToMetaAgent` with single-word message (happy path edge)

### voice.ts
- HTTP URL (not HTTPS) → uses http getter
- Request-level network error → rejects
- Non-`.en.` model → uses `-l auto`
- Only whitespace after artifact removal → `[empty transcription]`

### seed.ts
- `console.log` is called when file is written
- Error from `writeFileSync` propagates

## Files to touch

- src/formatter.test.ts
- src/tokens.test.ts
- src/usage-limit.test.ts
- src/cron.test.ts
- src/router.test.ts
- src/voice.test.ts
- src/seed.test.ts

## Risks

- cron `load()` test requires mocking `existsSync` to return true + `readFileSync` to return JSON;
  the module-level mock already does this but needs per-test overrides
- voice http mock requires adding http mock setup (current tests only use https)
- formatter `htmlEscape` is not exported — must test via `formatForTelegram` proxy
