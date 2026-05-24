# Protocol Compliance Audit — Plan

## Task Summary
Audit cc-tg source against the cc-suite Redis communication protocol and fix every deviation.
Protocol doc URL returned 404 so working from task spec directly.

## Deviations Found

| # | File | Location | Issue | Fix |
|---|------|----------|-------|-----|
| 1 | bot.ts | :273 | `id` uses timestamp+random, not UUID | `crypto.randomUUID()` |
| 2 | notifier.ts | :318 | `id` uses timestamp+random, not UUID | `crypto.randomUUID()` |
| 3 | notifier.ts | :98 | LPUSH has no ordering comment | Add "LIFO — newest first" comment |
| 4 | notifier.ts | :341 | `lpush` to meta-agent input (should be `rpush`) + no timing comment | `rpush` + add latency comment |
| 5 | bot.ts | :74 | `FLUSH_DELAY_MS` has no descriptive comment | Add behavior comment |
| 6 | notifier.ts | :220 | 1500ms debounce is a magic number | Extract to `META_AGENT_FLUSH_DELAY_MS` constant + add comment |
| 7 | tokens.ts | — | No comment about independent rotation from cc-agent pool | Add comment |
| 8 | docs/ | — | Protocol markdown missing | Create docs/redis-protocol.md |

## No Deviations (already correct)
- `writeChatLog()` does dual-write (LPUSH + PUBLISH) ✓
- `parseNotification()` handles both JSON and plain-string fallback ✓
- `source` values match spec: 'telegram' | 'ui' | 'claude' | 'cc-tg' ✓
- `role` values match spec: 'user' | 'assistant' | 'tool' ✓
- ChatMessage shape has id, source, role, content, timestamp, chatId ✓

## Approach
Direct edits to the 3 source files + new docs/redis-protocol.md.
No architectural changes needed.

## Files to Touch
- src/bot.ts
- src/notifier.ts
- src/tokens.ts
- docs/redis-protocol.md (new)
