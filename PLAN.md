# Plan: Integration & E2E Tests for Uncovered Branches

## Task restatement

Write integration and end-to-end tests covering uncovered controller/API endpoint branches,
request/response handling, and error scenarios. Ensure all HTTP methods and status codes
are tested (Telegram sendMessage, sendDocument, etc.).

## Approach

Write two new test files using the established vitest + hoisted mocks pattern:

### File 1: `src/bot.error.test.ts`
Tests for error branches and edge cases in CcTgBot:
- Telegram API error recovery (sendMessage throws → HTML→plain retry)
- Claude process error event → sends error message to chat
- Unauthorized user → "Not authorized." reply
- Group chat filtering: allowlist, mention, reply-to-bot
- Hashtag routing error → error reply sent to user
- Forum topic routing via topicNameCache
- forwardNotification with active session, exited session, no session
- handleUserMessage error path (session.claude.exited)
- Voice message: Redis rpush/lrem, whisper error paths (HTTP, missing model)
- File upload: sendDocument throws (logged, does not crash), statSync race
- CostStore: corrupt JSON silently degrades, missing directory is created
- getLastActiveChatId tracking
- /voice_retry: no redis, deduplication, stale purge, expired file_id cleanup

### File 2: `src/notifier.error.test.ts`  
Tests for notifier error branches:
- parseNotification: JSON with text/driver/model/cost, plain string, malformed
- notify channel subscribe error logged
- pmessage handler: non-JSON skipped, wrong source skipped, no chatId dropped
- pmessage debounce buffer accumulation and flush
- registerRoutedChatId: per-namespace routing wins over global chatId
- Notify LIST polling: forwardNotification called, overflow "...and N more" message
- forwardNotification: sendMessage failure logged, not thrown
- writeChatLog: fire-and-forget (lpush fail doesn't propagate)

## Files to touch
- `src/bot.error.test.ts` — new
- `src/notifier.error.test.ts` — new

## Risks
- Some internal methods are private — accessed via `(bot as any).method()`
- Redis mock must be set up carefully to avoid interference between tests
- Fake timers needed for debounce/interval tests
