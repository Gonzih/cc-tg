# cc-suite Redis Communication Protocol

> Source of truth: gonzih/money-brain research/cc-suite-redis-protocol.md
> (mirrored here for offline reference; the upstream repo is the canonical version)

---

## ChatMessage Shape

Every message written to `cca:chat:log:{ns}` and published to `cca:chat:outgoing:{ns}` must have exactly:

```typescript
interface ChatMessage {
  id: string;        // UUID v4 (crypto.randomUUID())
  source: "telegram" | "ui" | "claude" | "cc-tg";
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string; // ISO 8601 (new Date().toISOString())
  chatId: number;
}
```

**source values:**
- `telegram` — message typed by a user in Telegram
- `ui` — message sent from the web UI via `cca:chat:incoming:{ns}`
- `claude` — response or streaming line from a cc-agent / meta-agent process
- `cc-tg` — internal message from the cc-tg bridge (tool calls, assistant flushes)

**role values:**
- `user` — human turn
- `assistant` — AI response
- `tool` — tool invocation record

---

## Redis Keys

### Chat Log

| Key | Type | Direction | Description |
|-----|------|-----------|-------------|
| `cca:chat:log:{ns}` | LIST | LPUSH | Persistent chat history. LIFO — newest first. Consumers must `LRANGE 0 N` then reverse for chronological order. Trimmed to last 500 messages via `LTRIM 0 499`. |
| `cca:chat:outgoing:{ns}` | PUB/SUB | PUBLISH | Real-time feed of new messages for web UI consumption. |
| `cca:chat:incoming:{ns}` | PUB/SUB | SUBSCRIBE | Messages sent from the web UI → cc-tg bridges these to Claude. |

### Notifications

| Key | Type | Direction | Description |
|-----|------|-----------|-------------|
| `cca:notify:{ns}` | LIST + PUB/SUB | RPUSH / PUBLISH | Job completion notifications from cc-agent. Payload: `{ text, driver?, model?, cost? }` or plain string (legacy). |

### Meta-Agent

| Key | Type | Direction | Description |
|-----|------|-----------|-------------|
| `cca:meta-agent:status:{ns}` | STRING | GET/SET | JSON status blob: `{ status, current_tool?, turn?, last_activity? }`. |
| `cca:meta:{ns}:input` | LIST | RPUSH (cc-tg) / LPOP (cc-agent) | Input message queue. cc-tg writes RPUSH; cc-agent polls with LPOP every 3s. Up to 3s delivery latency. |

---

## Dual-Write Rule

Every ChatMessage **must** be written to both:
1. `cca:chat:log:{ns}` via **LPUSH** (persistent log)
2. `cca:chat:outgoing:{ns}` via **PUBLISH** (real-time feed)

`writeChatLog()` in `src/notifier.ts` enforces this for all call sites.

---

## Notification Consumption

`parseNotification()` handles both payload formats:
- **JSON**: `{ text: string, driver?: string, model?: string, cost?: number }` — appends `[driver:model]` badge and cost
- **Plain string** (legacy fallback) — returned as-is without badge

---

## Timing Constants

| Constant | Value | Location | Notes |
|----------|-------|----------|-------|
| `FLUSH_DELAY_MS` | 800ms | `src/bot.ts` | Debounces Claude streaming chunks into one Telegram message. Resets on each chunk. Fires 800ms after last chunk. |
| `META_AGENT_FLUSH_DELAY_MS` | 1500ms | `src/notifier.ts` | Silence buffer for meta-agent streaming lines. Combined with cc-agent's 3s poll = up to 4.5s total response latency. |
| cc-agent notify poll | 5000ms | `src/notifier.ts` | `pollNotifyList` interval for `cca:notify:{ns}` LIST drain. |

---

## Token Pools

cc-tg's OAuth token pool (env: `CLAUDE_CODE_OAUTH_TOKENS`) rotates independently from cc-agent's token pool. There is no coordination between them. See `src/tokens.ts`.
