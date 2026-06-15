# TODO: feat/loop-state-tracking

- [ ] Create branch feat/loop-state-tracking
- [ ] Add LoopState interface, update Session interface in src/bot.ts
- [ ] Add classifyMessage() export function
- [ ] Add checkCompletionGate() + formatLoopTrace() + buildLoopReprompt() helpers
- [ ] Initialize loopState in handleTelegram message-send path
- [ ] Intercept in handleClaudeMessage for loop gate logic
- [ ] Add /loop_status and /loop_stop command handlers
- [ ] Update BOT_COMMANDS array
- [ ] Clear loopState on /start and /reset (already handled by killSession)
- [ ] Write src/loop-state.test.ts with tests for all new logic
- [ ] npm run build (verify dist/ compiles)
- [ ] npm test (all tests pass)
- [ ] git diff --staged review
- [ ] Commit, push, PR, merge, publish
