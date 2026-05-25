/**
 * Integration tests for uncovered error branches and edge cases in CcTgBot.
 *
 * Covers scenarios NOT tested in bot.integration.test.ts / bot.test.ts:
 *  - Unauthorized user rejection (full handleTelegram flow)
 *  - Group chat filtering (allowlist, mention, reply-to-bot, command)
 *  - Hashtag meta-agent routing (acknowledgement, error recovery, no-redis fallthrough)
 *  - Forum topic routing (auto/off/named-set config, topicNameCache)
 *  - forwardNotification session guards (active, none, exited)
 *  - handleUserMessage error path (sendPrompt throws)
 *  - Claude process error event handling
 *  - sendMessage HTML parse fail → plain text retry
 *  - getLastActiveChatId tracking
 *  - Voice Redis bookkeeping (rpush/lrem/voice:failed)
 *  - /voice_retry command (no-redis, dedup, expired file_id, stale purge)
 *  - CostStore corrupt JSON recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Hoisted stubs — created before vi.mock() factories run
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  // Telegram bot API
  tgSendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  tgSendDocument: vi.fn().mockResolvedValue({}),
  tgSendChatAction: vi.fn().mockResolvedValue({}),
  tgSetMyCommands: vi.fn().mockResolvedValue({}),
  tgStopPolling: vi.fn(),
  tgGetFileLink: vi.fn().mockResolvedValue('https://example.com/file'),
  tgGetMe: vi.fn().mockResolvedValue({ id: 999, username: 'testbot' }),
  // Claude process reference (reset to null in each beforeEach)
  claudeInstance: null as null | ClaudeStub,
  // fs
  existsSyncMock: vi.fn().mockReturnValue(false),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024, isFile: () => true }),
  readFileSyncMock: vi.fn().mockReturnValue('{}'),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  // child_process
  execSyncMock: vi.fn().mockReturnValue(''),
  // Redis operations (passed in as redis option to CcTgBot)
  redisRpush: vi.fn().mockResolvedValue(1),
  redisLrem: vi.fn().mockResolvedValue(1),
  redisLrange: vi.fn().mockResolvedValue([] as string[]),
  redisGet: vi.fn().mockResolvedValue(null as string | null),
  redisExpire: vi.fn().mockResolvedValue(1),
  redisLpush: vi.fn().mockResolvedValue(1),
  redisLtrim: vi.fn().mockResolvedValue('OK'),
  redisPublish: vi.fn().mockResolvedValue(1),
  // Router module functions
  parseRoutingTagMock: vi.fn().mockReturnValue(null),
  ensureMetaAgentMock: vi.fn().mockResolvedValue(undefined),
  routeToMetaAgentMock: vi.fn().mockResolvedValue(undefined),
  // Voice module functions
  isVoiceAvailableMock: vi.fn().mockReturnValue(true),
  transcribeVoiceMock: vi.fn().mockResolvedValue('hello'),
}));

// ---------------------------------------------------------------------------
// ClaudeProcess stub — real EventEmitter so tests can emit events
// ---------------------------------------------------------------------------
class ClaudeStub extends EventEmitter {
  sendPrompt = vi.fn();
  sendImage = vi.fn();
  kill = vi.fn();
  exited = false;
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn(function MockTelegramBot() {
    return {
      on: vi.fn(),
      sendMessage: mocks.tgSendMessage,
      sendDocument: mocks.tgSendDocument,
      sendChatAction: mocks.tgSendChatAction,
      setMyCommands: mocks.tgSetMyCommands,
      stopPolling: mocks.tgStopPolling,
      getFileLink: mocks.tgGetFileLink,
      getMe: mocks.tgGetMe,
    };
  }),
}));

vi.mock('./claude.js', () => ({
  ClaudeProcess: vi.fn(function MockClaudeProcess() {
    const inst = new ClaudeStub();
    mocks.claudeInstance = inst;
    return inst;
  }),
  extractText: vi.fn(function extractText(msg: Record<string, unknown>) {
    const payload = msg.payload as Record<string, unknown>;
    if (msg.type === 'result') return (payload?.result as string) ?? '';
    const message = payload?.message as Record<string, unknown> | undefined;
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('');
    }
    return '';
  }),
}));

vi.mock('./voice.js', () => ({
  isVoiceAvailable: mocks.isVoiceAvailableMock,
  transcribeVoice: mocks.transcribeVoiceMock,
}));

vi.mock('./router.js', () => ({
  parseRoutingTag: (...args: unknown[]) => mocks.parseRoutingTagMock(...args),
  ensureMetaAgent: (...args: unknown[]) => mocks.ensureMetaAgentMock(...args),
  routeToMetaAgent: (...args: unknown[]) => mocks.routeToMetaAgentMock(...args),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    readFileSync: mocks.readFileSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    readdirSync: vi.fn().mockReturnValue([]),
    createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), end: vi.fn() }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: mocks.execSyncMock, spawn: vi.fn() };
});

import { CcTgBot } from './bot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedis() {
  return {
    rpush: mocks.redisRpush,
    lrem: mocks.redisLrem,
    lrange: mocks.redisLrange,
    get: mocks.redisGet,
    expire: mocks.redisExpire,
    lpush: mocks.redisLpush,
    ltrim: mocks.redisLtrim,
    publish: mocks.redisPublish,
  } as unknown as import('ioredis').Redis;
}

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 42 },
    from: { id: 100 },
    text: 'hello',
    ...overrides,
  };
}

function emitResult(text: string) {
  const inst = mocks.claudeInstance!;
  inst.emit('message', { type: 'result', payload: { result: text }, raw: {} });
}

// ===========================================================================
// 1. Unauthorized user
// ===========================================================================
describe('CcTgBot — authorization via handleTelegram', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
  });

  afterEach(() => {
    bot?.stop();
    vi.useRealTimers();
  });

  it('sends "Not authorized." and does not create Claude session for unknown user', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', allowedUserIds: [999] });
    await (bot as any).handleTelegram(makeMsg({ from: { id: 1 } }));

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Not authorized.');
    expect(mocks.claudeInstance).toBeNull();
  });

  it('allows authorized user through and creates a Claude session', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', allowedUserIds: [100] });
    await (bot as any).handleTelegram(makeMsg({ from: { id: 100 } }));

    expect(mocks.tgSendMessage).not.toHaveBeenCalledWith(expect.anything(), 'Not authorized.');
    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('allows anyone when allowedUserIds is not configured', async () => {
    bot = new CcTgBot({ telegramToken: 'tok' });
    await (bot as any).handleTelegram(makeMsg({ from: { id: 99999 } }));

    expect(mocks.tgSendMessage).not.toHaveBeenCalledWith(expect.anything(), 'Not authorized.');
    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('uses chat.id as userId when from is absent and rejects if not allowed', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', allowedUserIds: [999] }); // chatId=42 not in list
    await (bot as any).handleTelegram({ chat: { id: 42 }, text: 'hi' }); // no from

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Not authorized.');
    expect(mocks.claudeInstance).toBeNull();
  });
});

// ===========================================================================
// 2. Group chat filtering
// ===========================================================================
describe('CcTgBot — group chat filtering', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
    // Set bot identity synchronously (normally resolved via async getMe())
    (bot as any).botUsername = 'testbot';
    (bot as any).botId = 999;
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('silently ignores group message with no @mention, no reply-to-bot, no command', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: 'random chat message',
    }));

    expect(mocks.claudeInstance).toBeNull();
    expect(mocks.tgSendMessage).not.toHaveBeenCalled();
  });

  it('responds to @botname mention in group chat', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: '@testbot what is 2+2?',
    }));

    expect(mocks.claudeInstance).not.toBeNull();
    // Mention is stripped from the prompt
    expect(mocks.claudeInstance!.sendPrompt).toHaveBeenCalledWith(
      expect.stringMatching(/what is 2\+2\?/),
    );
  });

  it('responds to /command in group chat', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: '/status',
    }));

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('No active session'),
    );
  });

  it('responds when message is a reply to the bot', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: 'is this working?',
      reply_to_message: { from: { id: 999 } }, // bot's id
    }));

    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('ignores group message that is a reply to a non-bot user', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: 'sounds good',
      reply_to_message: { from: { id: 777 } }, // different user
    }));

    expect(mocks.claudeInstance).toBeNull();
  });

  it('ignores group chat not in groupChatIds allowlist', async () => {
    bot.stop();
    bot = new CcTgBot({ telegramToken: 'tok', groupChatIds: [100, 200] });
    (bot as any).botUsername = 'testbot';

    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: '/status',
    }));

    expect(mocks.tgSendMessage).not.toHaveBeenCalled();
    expect(mocks.claudeInstance).toBeNull();
  });

  it('responds in group chat that is in groupChatIds allowlist', async () => {
    bot.stop();
    bot = new CcTgBot({ telegramToken: 'tok', groupChatIds: [42] });
    (bot as any).botUsername = 'testbot';

    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'group' },
      text: '/status',
    }));

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('No active session'),
    );
  });

  it('silently ignores supergroup message with no trigger', async () => {
    await (bot as any).handleTelegram(makeMsg({
      chat: { id: 42, type: 'supergroup' },
      text: 'no trigger here',
    }));

    expect(mocks.claudeInstance).toBeNull();
    expect(mocks.tgSendMessage).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. Hashtag meta-agent routing
// ===========================================================================
describe('CcTgBot — hashtag meta-agent routing', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    mocks.ensureMetaAgentMock.mockResolvedValue(undefined);
    mocks.routeToMetaAgentMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    bot?.stop();
    vi.useRealTimers();
  });

  it('sends "→ #namespace" acknowledgement immediately on routing tag match', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'my-agent',
      repoUrl: 'https://github.com/org/my-agent',
      strippedMessage: 'fix the bug',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#my-agent fix the bug' }));

    // 2-arg call (no threadId → no opts)
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, '→ #my-agent');
  });

  it('does NOT create a local Claude session when routing tag is matched', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'my-agent',
      repoUrl: 'https://github.com/org/my-agent',
      strippedMessage: 'do thing',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#my-agent do thing' }));

    expect(mocks.claudeInstance).toBeNull();
    expect((bot as any).sessions.size).toBe(0);
  });

  it('calls ensureMetaAgent with correct namespace and repoUrl', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'worker',
      repoUrl: 'https://github.com/acme/worker',
      strippedMessage: 'run task',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#acme/worker run task' }));

    expect(mocks.ensureMetaAgentMock).toHaveBeenCalledWith(
      'worker',
      'https://github.com/acme/worker',
      expect.any(Function),
      expect.anything(),
    );
  });

  it('calls routeToMetaAgent with strippedMessage after ensureMetaAgent resolves', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'ns',
      repoUrl: 'https://github.com/org/ns',
      strippedMessage: 'the actual task',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#ns the actual task' }));

    expect(mocks.routeToMetaAgentMock).toHaveBeenCalledWith(
      'ns',
      'the actual task',
      expect.anything(),
    );
  });

  it('sends error reply when ensureMetaAgent throws', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'broken',
      repoUrl: 'https://github.com/org/broken',
      strippedMessage: 'do stuff',
    });
    mocks.ensureMetaAgentMock.mockRejectedValue(new Error('timeout waiting for workspace'));

    await (bot as any).handleTelegram(makeMsg({ text: '#broken do stuff' }));

    const allMessages = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(allMessages.some((t) => t.includes('Failed to route to #broken'))).toBe(true);
    expect(allMessages.some((t) => t.includes('timeout waiting for workspace'))).toBe(true);
  });

  it('calls registerRoutedChatId callback when routing tag is found', async () => {
    const registerRoutedChatId = vi.fn();
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis(), registerRoutedChatId });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'ns1',
      repoUrl: 'https://github.com/org/ns1',
      strippedMessage: 'work',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#ns1 work' }));

    expect(registerRoutedChatId).toHaveBeenCalledWith('ns1', 42);
  });

  it('skips routing when redis is not configured and falls through to local Claude', async () => {
    bot = new CcTgBot({ telegramToken: 'tok' }); // no redis
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'my-agent',
      repoUrl: 'https://github.com/org/my-agent',
      strippedMessage: 'work',
    });

    await (bot as any).handleTelegram(makeMsg({ text: '#my-agent work' }));

    // No redis → routing skipped → local Claude session created
    expect(mocks.claudeInstance).not.toBeNull();
    expect(mocks.ensureMetaAgentMock).not.toHaveBeenCalled();
  });

  it('includes message_thread_id in acknowledgement for forum topic messages', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.parseRoutingTagMock.mockReturnValue({
      namespace: 'ns',
      repoUrl: 'https://github.com/org/ns',
      strippedMessage: 'work',
    });

    await (bot as any).handleTelegram(makeMsg({
      text: '#ns work',
      message_thread_id: 7,
    }));

    // 3-arg call with options object (threadId is passed to replyToChat)
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      '→ #ns',
      expect.objectContaining({ message_thread_id: 7 }),
    );
  });
});

// ===========================================================================
// 4. Forum topic routing
// ===========================================================================
describe('CcTgBot — forum topic routing via topicNameCache', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null); // no hashtag match
    mocks.ensureMetaAgentMock.mockResolvedValue(undefined);
    mocks.routeToMetaAgentMock.mockResolvedValue(undefined);
    delete process.env.FORUM_META_AGENT_ROUTING;
    delete process.env.DEFAULT_GITHUB_ORG;
  });

  afterEach(() => {
    bot?.stop();
    vi.useRealTimers();
    delete process.env.FORUM_META_AGENT_ROUTING;
    delete process.env.DEFAULT_GITHUB_ORG;
  });

  it('routes message to meta-agent in auto mode when topic name is cached', async () => {
    process.env.DEFAULT_GITHUB_ORG = 'myorg';
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    // Pre-populate the cache (no service message needed)
    (bot as any).topicNameCache.set('42:7', 'my-project');

    // Use no chat.type to bypass group filtering; threadId triggers forum routing
    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'please deploy',
      message_thread_id: 7,
    });

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      '→ #my-project (meta-agent)',
      expect.objectContaining({ message_thread_id: 7 }),
    );
    expect(mocks.ensureMetaAgentMock).toHaveBeenCalled();
    expect(mocks.claudeInstance).toBeNull();
  });

  it('does not route when FORUM_META_AGENT_ROUTING=off, falls through to Claude', async () => {
    process.env.FORUM_META_AGENT_ROUTING = 'off';
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    (bot as any).topicNameCache.set('42:7', 'my-project');

    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'please deploy',
      message_thread_id: 7,
    });

    expect(mocks.ensureMetaAgentMock).not.toHaveBeenCalled();
    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('routes only named topics when FORUM_META_AGENT_ROUTING contains matching topic', async () => {
    process.env.FORUM_META_AGENT_ROUTING = 'my-project,other-service';
    process.env.DEFAULT_GITHUB_ORG = 'myorg';
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    (bot as any).topicNameCache.set('42:7', 'my-project'); // in the allowlist

    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'do something',
      message_thread_id: 7,
    });

    expect(mocks.ensureMetaAgentMock).toHaveBeenCalled();
    expect(mocks.claudeInstance).toBeNull();
  });

  it('does not route when topic is NOT in the named allowlist, falls through to Claude', async () => {
    process.env.FORUM_META_AGENT_ROUTING = 'other-topic';
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    (bot as any).topicNameCache.set('42:7', 'my-project'); // not in allowlist

    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'do something',
      message_thread_id: 7,
    });

    expect(mocks.ensureMetaAgentMock).not.toHaveBeenCalled();
    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('does not route when topic name is not in cache, falls through to Claude', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    // No topicNameCache entry

    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'regular message',
      message_thread_id: 7,
    });

    expect(mocks.ensureMetaAgentMock).not.toHaveBeenCalled();
    expect(mocks.claudeInstance).not.toBeNull();
  });

  it('caches topic name from forum_topic_created service message', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram({
      chat: { id: 42, type: 'supergroup' },
      from: { id: 100 },
      message_thread_id: 9,
      forum_topic_created: { name: 'new-topic' },
    });

    expect((bot as any).topicNameCache.get('42:9')).toBe('new-topic');
  });

  it('updates cached topic name from forum_topic_edited service message', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    (bot as any).topicNameCache.set('42:9', 'old-name');

    await (bot as any).handleTelegram({
      chat: { id: 42, type: 'supergroup' },
      from: { id: 100 },
      message_thread_id: 9,
      forum_topic_edited: { name: 'updated-name' },
    });

    expect((bot as any).topicNameCache.get('42:9')).toBe('updated-name');
  });

  it('sends error reply when forum ensureMetaAgent throws', async () => {
    process.env.DEFAULT_GITHUB_ORG = 'myorg';
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    (bot as any).topicNameCache.set('42:7', 'my-project');
    mocks.ensureMetaAgentMock.mockRejectedValue(new Error('startup failed'));

    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'do work',
      message_thread_id: 7,
    });

    const allMessages = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(allMessages.some((t) => t.includes('Failed to route to #my-project'))).toBe(true);
    expect(allMessages.some((t) => t.includes('startup failed'))).toBe(true);
  });
});

// ===========================================================================
// 5. forwardNotification session guards
// ===========================================================================
describe('CcTgBot — forwardNotification', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('feeds notification into active session sendPrompt', async () => {
    await (bot as any).handleTelegram(makeMsg({ text: 'start session' }));
    const promptsBefore = mocks.claudeInstance!.sendPrompt.mock.calls.length;

    bot.forwardNotification(42, 'Job finished!');

    expect(mocks.claudeInstance!.sendPrompt.mock.calls.length).toBe(promptsBefore + 1);
  });

  it('does NOT create a new session when no active session exists', () => {
    expect((bot as any).sessions.size).toBe(0);
    expect(mocks.claudeInstance).toBeNull();

    bot.forwardNotification(42, 'phantom notification');

    expect((bot as any).sessions.size).toBe(0);
    // claudeInstance should still be null (no new session created)
    expect(mocks.claudeInstance).toBeNull();
  });

  it('silently ignores notification when active session has exited', async () => {
    await (bot as any).handleTelegram(makeMsg({ text: 'start' }));
    const inst = mocks.claudeInstance!;
    inst.exited = true;
    const callsBefore = inst.sendPrompt.mock.calls.length;

    bot.forwardNotification(42, 'post-exit notification');

    // sendPrompt was NOT called again after the exited mark
    expect(inst.sendPrompt.mock.calls.length).toBe(callsBefore);
  });

  it('does not throw for unknown chatId with no session', () => {
    expect(() => bot.forwardNotification(999, 'nobody home')).not.toThrow();
    expect((bot as any).sessions.size).toBe(0);
  });
});

// ===========================================================================
// 6. handleUserMessage error path
// ===========================================================================
describe('CcTgBot — handleUserMessage error path', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('sends error reply and kills session when sendPrompt throws in handleUserMessage', async () => {
    // Establish a session first
    await (bot as any).handleTelegram(makeMsg({ text: 'init session' }));
    expect((bot as any).sessions.size).toBe(1);

    // Make sendPrompt throw on the next call
    mocks.claudeInstance!.sendPrompt.mockImplementationOnce(() => {
      throw new Error('stdin closed');
    });

    await bot.handleUserMessage(42, 'message from UI');

    const allMessages = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(allMessages.some((t) => t.includes('Error sending to Claude'))).toBe(true);
    // Session should be killed
    expect((bot as any).sessions.size).toBe(0);
  });

  it('creates a new session if none exists (handleUserMessage always creates)', async () => {
    expect((bot as any).sessions.size).toBe(0);

    await bot.handleUserMessage(42, 'fresh message');

    expect(mocks.claudeInstance).not.toBeNull();
    expect((bot as any).sessions.size).toBe(1);
  });
});

// ===========================================================================
// 7. Claude process error event
// ===========================================================================
describe('CcTgBot — Claude process error event', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('sends error message to chat when Claude process emits error event', async () => {
    await (bot as any).handleTelegram(makeMsg({ text: 'start' }));
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({ message_id: 2 });

    mocks.claudeInstance!.emit('error', new Error('ENOENT: claude binary not found'));
    await vi.runAllTimersAsync();

    const allMessages = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(allMessages.some((t) => t.includes('Claude process error'))).toBe(true);
  });

  it('removes session from map after Claude error event', async () => {
    await (bot as any).handleTelegram(makeMsg({ text: 'start' }));
    expect((bot as any).sessions.size).toBe(1);

    mocks.claudeInstance!.emit('error', new Error('crash'));
    await vi.runAllTimersAsync();

    expect((bot as any).sessions.size).toBe(0);
  });
});

// ===========================================================================
// 8. sendMessage HTML parse fail → plain text retry
// ===========================================================================
describe('CcTgBot — sendMessage HTML failure retry', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('retries sendMessage without parse_mode when HTML parse fails', async () => {
    // First call (HTML) rejects, second (plain text retry) resolves
    mocks.tgSendMessage
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValue({ message_id: 2 });

    await (bot as any).handleTelegram(makeMsg({ text: 'test' }));
    emitResult('Response with **markdown**');
    await vi.runAllTimersAsync();

    const calls = mocks.tgSendMessage.mock.calls;
    // The HTML call has parse_mode: 'HTML'
    const htmlCall = calls.find((c) => c[2]?.parse_mode === 'HTML');
    // The retry call has no parse_mode (plain text)
    const plainCall = calls.find((c) => typeof c[2] === 'undefined' || !c[2]?.parse_mode);

    expect(htmlCall).toBeDefined();
    expect(plainCall).toBeDefined();
  });
});

// ===========================================================================
// 9. getLastActiveChatId tracking
// ===========================================================================
describe('CcTgBot — getLastActiveChatId', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    bot = new CcTgBot({ telegramToken: 'tok' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it('returns undefined before any messages have been received', () => {
    expect(bot.getLastActiveChatId()).toBeUndefined();
  });

  it('returns chatId after first message', async () => {
    await (bot as any).handleTelegram(makeMsg({ chat: { id: 77 }, text: 'hi' }));
    expect(bot.getLastActiveChatId()).toBe(77);
  });

  it('updates to the most recent chatId', async () => {
    await (bot as any).handleTelegram(makeMsg({ chat: { id: 10 }, text: 'first' }));
    await (bot as any).handleTelegram(makeMsg({ chat: { id: 20 }, text: 'second' }));
    expect(bot.getLastActiveChatId()).toBe(20);
  });
});

// ===========================================================================
// 10. Voice message Redis bookkeeping
// ===========================================================================
describe('CcTgBot — voice message Redis bookkeeping', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.tgGetFileLink.mockResolvedValue('https://tg.example.com/voice.ogg');
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    mocks.isVoiceAvailableMock.mockReturnValue(true);
    mocks.transcribeVoiceMock.mockResolvedValue('hello voice');
    mocks.redisRpush.mockResolvedValue(1);
    mocks.redisLrem.mockResolvedValue(1);
    mocks.redisExpire.mockResolvedValue(1);
  });

  afterEach(() => {
    bot?.stop();
  });

  it('RPUSHes a pending entry to voice:pending before transcription', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v-abc', duration: 3 },
    }));

    const pendingCall = mocks.redisRpush.mock.calls.find(
      ([key]: [string]) => key === 'voice:pending',
    );
    expect(pendingCall).toBeDefined();
    expect(pendingCall![1]).toContain('"file_id":"v-abc"');
  });

  it('LREMs the pending entry from voice:pending after successful transcription', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v-ok', duration: 3 },
    }));

    const pendingRemove = mocks.redisLrem.mock.calls.find(
      ([key]: [string]) => key === 'voice:pending',
    );
    expect(pendingRemove).toBeDefined();
    expect(pendingRemove![2]).toContain('"file_id":"v-ok"');
  });

  it('RPUSHes to voice:failed and sets EXPIRE on transcription error', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('whisper-cpp failed: signal 11'));
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v-bad', duration: 2 },
    }));

    const failedCall = mocks.redisRpush.mock.calls.find(
      ([key]: [string]) => key === 'voice:failed',
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1]).toContain('"file_id":"v-bad"');
    expect(mocks.redisExpire).toHaveBeenCalledWith('voice:failed', expect.any(Number));
  });

  it('sends "whisper-cpp not installed" for missing binary', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('whisper-cpp not found in PATH'));
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v1', duration: 1 },
    }));

    const msgs = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(msgs.some((t) => t.includes('whisper-cpp not installed'))).toBe(true);
  });

  it('sends "no whisper model found" for missing model', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('No whisper model found in models/'));
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v2', duration: 1 },
    }));

    const msgs = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(msgs.some((t) => t.includes('no whisper model found'))).toBe(true);
  });

  it('sends "Could not download voice file" for HTTP download errors', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('HTTP 403 while downloading voice ogg'));
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v3', duration: 1 },
    }));

    const msgs = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(msgs.some((t) => t.includes('Could not download voice file'))).toBe(true);
  });

  it('sends generic failure message for unknown errors', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('segfault in whisper decoder'));
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v4', duration: 1 },
    }));

    const msgs = mocks.tgSendMessage.mock.calls.map(([, t]: [unknown, string]) => t);
    expect(msgs.some((t) => t.includes('Voice transcription failed'))).toBe(true);
    expect(msgs.some((t) => t.includes('segfault in whisper decoder'))).toBe(true);
  });

  it('skips all Redis operations when redis not configured', async () => {
    bot = new CcTgBot({ telegramToken: 'tok' }); // no redis
    mocks.transcribeVoiceMock.mockResolvedValue('ok transcript');

    await (bot as any).handleTelegram(makeMsg({
      text: undefined,
      voice: { file_id: 'v5', duration: 1 },
    }));

    expect(mocks.redisRpush).not.toHaveBeenCalled();
    expect(mocks.redisLrem).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 11. /voice_retry command
// ===========================================================================
describe('CcTgBot — /voice_retry command', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });
    mocks.tgGetFileLink.mockResolvedValue('https://tg.example.com/voice.ogg');
    mocks.readFileSyncMock.mockReturnValue('{}');
    mocks.parseRoutingTagMock.mockReturnValue(null);
    mocks.isVoiceAvailableMock.mockReturnValue(true);
    mocks.transcribeVoiceMock.mockResolvedValue('ok transcript');
    mocks.redisLrange.mockResolvedValue([]);
    mocks.redisLrem.mockResolvedValue(1);
  });

  afterEach(() => {
    bot?.stop();
  });

  it('sends redis-unavailable message when redis is not configured', async () => {
    bot = new CcTgBot({ telegramToken: 'tok' });
    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    // 2-arg sendMessage call (no threadId)
    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Redis not configured'),
    );
  });

  it('sends "no pending voice messages" when both lists are empty', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    mocks.redisLrange.mockResolvedValue([]);

    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('No pending voice'),
    );
  });

  it('deduplicates entries with the same file_id across pending and failed lists', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    const entry = JSON.stringify({
      file_id: 'dup-id',
      chat_id: 42,
      message_id: 1,
      timestamp: Date.now(),
    });
    // Same file_id appears in both pending and failed — should only transcribe once
    mocks.redisLrange.mockResolvedValue([entry]);

    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    expect(mocks.transcribeVoiceMock).toHaveBeenCalledTimes(1);
  });

  it('removes expired file_id from voice:pending on Bad Request error', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    const entry = JSON.stringify({
      file_id: 'expired-id',
      chat_id: 42,
      message_id: 5,
      timestamp: Date.now(),
    });
    mocks.redisLrange.mockResolvedValue([entry]);
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('Bad Request: file_id is no longer valid'));

    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    const pendingRemove = mocks.redisLrem.mock.calls.find(
      ([key]: [string]) => key === 'voice:pending',
    );
    expect(pendingRemove).toBeDefined();
    expect(pendingRemove![2]).toContain('"file_id":"expired-id"');
  });

  it('purges stale entries older than 48h from voice:pending', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    const staleEntry = JSON.stringify({
      file_id: 'stale-id',
      chat_id: 42,
      message_id: 3,
      timestamp: Date.now() - 50 * 60 * 60 * 1000, // 50h ago
    });
    mocks.redisLrange.mockResolvedValue([staleEntry]);
    // getFileLink rejects so it doesn't succeed
    mocks.tgGetFileLink.mockRejectedValue(new Error('Bad Request: file expired'));

    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    // Summary should mention stale entries purged
    const summaryCall = mocks.tgSendMessage.mock.calls.find(
      ([, t]: [unknown, string]) => typeof t === 'string' && t.includes('stale'),
    );
    expect(summaryCall).toBeDefined();
  });

  it('sends completion summary after retry', async () => {
    bot = new CcTgBot({ telegramToken: 'tok', redis: makeRedis() });
    const entry = JSON.stringify({
      file_id: 'ok-file',
      chat_id: 42,
      message_id: 7,
      timestamp: Date.now(),
    });
    mocks.redisLrange.mockResolvedValue([entry]);
    mocks.transcribeVoiceMock.mockResolvedValue('good transcript');

    await (bot as any).handleTelegram(makeMsg({ text: '/voice_retry' }));

    const summaryCall = mocks.tgSendMessage.mock.calls.find(
      ([, t]: [unknown, string]) => typeof t === 'string' && t.includes('Voice retry complete'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![1]).toContain('1 succeeded');
  });
});

// ===========================================================================
// 12. CostStore corrupt JSON recovery
// ===========================================================================
describe('CcTgBot — CostStore corrupt JSON recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claudeInstance = null;
    mocks.parseRoutingTagMock.mockReturnValue(null);
  });

  it('constructs without throwing when costs.json contains invalid JSON', () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue('{ this is NOT valid JSON !!!');

    let bot: CcTgBot | undefined;
    expect(() => {
      bot = new CcTgBot({ telegramToken: 'tok' });
    }).not.toThrow();

    bot?.stop();
  });

  it('initialises with zero costs when costs.json is corrupt', () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue('CORRUPT_DATA');

    const bot = new CcTgBot({ telegramToken: 'tok' });
    const cost = (bot as any).costStore.get(42);

    expect(cost.totalInputTokens).toBe(0);
    expect(cost.totalOutputTokens).toBe(0);
    expect(cost.totalCostUsd).toBe(0);

    bot.stop();
  });

  it('continues processing commands normally after corrupt JSON load', async () => {
    vi.useFakeTimers();
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue('not-json');
    mocks.tgSendMessage.mockResolvedValue({ message_id: 1 });

    const bot = new CcTgBot({ telegramToken: 'tok' });
    await (bot as any).handleTelegram(makeMsg({ text: '/status' }));

    // Bot should still respond normally
    const calls = mocks.tgSendMessage.mock.calls;
    const statusCall = calls.find(([, t]: [unknown, string]) => typeof t === 'string' && t.includes('No active session'));
    expect(statusCall).toBeDefined();

    bot.stop();
    vi.useRealTimers();
  });
});
