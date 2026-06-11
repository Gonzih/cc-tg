# PLAN.md — feat/remove-hashtag-routing

## Task Restatement
Remove all automatic hashtag-triggered meta-agent routing from cc-tg. This includes
the `#tag` / `#org/repo` pattern that spawned external meta-agents, and the forum-topic
based routing that used the same underlying functions. After removal, all Telegram
messages go directly to the local Claude session. The `/agents` command and notifier
wiring remain untouched.

---

## Approach
Single surgical removal pass — delete the router module and all call sites in bot.ts
and the associated tests. No replacement logic needed.

**Files to change:**
- `src/router.ts` — delete entirely (parseRoutingTag, RoutingTag, ensureMetaAgent, routeToMetaAgent, CallToolFn)
- `src/router.test.ts` — delete entirely
- `src/forum-routing.test.ts` — delete entirely (tests normalizeTopicNamespace + forum routing)
- `src/bot.ts`:
  - Remove import of parseRoutingTag, ensureMetaAgent, routeToMetaAgent from ./router.js
  - Remove `topicNameCache` private field
  - Remove topicNameCache population block (~lines 367-386)
  - Remove hashtag routing block (~lines 582-608)
  - Remove forum routing block (~lines 610-645)
  - Remove `getForumRoutingConfig()` method
  - Remove `normalizeTopicNamespace` exported function
- `src/bot.error.test.ts`:
  - Remove parseRoutingTagMock, ensureMetaAgentMock, routeToMetaAgentMock from mocks
  - Remove `vi.mock('./router.js', ...)` block
  - Remove describe section 3 "hashtag meta-agent routing" (lines ~352-500)
  - Remove describe section 4 "forum topic routing via topicNameCache" (lines ~502-659)
  - Clean up `mocks.parseRoutingTagMock.mockReturnValue(null)` from all remaining beforeEach blocks

**Keep untouched:**
- `registerRoutedChatId` in BotOptions (still referenced in index.ts/notifier)
- `metaAgentStatusKey` import and `/agents` command handler
- `startNotifier` and notifier.ts
- `src/index.ts`

---

## Risks
- Some tests in bot.error.test.ts reference topicNameCache directly via `(bot as any).topicNameCache`
  — those tests are in the forum routing section being deleted, so fine.
- META_AGENT_TIMEOUT_MS env var used only in ensureMetaAgent — becomes dead env var, no action needed.
