# Plan: Relay meta-agent responses from cca:chat:outgoing to Telegram

## Task restated
Meta-agent stdout lines are published per-line to `cca:chat:outgoing:{ns}` with `source: "claude"`.
cc-tg currently never subscribes to this channel. Result: the meta-agent response is silently dropped —
Telegram gets nothing after the coordinator returns `{ok: true}`.

## Approach
Use `psubscribe("cca:chat:outgoing:*")` + `pmessage` handler in `startNotifier`:
- Pattern subscription covers all namespaces (isoc-nevada, money-brain, etc.)
- Filter `source === "claude"` to avoid echo loop (cc-tg also publishes to same channel with source "cc-tg"/"telegram"/"ui")
- Per-namespace buffer + 1.5s debounce → entire streaming response arrives as one Telegram message
- Use `splitLongMessage` from formatter.ts for >4096 char responses
- Strip ANSI escape codes before sending

Keep existing `subscribe` + `message` handler intact for notify/incoming channels.

## Files to touch
- `src/notifier.ts` — add psubscribe, pmessage handler, buffer logic, ANSI strip, splitLongMessage import
- `src/notifier.test.ts` — add mockPsubscribe to mock, tests for pmessage filtering/buffering/debounce

## Risks
- Timer-based debounce tests need `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(1500)`
- The `sub` mock must expose `psubscribe` or tests will throw
- Must not break existing 411 tests
