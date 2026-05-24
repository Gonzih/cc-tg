# Plan: Hashtag Meta-Agent Routing

## Task restatement

When a Telegram user sends a message containing `#tag` or `#org/repo`, route it to the
corresponding cc-agent meta-agent instead of the local Claude session. Auto-create the
GitHub repo and start the meta-agent if not already running. Reply immediately with
`→ #namespace` so the user knows the message was delegated.

## Approach options

### A. Redis-only approach
Skip MCP tools entirely. Check `cca:meta-agent:status:{namespace}` directly, use `spawn_agent`
MCP tool to start, RPUSH to `cca:meta:{namespace}:input` to send.
- Pro: Known working tools, consistent with notifier.ts patterns
- Con: `spawn_agent` requires a `task` string — unclear what task makes a "meta-agent"

### B. MCP tool approach (spec-faithful)
Call `start_meta_agent` and `message_meta_agent` via `callCcAgentTool`, check status via Redis.
- Pro: Follows task spec, clean separation of concerns
- Con: These tools may not exist in current cc-agent, returns null on failure

### C. Hybrid (chosen)
- Check Redis for `cca:meta-agent:status:{namespace}` directly (known-working pattern from notifier.ts)
- Call `callCcAgentTool("start_meta_agent", {namespace, repo_url})` to start — throw on null
- Route messages via Redis RPUSH to `cca:meta:{namespace}:input` (known-working pattern)
- Use `execSync` for `gh` repo verification/creation (same pattern as bot.ts)

**Why this:** Stays consistent with existing code patterns, is spec-faithful for the start mechanism,
and uses the reliable Redis RPUSH that notifier.ts already does for routing.

## Files to touch

- `src/router.ts` — new: parseRoutingTag, ensureMetaAgent, routeToMetaAgent
- `src/router.test.ts` — new: unit tests
- `src/bot.ts` — add routing check in handleTelegram() before getOrCreateSession()

## Risks

- `start_meta_agent` MCP tool may not exist → error surfaced to user with clear message
- `gh` CLI may not be installed in the runtime environment → execSync throws, caught and re-thrown
- strippedMessage may be empty if user sends only `#tag` → routeToMetaAgent is skipped, ensureMetaAgent still runs
- Regex `#org/repo` might greedily match inside URLs → acceptable; Telegram plain text rarely embeds bare URLs with hash routing syntax

## Key decisions

- Tag parsed anywhere in message (not just start), first match wins
- Strip tag + normalize whitespace before forwarding
- If Redis not configured, skip routing entirely (fall through to local Claude)
- Route BEFORE getOrCreateSession (skips local Claude session entirely)
- Log the user message to chat log as "user"/"telegram" before routing
