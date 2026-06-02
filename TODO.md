# TODO: feat/effort-control

- [ ] Create branch feat/effort-control
- [ ] Add effort + compact to BOT_COMMANDS in bot.ts
- [ ] Add messagesSinceCompact + costWarnSent to Session interface
- [ ] Implement handleEffort() and handleCompact()
- [ ] Wire /effort and /compact in handleTelegram()
- [ ] Add maybeSendAutoCompact() and call it before sendPrompt
- [ ] Increment messagesSinceCompact in handleClaudeMessage
- [ ] Add cost warning in flushPending
- [ ] Update README.md with new commands and env vars
- [ ] Write tests for new features in bot.test.ts
- [ ] Run build (npm run build) and tests (npm test)
- [ ] git diff --staged review
- [ ] Commit, push, PR, merge, publish
