# Plan: Error-Handling Test Coverage

## Task restatement

Write tests for uncovered error handling paths, exception cases, logging statements, and
validation logic across all modules in the cc-tg codebase.

## Approach

Targeted unit tests for each module's error paths. Read each source file, identify the gaps,
and write vitest tests that:
1. Cover `catch` blocks and error-return paths
2. Verify `console.log` / `console.error` calls in error/info scenarios
3. Test validation (bad JSON, missing files, invalid env vars)
4. Cover boundary/edge cases

## Files to touch

- `src/router.test.ts` — error paths in ensureMetaAgent, parseRoutingTag edge cases
- `src/voice.test.ts` — ffmpeg error path, ffmpeg-specific error message
- `src/cron.test.ts` — persist errors, load errors, console.log logging, invalid intervalMs
- `src/notifier.test.ts` — Redis subscribe errors, bot.sendMessage errors in handlers
- `src/claude.test.ts` — spawn error handler (proc.on("error")), drainBuffer silent skip

## Risks

- Some error paths require subtle mock setups (e.g. EventEmitter error events)
- notifier.ts has many interleaved async paths — mock carefully
- Don't break existing 475 passing tests
