# Plan: /cost, driver+cost badges, /agents command

## Task restatement
1. `/cost` — reformat `formatAgentCostSummary` to cleaner "💰 Cost Summary" layout
2. Job completion notifications — always show driver badge (including 'claude'), add cost if present
3. `/drivers` — already implemented, no changes needed
4. `/agents` — new command reading Redis `cca:meta-agent:status:*` keys

## Approaches

### Change 1: /cost format
- Update `formatAgentCostSummary` in `bot.ts` to use new heading, aligned repo costs, "No cost data available yet." fallback
- Keep existing session cost section (📊)

### Change 2: Notification badge + cost
- `parseNotification` in `notifier.ts`: always show badge when `driver` field is present (remove claude exception)
- Badge format: `[driver:shortmodel]` where shortmodel strips driver prefix or vendor/ prefix
- Add `cost: $X.XXX` suffix if `cost` field present in JSON payload
- Update separator from space to `\n` for multi-line friendliness
- Update affected tests in `notifier.test.ts`

### Change 3: /drivers
- Already implemented (verified: `handleDrivers` at bot.ts:1375, BOT_COMMANDS entry at line 38)
- No changes needed

### Change 4: /agents
- Add `BOT_COMMANDS` entry
- Add `/agents` case in `handleTelegram`
- Implement `handleAgents`: SCAN `cca:meta-agent:status:*`, GET each, format namespace+status+turns+age
- Handle missing Redis gracefully
- Add tests in `bot.test.ts` with mocked Redis

## Files to touch
- `src/bot.ts` — formatAgentCostSummary, BOT_COMMANDS, handleTelegram, handleAgents
- `src/notifier.ts` — parseNotification (badge always shown, cost support, shortenModelName helper)
- `src/bot.test.ts` — add /agents tests
- `src/notifier.test.ts` — update badge tests for new behavior, add cost tests

## Risks / unknowns
- ioredis SCAN return type: `Promise<[string, string[]]>` in ioredis v5 — should be fine
- Cost field format from cc-agent: assuming `cost?: number` in the JSON payload
- Redis SCAN cursor: must drain until cursor === "0"
- `parseNotification` badge change affects existing passing tests — must update them
