# Plan: Multi-Agent Driver Pass-Through + /drivers Command

## Task restatement
cc-agent is gaining a driver abstraction layer (supporting non-Claude LLMs like qwen, openai, etc.).
cc-tg needs to:
1. Read `CC_AGENT_DEFAULT_DRIVER` and `CC_AGENT_DEFAULT_MODEL` env vars
2. Pass `agent_driver` / `agent_model` through to any `spawn_agent` / `spawn_from_profile` MCP calls
3. Display a driver badge in job status notifications if driver is non-claude
4. Add a `/drivers` Telegram command that calls the new `list_drivers` MCP tool

## Approaches considered

### A. Env-var injection only
Just set CC_AGENT_DEFAULT_DRIVER in the process environment and rely on cc-agent to read it.
Pro: zero code changes. Con: cc-tg doesn't control what args Claude Code passes to spawn_agent.

### B. callCcAgentTool auto-injection (chosen for spawn calls)
When cc-tg's own `callCcAgentTool` calls `spawn_agent` or `spawn_from_profile`, automatically
merge `agent_driver` / `agent_model` into the args. ClaudeProcess already inherits all process.env
so Claude Code (the coordinator) sees the env vars too — both paths covered.

### C. Intercept Claude tool events and rewrite args
Hook into the `assistant` message stream and rewrite spawn_agent args before forwarding.
Too invasive — Claude Code formats these calls internally.

## Chosen approach: B
- `callCcAgentTool`: auto-merge driver/model args for spawn tools
- ClaudeProcess env: already inherits `process.env` (including CC_AGENT_DEFAULT_DRIVER/MODEL)
- Notification badge: parse JSON payload in notifier, append `[model]` badge if driver != 'claude'
- `/drivers` command: call `list_drivers` via `callCcAgentTool` and format the text result

## Files to touch
- `src/bot.ts` — BOT_COMMANDS, callCcAgentTool driver injection, /drivers handler
- `src/notifier.ts` — driver badge in notification text
- `src/bot.test.ts` — /drivers command test
- `src/notifier.test.ts` — badge parsing test

## Risks / unknowns
- `list_drivers` MCP tool may return raw text or JSON — handle both gracefully
- Notification JSON format with `driver`/`model` fields is assumed (cc-agent side); badge only
  shown if fields are present and driver != 'claude'
- No existing spawn_agent calls in cc-tg code; callCcAgentTool injection is forward-looking
