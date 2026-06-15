# PLAN.md — feat/loop-state-tracking

## Task Restatement
Add loop state tracking to cc-tg sessions so that goal-oriented messages automatically verify
completion after each Claude response and re-prompt on failure, up to a configurable maximum.
Users see only the final result (happy path invisible), a `/loop_status` command, and a
`/loop_stop` escape hatch.

## Approach
Single-pass implementation directly in `src/bot.ts`:
1. Add `LoopState` interface and optional `loopState` field to `Session`
2. Add `classifyMessage(text)` — heuristic to distinguish goal vs question
3. Add `checkCompletionGate(text)` — regex scan for completion signals in response text
4. Intercept in `handleClaudeMessage` after text extraction: when `loopState` is active, run the gate before accumulating `pendingText`; re-prompt or flush-with-trace accordingly
5. Initialize `loopState` in the normal message-send path when `classifyMessage` returns "goal"
6. Add `/loop_status` and `/loop_stop` commands + BOT_COMMANDS entries
7. Write tests in a new `src/loop-state.test.ts` file

## Files to Touch
- `src/bot.ts` — all implementation changes
- `src/loop-state.test.ts` — new test file

## Risks and Unknowns
- Goal detection heuristic may produce false positives (conversational message classified as goal).
  Mitigation: keep the heuristic conservative; short messages and explicit questions → question.
- Completion gate may false-positive on response text that mentions "merged" in context without
  actual completion. Mitigation: require specific compound patterns (PR URL, "npm publish" + version).
- Re-prompting increases token spend. Mitigation: default max_iterations=3, user can /loop_stop.
- `session.pendingText` may already have partial text from streaming chunks by the time `result`
  fires. Looking at the code: result messages are the only ones that accumulate pendingText
  (streaming assistant chunks are filtered out in handleClaudeMessage). Safe to intercept here.
