# TODO: Protocol Compliance Audit

- [x] Read all relevant source files and audit against protocol spec
- [x] Write PLAN.md and TODO.md
- [ ] Create branch fix/protocol-compliance
- [ ] Fix ChatMessage id to use crypto.randomUUID() in bot.ts and notifier.ts
- [ ] Add LIFO ordering comment to writeChatLog() LPUSH in notifier.ts
- [ ] Fix meta-agent input queue: lpush → rpush + add timing comment in notifier.ts
- [ ] Add descriptive comment to FLUSH_DELAY_MS in bot.ts
- [ ] Extract 1500ms to META_AGENT_FLUSH_DELAY_MS constant + add comment in notifier.ts
- [ ] Add token rotation independence comment to tokens.ts
- [ ] Create docs/redis-protocol.md
- [ ] Run build, verify it passes
- [ ] Commit, push, PR, merge, publish
