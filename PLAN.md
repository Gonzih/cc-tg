# Plan: Poll and drain cca:notify:{namespace} Redis LIST

## Task restatement
Jobs push notifications to Redis as a LIST (`RPUSH cca:notify:{namespace}`). cc-tg's notifier only
subscribes to pub/sub channels. We need to add a 5-second polling loop that RPOP-drains this list
and delivers each message to Telegram.

## Approaches considered

### A. Poller inside `startNotifier` (chosen)
Add `setInterval(..., 5_000)` inside the existing `startNotifier` function. Uses the main `redis`
client (not the sub duplicate, which is in subscribe mode). Clean, minimal surface area.

### B. Separate `startListPoller` export
Create a new exported function. Would require a caller change in `index.ts`. More flexible but more
surface area — not needed here.

### C. BLPOP blocking pop in a loop
Uses a dedicated Redis connection. Reacts instantly but complexity is higher; the 5s polling
interval is acceptable per the spec.

## Chosen approach: A
Minimal change — add the polling loop directly inside `startNotifier`. The original `redis` param
is in normal mode and supports RPOP. No API change to callers.

## Algorithm
1. Every 5s, call `redis.rpop(cca:notify:{namespace})` in a loop (up to 20 items).
2. If we drained all 20 slots, call `redis.llen(key)` to count remaining items.
3. Parse each item as JSON `{"text":"..."}`, fall back to raw string.
4. Send each text to Telegram (`bot.sendMessage`).
5. If remaining > 0, send `...and N more notifications` summary.
6. Resolve chatId same way as the existing pub/sub handler: `chatId ?? getActiveChatId?.()`.
7. If no chatId available, skip silently.

## Files to touch
- `src/notifier.ts` — add poller inside `startNotifier`
- `src/notifier.test.ts` — add tests for poller behavior

## Risks / unknowns
- `rpop` returns `string | null` in ioredis v4+ — need to verify type
- fake timers + async in vitest: use `vi.advanceTimersByTimeAsync` to flush microtasks
