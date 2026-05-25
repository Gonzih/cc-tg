# Plan: Comprehensive Unit Tests for 90%+ Coverage

## Task restatement

Write unit tests for all uncovered functions/branches in core business logic modules
(bot.ts, claude.ts, formatter.ts, voice.ts, notifier.ts) to hit 90%+ coverage.

## Current coverage gaps

| File | Stmts | Branch | Funcs | Key gaps |
|---|---|---|---|---|
| bot.ts | 68.53% | 65.19% | 49.65% | normalizeTopicNamespace, listSkills, enrichPromptWithUrls, buildPromptWithReplyContext |
| claude.ts | 83.52% | 72.22% | 93.33% | ClaudeProcess constructor, drainBuffer, sendPrompt, kill, resolveClaude |
| formatter.ts | 86.66% | 66.66% | 80% | findPreRanges unclosed pre, splitLongMessage hard split |
| voice.ts | 100% | 86.95% | 75% | HTTP (not HTTPS) download, non-.en model (-l auto), non-Error throw wrap |
| notifier.ts | 91.32% | 93.25% | 67.85% | Already well-tested via existing tests |

## Approach

### New files
1. `src/claude-process.test.ts` — Tests for `ClaudeProcess` class:
   - Mock `child_process.spawn` to control stdout/stderr/exit/error events
   - Test drainBuffer: JSON parsing, usage events (message_start/message_delta), non-JSON skip
   - Test sendPrompt: throws when exited, writes to stdin
   - Test sendImage: with and without caption
   - Test kill: calls proc.kill()
   - Test exited getter state
   - Test resolveClaude: PATH resolution via existsSync mock

2. `src/bot-helpers.test.ts` — Tests for exported helper functions from bot.ts:
   - `normalizeTopicNamespace`: all transformation rules
   - `listSkills`: no dir, empty dir, read error, missing descriptions
   - `enrichPromptWithUrls`: no URLs, skip jina.ai, fetch failures, multiple URLs

### Modified files  
3. `src/voice.test.ts` — Add:
   - HTTP (not HTTPS) download uses http.get
   - Non-.en model path uses `-l auto`
   - whisper error wrapping non-Error objects

4. `src/formatter.test.ts` — Add:
   - `findPreRanges` with unclosed `<pre>` tag (no match)
   - `splitLongMessage` hard split at maxLen (no natural boundaries)

## Files to touch
- src/claude-process.test.ts (new)
- src/bot-helpers.test.ts (new)
- src/voice.test.ts (modify)
- src/formatter.test.ts (modify)

## Risks
- ClaudeProcess mock: need to correctly mock EventEmitter-based spawn result
- enrichPromptWithUrls: async, needs careful https mock setup
- resolveClaude is a private module function — test via ClaudeProcess constructor PATH side effects
