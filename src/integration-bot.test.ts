/**
 * Integration tests: Bot → Claude → Telegram response pipeline.
 *
 * Tests the full event chain with real formatting and usage-limit logic:
 *   user message → Claude session → Claude event → formatForTelegram → Telegram
 *
 * ClaudeProcess is mocked but event handlers are captured and invoked manually,
 * exercising all of bot.ts's real response-handling code.
 * Uses fake timers to control the 800 ms debounce flush.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── hoisted mock state ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  tgSendMessage: vi.fn().mockResolvedValue({}),
  tgSendDocument: vi.fn().mockResolvedValue({}),
  tgSendChatAction: vi.fn().mockResolvedValue({}),
  tgSetMyCommands: vi.fn().mockResolvedValue({}),
  tgOn: vi.fn(),
  tgStopPolling: vi.fn(),
  tgGetFileLink: vi.fn().mockResolvedValue('https://example.com/file'),
  tgGetMe: vi.fn().mockResolvedValue({ id: 999, username: 'testbot' }),
  claudeSendPrompt: vi.fn(),
  claudeKill: vi.fn(),
  /** Handlers the bot registers on each ClaudeProcess instance, by event name. */
  claudeHandlers: {} as Record<string, Function>,
  cronList: vi.fn().mockReturnValue([]),
  cronAdd: vi.fn().mockReturnValue({
    id: 'job-1', schedule: 'every 1h', prompt: 'test', chatId: 42, intervalMs: 3_600_000, createdAt: '',
  }),
  cronRemove: vi.fn().mockReturnValue(true),
  cronClearAll: vi.fn().mockReturnValue(0),
  cronUpdate: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(false),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024, isFile: () => true }),
  execSyncMock: vi.fn().mockReturnValue(''),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn(function MockTelegramBot() {
    return {
      on: mocks.tgOn,
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
    return {
      sendPrompt: mocks.claudeSendPrompt,
      sendImage: vi.fn(),
      kill: mocks.claudeKill,
      exited: false,
      on(event: string, handler: Function) {
        mocks.claudeHandlers[event] = handler;
      },
    };
  }),
  /**
   * Real-ish extractText: handles the result and assistant types used in tests.
   * (The actual extractText is tested in claude.test.ts; we replicate its logic here
   *  so bot.ts's handleClaudeMessage works correctly in the integration tests.)
   */
  extractText: vi.fn((msg: Record<string, unknown>) => {
    const payload = msg.payload as Record<string, unknown>;
    if (msg.type === 'result') return (payload?.result as string) ?? '';
    const message = payload?.message as Record<string, unknown> | undefined;
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('');
    }
    return '';
  }),
}));

vi.mock('./cron.js', () => ({
  CronManager: vi.fn(function MockCronManager() {
    return {
      list: mocks.cronList,
      add: mocks.cronAdd,
      remove: mocks.cronRemove,
      clearAll: mocks.cronClearAll,
      update: mocks.cronUpdate,
    };
  }),
}));

vi.mock('./voice.js', () => ({
  isVoiceAvailable: vi.fn().mockReturnValue(false),
  transcribeVoice: vi.fn().mockResolvedValue('transcribed text'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{}'),
    readdirSync: vi.fn().mockReturnValue([]),
    createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), close: vi.fn() }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: mocks.execSyncMock, spawn: vi.fn() };
});

// ── import module under test ──────────────────────────────────────────────────

import { CcTgBot } from './bot.js';

// ── constants matching bot.ts ─────────────────────────────────────────────────

const FLUSH_DELAY_MS = 800;

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Record<string, unknown> = {}) {
  return { chat: { id: 42 }, from: { id: 100 }, text: 'hello', ...overrides };
}

async function sendMsg(bot: CcTgBot, overrides: Record<string, unknown> = {}) {
  await (bot as any).handleTelegram(makeMsg(overrides));
}

function emitClaudeResult(text: string) {
  mocks.claudeHandlers['message']?.({
    type: 'result',
    payload: { result: text },
    raw: { type: 'result' },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('Bot → Claude → Telegram response pipeline', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSendChatAction.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.cronList.mockReturnValue([]);
    mocks.cronClearAll.mockReturnValue(0);
    mocks.existsSyncMock.mockReturnValue(false);
    // Clear captured Claude handlers
    for (const k of Object.keys(mocks.claudeHandlers)) {
      delete mocks.claudeHandlers[k];
    }
    bot = new CcTgBot({ telegramToken: 'test-token' });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  // ── result delivery ────────────────────────────────────────────────────────

  it('delivers Claude result text to Telegram after debounce flush', async () => {
    await sendMsg(bot, { text: 'Hello Claude' });
    emitClaudeResult('Hello back from Claude!');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const calls = mocks.tgSendMessage.mock.calls;
    expect(calls.some(c => (c[1] as string).includes('Hello back from Claude!'))).toBe(true);
  });

  it('does not send result before debounce delay elapses', async () => {
    await sendMsg(bot, { text: 'Quick question' });
    emitClaudeResult('Answer here');

    // Advance only half the debounce window
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS / 2);

    const responseCalls = mocks.tgSendMessage.mock.calls.filter(
      c => (c[1] as string).includes('Answer here')
    );
    expect(responseCalls).toHaveLength(0);
  });

  // ── formatting ─────────────────────────────────────────────────────────────

  it('applies formatForTelegram to Claude result (markdown → HTML)', async () => {
    await sendMsg(bot, { text: 'Format me' });
    emitClaudeResult('**Bold** and _italic_ and `code`');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const lastText = mocks.tgSendMessage.mock.calls.at(-1)![1] as string;
    expect(lastText).toContain('<b>Bold</b>');
    expect(lastText).toContain('<i>italic</i>');
    expect(lastText).toContain('<code>code</code>');
  });

  it('sends with HTML parse_mode option', async () => {
    await sendMsg(bot, { text: 'Hello' });
    emitClaudeResult('Some response');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const opts = mocks.tgSendMessage.mock.calls.at(-1)![2];
    expect(opts?.parse_mode).toBe('HTML');
  });

  // ── message splitting ──────────────────────────────────────────────────────

  it('splits long Claude responses into multiple Telegram messages', async () => {
    await sendMsg(bot, { text: 'Write a lot' });
    // ~8000 chars with paragraph breaks — exceeds 4096 Telegram limit
    const longText = ('word '.repeat(60) + '\n\n').repeat(20).trim();
    emitClaudeResult(longText);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const responseCalls = mocks.tgSendMessage.mock.calls.filter(c => {
      const text = c[1] as string;
      return text.includes('word');
    });
    expect(responseCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of responseCalls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(4096);
    }
  });

  // ── debounce accumulation ──────────────────────────────────────────────────

  it('accumulates multiple result messages into one Telegram send', async () => {
    await sendMsg(bot, { text: 'Multi-chunk' });

    emitClaudeResult('First part. ');
    emitClaudeResult('Second part.');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const allText = mocks.tgSendMessage.mock.calls.map(c => c[1] as string).join(' ');
    expect(allText).toContain('First part.');
    expect(allText).toContain('Second part.');
  });

  it('resets debounce timer on each new result chunk', async () => {
    await sendMsg(bot, { text: 'Streaming' });

    emitClaudeResult('chunk 1 ');
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 100); // not yet

    emitClaudeResult('chunk 2 ');
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 100); // still not

    // Count sends so far
    const beforeFlush = mocks.tgSendMessage.mock.calls.length;

    await vi.advanceTimersByTimeAsync(200); // now past debounce
    const afterFlush = mocks.tgSendMessage.mock.calls.length;

    expect(afterFlush).toBeGreaterThan(beforeFlush);
    const allText = mocks.tgSendMessage.mock.calls.map(c => c[1] as string).join(' ');
    expect(allText).toContain('chunk 1');
    expect(allText).toContain('chunk 2');
  });

  // ── non-result messages ignored ────────────────────────────────────────────

  it('ignores assistant-type streaming messages (only result matters)', async () => {
    await sendMsg(bot, { text: 'Hello' });
    const callsBefore = mocks.tgSendMessage.mock.calls.length;

    mocks.claudeHandlers['message']?.({
      type: 'assistant',
      payload: { message: { content: [{ type: 'text', text: 'streaming chunk' }] } },
      raw: { type: 'assistant' },
    });

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    expect(mocks.tgSendMessage.mock.calls.length).toBe(callsBefore);
  });

  it('ignores empty result messages', async () => {
    await sendMsg(bot, { text: 'Hello' });
    const callsBefore = mocks.tgSendMessage.mock.calls.length;

    emitClaudeResult('');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    expect(mocks.tgSendMessage.mock.calls.length).toBe(callsBefore);
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────

  it('removes session when Claude process exits', async () => {
    await sendMsg(bot, { text: 'Hello' });

    const key = (bot as any).sessionKey(42, undefined);
    expect((bot as any).sessions.has(key)).toBe(true);

    mocks.claudeHandlers['exit']?.(0);

    expect((bot as any).sessions.has(key)).toBe(false);
  });

  it('sends error message to Telegram on Claude process error', async () => {
    await sendMsg(bot, { text: 'Hello' });

    mocks.claudeHandlers['error']?.(new Error('ENOENT: claude not found'));

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Claude process error')
    );
  });

  // ── usage limit handling ───────────────────────────────────────────────────

  it('sends human-readable pause message when Claude hits usage limit', async () => {
    await sendMsg(bot, { text: 'Do something expensive' });

    emitClaudeResult('You have reached your usage limit for this period.');

    await vi.advanceTimersByTimeAsync(50);

    const allTexts = mocks.tgSendMessage.mock.calls.map(c => c[1] as string);
    expect(allTexts.some(t => t.includes('⏸') || t.includes('usage limit'))).toBe(true);
  });

  it('sends rate-limit message for overloaded responses', async () => {
    await sendMsg(bot, { text: 'Try again' });

    emitClaudeResult('Claude is overloaded right now. Please try again later.');

    await vi.advanceTimersByTimeAsync(50);

    const allTexts = mocks.tgSendMessage.mock.calls.map(c => c[1] as string);
    expect(allTexts.some(t => t.includes('⏸') || t.includes('Rate limited'))).toBe(true);
  });

  // ── typing indicator ───────────────────────────────────────────────────────

  it('sends typing indicator when message is submitted', async () => {
    await sendMsg(bot, { text: 'Thinking...' });

    expect(mocks.tgSendChatAction).toHaveBeenCalledWith(42, 'typing', undefined);
  });

  it('sends thread-aware typing indicator for forum topics', async () => {
    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'Hello thread',
      message_thread_id: 7,
    });

    expect(mocks.tgSendChatAction).toHaveBeenCalledWith(42, 'typing', { message_thread_id: 7 });
  });

  // ── thread-keyed responses ─────────────────────────────────────────────────

  it('delivers response to the correct thread via message_thread_id option', async () => {
    await (bot as any).handleTelegram({
      chat: { id: 42 },
      from: { id: 100 },
      text: 'Thread message',
      message_thread_id: 5,
    });

    emitClaudeResult('Thread response text');
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const threadCalls = mocks.tgSendMessage.mock.calls.filter(
      c => c[2]?.message_thread_id === 5
    );
    expect(threadCalls.length).toBeGreaterThan(0);
    expect(threadCalls.some(c => (c[1] as string).includes('Thread response text'))).toBe(true);
  });

  it('separate sessions for different threads have isolated event handlers', async () => {
    // Thread 1
    await (bot as any).handleTelegram({
      chat: { id: 42 }, from: { id: 100 }, text: 'Thread 1', message_thread_id: 1,
    });
    const thread1Handler = mocks.claudeHandlers['message'];

    // Thread 2 (creates a new session, overwriting claudeHandlers)
    await (bot as any).handleTelegram({
      chat: { id: 42 }, from: { id: 100 }, text: 'Thread 2', message_thread_id: 2,
    });

    // Both sessions should exist
    expect((bot as any).sessions.has('42:1')).toBe(true);
    expect((bot as any).sessions.has('42:2')).toBe(true);

    // Thread 1's handler was registered before thread 2 was created
    expect(typeof thread1Handler).toBe('function');
  });

  // ── isRetry prefix ─────────────────────────────────────────────────────────

  it('prepends retry confirmation when session isRetry flag is set', async () => {
    await sendMsg(bot, { text: 'Retry me' });

    // Manually set the isRetry flag on the session
    const key = (bot as any).sessionKey(42, undefined);
    const session = (bot as any).sessions.get(key);
    if (session) session.isRetry = true;

    emitClaudeResult('Here is the answer after retry.');
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 50);

    const allText = mocks.tgSendMessage.mock.calls.map(c => c[1] as string).join(' ');
    expect(allText).toContain('✅ Claude is back!');
  });
});
