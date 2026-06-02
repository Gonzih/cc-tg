# PLAN.md — feat/effort-control

## Task Restatement
Add effort level control (`/effort <level>`), manual context compaction (`/compact`),
auto-compact after N messages (`CC_TG_AUTO_COMPACT_MESSAGES`), and a session cost warning
(`CC_TG_COST_WARN_USD`) to the cc-tg Telegram bot. Also update `/help` and README.

---

## Approaches Considered

### A) Forward slash commands verbatim to Claude subprocess stdin (CHOSEN)
Forward `/effort high` and `/compact` to Claude via `session.claude.sendPrompt()`.
**Pro**: Zero new abstractions; exactly what the spec says.
**Con**: Relies on Claude Code's stream-json input layer processing slash commands.

### B) Pass effort/compact as CLI flags on process spawn
Kill existing session and re-spawn with `--effort high` flag.
**Con**: Loses conversation history; ugly UX. Rejected.

### C) Custom JSON message type
Add `{ type: "command", command: "effort", value: "high" }`.
**Con**: Claude Code doesn't define such a type. Rejected.

---

## Approach: A — forward via sendPrompt

---

## Files to Touch
- `src/bot.ts` — core changes: commands, session fields, auto-compact, cost warning
- `src/bot.test.ts` — tests for new features
- `README.md` — document new commands and env vars

---

## Implementation Details

### Session interface additions
```
messagesSinceCompact: number   // incremented per-response; reset on /compact
costWarnSent: boolean           // true once cost threshold notification is sent
```

### BOT_COMMANDS additions
```
{ command: "effort", description: "Set effort level: low / medium / high / xhigh / max / auto" }
{ command: "compact", description: "Compact context history to free tokens" }
```

### /effort handler
- Validate level in Set(["low","medium","high","xhigh","max","auto"])
- No active session → informational reply
- Active session → sendPrompt("/effort ${level}") + ack

### /compact handler
- No active session → "No active session."
- Active session → sendPrompt("/compact"), reset messagesSinceCompact=0

### maybeSendAutoCompact (called before each sendPrompt in main text path)
- CC_TG_AUTO_COMPACT_MESSAGES (default 40, 0=disabled)
- When messagesSinceCompact >= threshold: send /compact, reset counter, log + notify

### Cost warning (in flushPending, once per session)
- CC_TG_COST_WARN_USD (default 5.0, 0=disabled)
- Guarded by session.costWarnSent flag
- After flush: if costStore.get(chatId).totalCostUsd >= threshold → warn, set flag

---

## Risks
- Claude Code may not process /effort /compact in stream-json mode — runtime concern, not a code bug.
- Cost store is keyed by chatId (not sessionKey) — pre-existing; not changed.
