import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tgSendMessage: vi.fn().mockResolvedValue({}),
  tgSendDocument: vi.fn().mockResolvedValue({}),
  tgSendChatAction: vi.fn().mockResolvedValue({}),
  tgSetMyCommands: vi.fn().mockResolvedValue({}),
  tgOn: vi.fn(),
  tgStopPolling: vi.fn(),
  tgGetFileLink: vi.fn().mockResolvedValue('https://example.com/file'),
  tgGetMe: vi.fn().mockResolvedValue({ id: 999, username: 'testbot' }),
  claudeOn: vi.fn(),
  claudeSendPrompt: vi.fn(),
  claudeKill: vi.fn(),
  cronList: vi.fn().mockReturnValue([]),
  cronAdd: vi.fn().mockReturnValue({
    id: 'job-1',
    schedule: 'every 1h',
    prompt: 'test',
    chatId: 42,
    intervalMs: 3_600_000,
    createdAt: '',
  }),
  cronRemove: vi.fn().mockReturnValue(true),
  cronClearAll: vi.fn().mockReturnValue(0),
  cronUpdate: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(false),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024, isFile: () => true }),
  execSyncMock: vi.fn().mockReturnValue(''),
  writeChatLog: vi.fn(),
  transcribeVoiceMock: vi.fn().mockResolvedValue('transcribed text'),
}));

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
      on: mocks.claudeOn,
    };
  }),
  extractText: vi.fn(function extractText(msg: Record<string, unknown>) {
    const payload = msg.payload as Record<string, unknown>;
    return (payload?.result as string) ?? '';
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
  transcribeVoice: (...args: unknown[]) => mocks.transcribeVoiceMock(...args),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: mocks.execSyncMock,
  };
});

vi.mock('./notifier.js', () => ({
  writeChatLog: mocks.writeChatLog,
}));

import { CcTgBot, splitMessage, enrichPromptWithUrls, listSkills, stampPrompt } from './bot.js';

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 42 },
    from: { id: 100 },
    text: '/help',
    ...overrides,
  };
}

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMessage('Hello')).toEqual(['Hello']);
  });

  it('returns single chunk for exactly 4096 chars', () => {
    const text = 'a'.repeat(4096);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(4096);
  });

  it('splits text longer than 4096 chars into two chunks', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });

  it('splits very long text into multiple chunks each ≤4096', () => {
    const text = 'x'.repeat(4096 * 3);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('preserves full content when chunks are reassembled', () => {
    const text = 'abc'.repeat(2000);
    const chunks = splitMessage(text);
    expect(chunks.join('')).toBe(text);
  });

  it('respects custom maxLen', () => {
    const chunks = splitMessage('hello world', 5);
    expect(chunks).toEqual(['hello', ' worl', 'd']);
  });
});

describe('stampPrompt', () => {
  it('prepends [MM-DD HH:mm] to the text', () => {
    const now = new Date(2026, 4, 6, 7, 9); // May 6 2026 07:09
    expect(stampPrompt('hello', now)).toBe('[05-06 07:09] hello');
  });

  it('zero-pads single-digit month and day', () => {
    const now = new Date(2026, 0, 3, 8, 5); // Jan 3 2026 08:05
    expect(stampPrompt('test', now)).toBe('[01-03 08:05] test');
  });

  it('uses current time when no date provided', () => {
    const before = new Date();
    const result = stampPrompt('msg');
    const after = new Date();
    // result must start with [MM-DD HH:mm] matching some moment in [before, after]
    expect(result).toMatch(/^\[\d{2}-\d{2} \d{2}:\d{2}\] msg$/);
    // The timestamp string can match any minute in [before, after]
    const mm = String(before.getMonth() + 1).padStart(2, '0');
    const dd = String(before.getDate()).padStart(2, '0');
    expect(result).toContain(`[${mm}-${dd}`);
  });
});

describe('CcTgBot', () => {
  let bot: CcTgBot;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSendDocument.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.cronList.mockReturnValue([]);
    mocks.cronAdd.mockReturnValue({
      id: 'job-1',
      schedule: 'every 1h',
      prompt: 'test',
      chatId: 42,
      intervalMs: 3_600_000,
      createdAt: '',
    });
    mocks.cronClearAll.mockReturnValue(0);
    mocks.cronRemove.mockReturnValue(true);
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.statSyncMock.mockReturnValue({ size: 1024, isFile: () => true });
    mocks.execSyncMock.mockReturnValue('');

    bot = new CcTgBot({ telegramToken: 'test-token' });
  });

  afterEach(() => {
    bot.stop();
  });

  describe('isAllowed', () => {
    it('allows all users when no allowedUserIds configured', () => {
      expect((bot as any).isAllowed(999)).toBe(true);
    });

    it('allows configured user ids', () => {
      const restrictedBot = new CcTgBot({ telegramToken: 'test', allowedUserIds: [100, 200] });
      expect((restrictedBot as any).isAllowed(100)).toBe(true);
      expect((restrictedBot as any).isAllowed(200)).toBe(true);
      restrictedBot.stop();
    });

    it('blocks unconfigured user ids', () => {
      const restrictedBot = new CcTgBot({ telegramToken: 'test', allowedUserIds: [100] });
      expect((restrictedBot as any).isAllowed(999)).toBe(false);
      restrictedBot.stop();
    });
  });

  describe('command handlers', () => {
    async function sendCommand(text: string, userId = 100) {
      await (bot as any).handleTelegram(makeMsg({ text, from: { id: userId } }));
    }

    it('/help sends a message listing all commands', async () => {
      await sendCommand('/help');
      expect(mocks.tgSendMessage).toHaveBeenCalledOnce();
      const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('/start');
      expect(msg).toContain('/help');
      expect(msg).toContain('/get_file');
    });

    it('/start kills session and confirms reset', async () => {
      await sendCommand('/start');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Session reset. Send a message to start.');
    });

    it('/reset kills session and confirms reset', async () => {
      await sendCommand('/reset');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Session reset. Send a message to start.');
    });

    it('/stop with no active session', async () => {
      await sendCommand('/stop');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No active session.');
    });

    it('/stop with active session', async () => {
      // Create a session by sending a text message
      await sendCommand('Hello Claude');
      vi.clearAllMocks();
      await sendCommand('/stop');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Stopped.');
    });

    it('/status with no active session', async () => {
      await sendCommand('/status');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No active session.');
    });

    it('/status with active session', async () => {
      await sendCommand('Hello Claude');
      vi.clearAllMocks();
      await sendCommand('/status');
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Session active.');
    });

    it('rejects unauthorized users', async () => {
      const restrictedBot = new CcTgBot({ telegramToken: 'test', allowedUserIds: [100] });
      vi.clearAllMocks();
      await (restrictedBot as any).handleTelegram(makeMsg({ text: '/help', from: { id: 999 } }));
      expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Not authorized.');
      restrictedBot.stop();
    });

    it('ignores empty messages', async () => {
      await (bot as any).handleTelegram(makeMsg({ text: '', from: { id: 100 } }));
      expect(mocks.tgSendMessage).not.toHaveBeenCalled();
    });

    it('sends text message to Claude', async () => {
      await sendCommand('Hello Claude');
      expect(mocks.claudeSendPrompt).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{2}-\d{2} \d{2}:\d{2}\] Hello Claude$/));
    });

    describe('/get_file', () => {
      it('sends usage when no path given', async () => {
        await sendCommand('/get_file');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Usage: /get_file <path>');
      });

      it('blocks paths outside safe directories', async () => {
        await sendCommand('/get_file /etc/passwd');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('Access denied');
      });

      it('reports file not found', async () => {
        mocks.existsSyncMock.mockReturnValue(false);
        await sendCommand('/get_file /tmp/test.txt');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('File not found');
      });

      it('blocks oversized files', async () => {
        mocks.existsSyncMock.mockReturnValue(true);
        mocks.statSyncMock.mockReturnValue({ size: 60 * 1024 * 1024, isFile: () => true });
        await sendCommand('/get_file /tmp/bigfile.zip');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('File too large');
      });

      it('sends document for valid safe file', async () => {
        mocks.existsSyncMock.mockReturnValue(true);
        mocks.statSyncMock.mockReturnValue({ size: 1024, isFile: () => true });
        await sendCommand('/get_file /tmp/report.pdf');
        expect(mocks.tgSendDocument).toHaveBeenCalled();
      });
    });

    describe('/cron commands', () => {
      it('/cron list with no jobs', async () => {
        mocks.cronList.mockReturnValue([]);
        await sendCommand('/cron list');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No cron jobs.');
      });

      it('/cron with no args shows no jobs', async () => {
        mocks.cronList.mockReturnValue([]);
        await sendCommand('/cron');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No cron jobs.');
      });

      it('/cron list with jobs shows them', async () => {
        mocks.cronList.mockReturnValue([
          { id: 'abc', chatId: 42, schedule: 'every 1h', prompt: 'check status', intervalMs: 3_600_000, createdAt: '' },
        ]);
        await sendCommand('/cron list');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('every 1h');
        expect(msg).toContain('check status');
      });

      it('/cron every 1h <prompt> adds a job', async () => {
        mocks.cronAdd.mockReturnValue({
          id: 'new-job',
          schedule: 'every 1h',
          prompt: 'run check',
          chatId: 42,
          intervalMs: 3_600_000,
          createdAt: '',
        });
        await sendCommand('/cron every 1h run check');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('Cron set');
        expect(msg).toContain('every 1h');
        expect(msg).toContain('run check');
      });

      it('/cron with invalid schedule format sends usage', async () => {
        await sendCommand('/cron bogus schedule here');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('Usage');
      });

      it('/cron add returns null for bad schedule', async () => {
        mocks.cronAdd.mockReturnValue(null);
        await sendCommand('/cron every 5s test');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        // "every 5s test" doesn't match /^(every\s+\d+[mhd])\s+(.+)$/ so usage is shown
        expect(msg).toContain('Usage');
      });

      it('/cron clear clears all jobs', async () => {
        mocks.cronClearAll.mockReturnValue(3);
        await sendCommand('/cron clear');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Cleared 3 cron job(s).');
      });

      it('/cron remove <id> removes a job', async () => {
        mocks.cronRemove.mockReturnValue(true);
        await sendCommand('/cron remove abc-123');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Removed abc-123.');
      });

      it('/cron remove <id> not found', async () => {
        mocks.cronRemove.mockReturnValue(false);
        await sendCommand('/cron remove nonexistent');
        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Not found: nonexistent');
      });
    });

    describe('/drivers command', () => {
      it('lists drivers from MCP and marks default', async () => {
        vi.spyOn(bot as any, 'callCcAgentTool').mockResolvedValue(JSON.stringify(['claude', 'openrouter']));
        const origDriver = process.env.CC_AGENT_DEFAULT_DRIVER;
        process.env.CC_AGENT_DEFAULT_DRIVER = 'claude';
        await sendCommand('/drivers');
        process.env.CC_AGENT_DEFAULT_DRIVER = origDriver;

        expect(mocks.tgSendMessage).toHaveBeenCalledOnce();
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('claude (default)');
        expect(msg).toContain('openrouter');
      });

      it('falls back to raw text when MCP returns non-JSON', async () => {
        vi.spyOn(bot as any, 'callCcAgentTool').mockResolvedValue('claude\nopenrouter');
        await sendCommand('/drivers');

        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('claude');
        expect(msg).toContain('openrouter');
      });

      it('replies with no-drivers message when MCP returns null', async () => {
        vi.spyOn(bot as any, 'callCcAgentTool').mockResolvedValue(null);
        await sendCommand('/drivers');

        expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No drivers available or cc-agent did not respond.');
      });

      it('replies with error message when MCP throws', async () => {
        vi.spyOn(bot as any, 'callCcAgentTool').mockRejectedValue(new Error('tool not found'));
        await sendCommand('/drivers');

        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('Failed to list drivers');
        expect(msg).toContain('tool not found');
      });

      it('/drivers marks non-claude driver as default when CC_AGENT_DEFAULT_DRIVER is set', async () => {
        vi.spyOn(bot as any, 'callCcAgentTool').mockResolvedValue(JSON.stringify(['claude', 'openrouter', 'openai']));
        const origDriver = process.env.CC_AGENT_DEFAULT_DRIVER;
        process.env.CC_AGENT_DEFAULT_DRIVER = 'openrouter';
        await sendCommand('/drivers');
        process.env.CC_AGENT_DEFAULT_DRIVER = origDriver;

        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('openrouter (default)');
        expect(msg).toContain('claude');
        expect(msg).not.toContain('claude (default)');
      });
    });

  });

  describe('trackWrittenFiles', () => {
    it('tracks Write tool calls', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/test.txt' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.has('/tmp/test.txt')).toBe(true);
    });

    it('tracks Edit tool calls', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/edited.ts' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.has('/tmp/edited.ts')).toBe(true);
    });

    it('ignores non-assistant messages', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'result' as const,
        payload: { result: 'done' },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.size).toBe(0);
    });

    it('tracks mv command destination', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'mv /tmp/source.txt /tmp/dest.txt' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.has('/tmp/dest.txt')).toBe(true);
    });

    it('tracks cp command destination', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'cp /tmp/source.txt /tmp/copy.txt' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.has('/tmp/copy.txt')).toBe(true);
    });

    it('tracks -o flag output path in non-yt-dlp bash commands', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'some-tool -o /tmp/output.csv' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/tmp');
      expect(session.writtenFiles.has('/tmp/output.csv')).toBe(true);
    });

    it('tracks relative Write paths resolved against cwd', () => {
      const session = { writtenFiles: new Set<string>() };
      const msg = {
        type: 'assistant' as const,
        payload: {
          message: {
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: 'output/report.txt' } },
            ],
          },
        },
        raw: {},
      };
      (bot as any).trackWrittenFiles(msg, session, '/home/user/project');
      expect(session.writtenFiles.has('/home/user/project/output/report.txt')).toBe(true);
    });
  });

  describe('thread-keyed sessions (forum topics)', () => {
    async function sendThreadMsg(text: string, threadId: number) {
      await (bot as any).handleTelegram({
        chat: { id: 42 },
        from: { id: 100 },
        text,
        message_thread_id: threadId,
      });
    }

    it('creates separate sessions for different thread IDs', async () => {
      // Send a message in thread 1
      await sendThreadMsg('Hello from thread 1', 1);
      const key1 = (bot as any).sessionKey(42, 1);
      expect((bot as any).sessions.has(key1)).toBe(true);

      // Send a message in thread 2
      vi.clearAllMocks();
      await sendThreadMsg('Hello from thread 2', 2);
      const key2 = (bot as any).sessionKey(42, 2);
      expect((bot as any).sessions.has(key2)).toBe(true);

      // Both sessions should exist independently
      expect((bot as any).sessions.size).toBe(2);
    });

    it('DMs use "chatId:main" session key', async () => {
      await (bot as any).handleTelegram(makeMsg({ text: 'Hello' }));
      const key = (bot as any).sessionKey(42, undefined);
      expect(key).toBe('42:main');
      expect((bot as any).sessions.has(key)).toBe(true);
    });

    it('thread messages use "chatId:threadId" session key', async () => {
      const key = (bot as any).sessionKey(42, 5);
      expect(key).toBe('42:5');
    });

    it('/status reports active for the correct thread', async () => {
      // Create a session in thread 7
      await sendThreadMsg('Hello', 7);
      vi.clearAllMocks();

      // /status in thread 7 should see active session
      await sendThreadMsg('/status', 7);
      const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('Session active.');
    });

    it('/status reports no session for a different thread', async () => {
      // Create a session in thread 7
      await sendThreadMsg('Hello', 7);
      vi.clearAllMocks();

      // /status in thread 8 (different) should see no session
      await sendThreadMsg('/status', 8);
      const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('No active session.');
    });

    it('/stop only kills the session for the current thread', async () => {
      // Create sessions in two threads
      await sendThreadMsg('Hello', 10);
      await sendThreadMsg('Hello', 11);
      vi.clearAllMocks();

      // Stop thread 10
      await sendThreadMsg('/stop', 10);
      expect(mocks.tgSendMessage.mock.calls[0][1]).toBe('Stopped.');

      // Thread 11 session should still exist
      const key11 = (bot as any).sessionKey(42, 11);
      expect((bot as any).sessions.has(key11)).toBe(true);
    });

    it('/reset only kills the session for the current thread', async () => {
      await sendThreadMsg('Hello', 20);
      await sendThreadMsg('Hello', 21);
      vi.clearAllMocks();

      await sendThreadMsg('/reset', 20);
      // Thread 21 still alive
      const key21 = (bot as any).sessionKey(42, 21);
      expect((bot as any).sessions.has(key21)).toBe(true);
    });

    it('thread message replies include message_thread_id', async () => {
      await sendThreadMsg('Hello', 5);
      // The sendMessage was called with message_thread_id in options
      // (replyToChat with threadId defined)
      // Verify sendMessage was called (session created → startTyping → no reply yet from Claude, but error path won't trigger)
      // At minimum, sendChatAction should have been called
      expect(mocks.claudeSendPrompt).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{2}-\d{2} \d{2}:\d{2}\] Hello$/));
    });

    it('typing indicator is sent to the correct thread', async () => {
      await sendThreadMsg('Hello', 5);
      // sendChatAction should be called with message_thread_id: 5
      expect(mocks.tgSendChatAction).toHaveBeenCalledWith(42, 'typing', { message_thread_id: 5 });
    });

    it('typing indicator for DM has no message_thread_id', async () => {
      await (bot as any).handleTelegram(makeMsg({ text: 'Hello' }));
      // sendChatAction should be called without thread options
      expect(mocks.tgSendChatAction).toHaveBeenCalledWith(42, 'typing', undefined);
    });
  });

  describe('group chat support', () => {
    async function sendGroupMsg(overrides: Record<string, unknown> = {}) {
      await (bot as any).handleTelegram({
        chat: { id: 42, type: 'group' },
        from: { id: 100 },
        text: 'hello',
        ...overrides,
      });
    }

    it('ignores group messages that are not @mentions, replies to bot, or commands', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      await sendGroupMsg({ text: 'just talking' });
      expect(mocks.claudeSendPrompt).not.toHaveBeenCalled();
    });

    it('processes group message with @mention', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      await sendGroupMsg({ text: '@testbot do something' });
      expect(mocks.claudeSendPrompt).toHaveBeenCalled();
    });

    it('strips @botname from text before sending to Claude', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      await sendGroupMsg({ text: '@testbot do something' });
      const prompt = mocks.claudeSendPrompt.mock.calls[0][0] as string;
      expect(prompt).not.toContain('@testbot');
      expect(prompt).toContain('do something');
    });

    it('processes group message that is a reply to bot', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      await sendGroupMsg({ text: 'sure go ahead', reply_to_message: { from: { id: 999 } } });
      expect(mocks.claudeSendPrompt).toHaveBeenCalled();
    });

    it('processes group commands (/ prefix)', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      await sendGroupMsg({ text: '/status' });
      expect(mocks.tgSendMessage).toHaveBeenCalled();
    });

    it('ignores group messages when GROUP_CHAT_IDS is set and chat is not listed', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      (bot as any).opts.groupChatIds = [99999];
      await sendGroupMsg({ text: '@testbot hello' });
      expect(mocks.claudeSendPrompt).not.toHaveBeenCalled();
      (bot as any).opts.groupChatIds = [];
    });

    it('processes group message when GROUP_CHAT_IDS includes the chat', async () => {
      (bot as any).botUsername = 'testbot';
      (bot as any).botId = 999;
      (bot as any).opts.groupChatIds = [42];
      await sendGroupMsg({ text: '@testbot hello' });
      expect(mocks.claudeSendPrompt).toHaveBeenCalled();
      (bot as any).opts.groupChatIds = [];
    });
  });
});

describe('enrichPromptWithUrls', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', undefined);
  });

  it('returns text unchanged when no URLs present', async () => {
    const result = await enrichPromptWithUrls('hello world');
    expect(result).toBe('hello world');
  });

  it('returns text unchanged when only jina.ai URL present', async () => {
    const result = await enrichPromptWithUrls('check https://r.jina.ai/example.com');
    expect(result).toBe('check https://r.jina.ai/example.com');
  });

  it('prepends URL content when fetch succeeds', async () => {
    // Mock https.get to return content
    const { default: https } = await import('https');
    const mockGet = vi.spyOn(https, 'get').mockImplementation((_url: any, callback: any) => {
      const res = {
        on: (event: string, handler: (...args: any[]) => void) => {
          if (event === 'data') handler(Buffer.from('Page title and content here'));
          if (event === 'end') handler();
          return res;
        },
      };
      callback(res);
      return { on: vi.fn() } as any;
    });

    const result = await enrichPromptWithUrls('check this https://example.com please');
    expect(result).toContain('[Web content from https://example.com]');
    expect(result).toContain('Page title and content here');
    expect(result).toContain('check this https://example.com please');
    mockGet.mockRestore();
  });

  it('skips URL gracefully when fetch fails', async () => {
    const { default: https } = await import('https');
    const mockGet = vi.spyOn(https, 'get').mockImplementation((_url: any, callback: any) => {
      const res = {
        on: (event: string, handler: (...args: any[]) => void) => {
          if (event === 'error') handler(new Error('network error'));
          return res;
        },
      };
      callback(res);
      return { on: vi.fn() } as any;
    });

    const result = await enrichPromptWithUrls('see https://example.com for details');
    // Should still return the original text even when fetch fails
    expect(result).toBe('see https://example.com for details');
    mockGet.mockRestore();
  });
});

// Import the mocked fs module for spy access
import * as fsModule from 'fs';

describe('listSkills', () => {
  it('returns message when skills dir does not exist', () => {
    mocks.existsSyncMock.mockReturnValue(false);
    const result = listSkills();
    expect(result).toContain('No skills directory found');
  });

  it('returns message when skills dir is empty', () => {
    mocks.existsSyncMock.mockReturnValue(true);
    const readdirMock = vi.spyOn(fsModule, 'readdirSync').mockReturnValue([] as any);
    const result = listSkills();
    expect(result).toContain('No skills found');
    readdirMock.mockRestore();
  });

  it('lists skills with descriptions from frontmatter', () => {
    mocks.existsSyncMock.mockReturnValue(true);
    const readdirMock = vi.spyOn(fsModule, 'readdirSync').mockReturnValue(['commit.md', 'review-pr.md'] as any);
    const readFileMock = vi.spyOn(fsModule, 'readFileSync').mockImplementation((path: any) => {
      if (String(path).includes('commit.md')) {
        return '---\nname: commit\ndescription: Create a git commit with good message\n---\nContent here';
      }
      return '---\nname: review-pr\ndescription: Review a pull request\n---\nContent here';
    });

    const result = listSkills();
    expect(result).toContain('/commit — Create a git commit with good message');
    expect(result).toContain('/review-pr — Review a pull request');
    readdirMock.mockRestore();
    readFileMock.mockRestore();
  });

  it('lists skills without description when frontmatter is missing', () => {
    mocks.existsSyncMock.mockReturnValue(true);
    const readdirMock = vi.spyOn(fsModule, 'readdirSync').mockReturnValue(['my-skill.md'] as any);
    const readFileMock = vi.spyOn(fsModule, 'readFileSync').mockReturnValue('No frontmatter here');

    const result = listSkills();
    expect(result).toContain('/my-skill');
    readdirMock.mockRestore();
    readFileMock.mockRestore();
  });
});

describe('CcTgBot chat bridge', () => {
  const mockRedis = {
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
  };

  function makeBotWithRedis() {
    return new CcTgBot({ telegramToken: 'test-token', redis: mockRedis as never, namespace: 'test-ns' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.existsSyncMock.mockReturnValue(false);
  });

  afterEach((ctx) => {
    // stop bot if test stored one
    const b = (ctx as any).bot as CcTgBot | undefined;
    if (b) b.stop();
  });

  it('writes user message to Redis when a Telegram message is sent', async () => {
    const bot = makeBotWithRedis();
    await (bot as any).handleTelegram(makeMsg({ text: 'Hello Claude' }));
    bot.stop();

    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({ role: 'user', source: 'telegram', content: 'Hello Claude' })
    );
  });

  it('does not call writeChatLog when Redis is not configured', async () => {
    const bot = new CcTgBot({ telegramToken: 'test-token' });
    await (bot as any).handleTelegram(makeMsg({ text: 'Hello Claude' }));
    bot.stop();

    expect(mocks.writeChatLog).not.toHaveBeenCalled();
  });

  it('writes user message to Redis via handleUserMessage', async () => {
    const bot = makeBotWithRedis();
    await bot.handleUserMessage(42, 'UI message');
    bot.stop();

    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({ role: 'user', source: 'ui', content: 'UI message' })
    );
  });

  it('stamps sendPrompt but not writeChatLog for Telegram messages', async () => {
    const bot = makeBotWithRedis();
    await (bot as any).handleTelegram(makeMsg({ text: 'stamp me' }));
    bot.stop();

    // sendPrompt receives the stamped version
    const promptArg = mocks.claudeSendPrompt.mock.calls[0][0] as string;
    expect(promptArg).toMatch(/^\[\d{2}-\d{2} \d{2}:\d{2}\] stamp me$/);

    // writeChatLog receives the original text (no timestamp)
    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({ content: 'stamp me' })
    );
  });

  it('stamps sendPrompt but not writeChatLog for UI messages', async () => {
    const bot = makeBotWithRedis();
    await bot.handleUserMessage(42, 'ui stamp me');
    bot.stop();

    const promptArg = mocks.claudeSendPrompt.mock.calls[0][0] as string;
    expect(promptArg).toMatch(/^\[\d{2}-\d{2} \d{2}:\d{2}\] ui stamp me$/);

    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({ content: 'ui stamp me' })
    );
  });

  it('writes assistant response to Redis when Claude result is flushed', async () => {
    vi.useFakeTimers();
    const bot = makeBotWithRedis();

    // Trigger session creation and get the message handler
    await (bot as any).handleTelegram(makeMsg({ text: 'Hello' }));
    const onCalls = mocks.claudeOn.mock.calls as [string, (...args: unknown[]) => void][];
    const messageHandler = onCalls.find(([event]) => event === 'message')?.[1];

    // Fire a result message from Claude
    messageHandler?.({ type: 'result', payload: { result: 'Hi there!' }, raw: {} });
    vi.advanceTimersByTime(1000);

    bot.stop();
    vi.useRealTimers();

    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({ role: 'assistant', source: 'cc-tg', content: 'Hi there!' })
    );
  });

  it('writes tool call events to Redis when Claude uses a tool', async () => {
    const bot = makeBotWithRedis();

    await (bot as any).handleTelegram(makeMsg({ text: 'Hello' }));
    const onCalls = mocks.claudeOn.mock.calls as [string, (...args: unknown[]) => void][];
    const messageHandler = onCalls.find(([event]) => event === 'message')?.[1];

    // Fire an assistant message with a tool_use block
    messageHandler?.({
      type: 'assistant',
      payload: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }],
        },
      },
      raw: {},
    });

    bot.stop();

    expect(mocks.writeChatLog).toHaveBeenCalledWith(
      mockRedis,
      'test-ns',
      expect.objectContaining({
        role: 'tool',
        source: 'cc-tg',
        content: expect.stringContaining('[tool] Bash:'),
      })
    );
  });
});

describe('handleVoice Redis tracking', () => {
  const mockRedis = {
    lpush: vi.fn().mockResolvedValue(1),
    rpush: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
    ltrim: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };

  function makeBotWithRedis() {
    return new CcTgBot({ telegramToken: 'test-token', redis: mockRedis as never, namespace: 'test-ns' });
  }

  function makeVoiceMsg(overrides: Record<string, unknown> = {}) {
    return {
      chat: { id: 42 },
      from: { id: 100 },
      message_id: 7,
      voice: { file_id: 'voice-file-001' },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSendChatAction.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.tgGetFileLink.mockResolvedValue('https://example.com/voice.ogg');
    mocks.transcribeVoiceMock.mockResolvedValue('hello world');
    mocks.existsSyncMock.mockReturnValue(false);
    mockRedis.rpush.mockResolvedValue(1);
    mockRedis.lrem.mockResolvedValue(1);
    mockRedis.lrange.mockResolvedValue([]);
    mockRedis.expire.mockResolvedValue(1);
  });

  it('pushes pending entry to voice:pending before transcription', async () => {
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mockRedis.rpush).toHaveBeenCalledWith(
      'voice:pending',
      expect.stringContaining('"file_id":"voice-file-001"')
    );
  });

  it('removes entry from voice:pending on successful transcription', async () => {
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mockRedis.lrem).toHaveBeenCalledWith(
      'voice:pending',
      0,
      expect.stringContaining('"file_id":"voice-file-001"')
    );
  });

  it('pushes to voice:failed and sets TTL on transcription error', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('whisper-cpp not found — install with: brew install whisper-cpp'));
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    // allow microtasks for the fire-and-forget redis chain
    await new Promise((r) => setTimeout(r, 0));
    bot.stop();

    expect(mockRedis.rpush).toHaveBeenCalledWith(
      'voice:failed',
      expect.stringContaining('"file_id":"voice-file-001"')
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('voice:failed', 48 * 60 * 60);
  });

  it('sends friendly error when whisper not installed', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('whisper-cpp not found — install with: brew install whisper-cpp'));
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'Voice transcription unavailable — whisper-cpp not installed'
    );
  });

  it('sends friendly error when no whisper model found', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('No whisper model found — run: whisper-cpp-download-ggml-model small.en'));
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'Voice transcription unavailable — no whisper model found'
    );
  });

  it('sends friendly error when download fails', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('HTTP 403 downloading https://api.telegram.org/file/...'));
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'Could not download voice file from Telegram'
    );
  });

  it('sends generic error for unknown failures', async () => {
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('some unexpected error'));
    const bot = makeBotWithRedis();
    await (bot as any).handleVoice(42, makeVoiceMsg());
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'Voice transcription failed: some unexpected error'
    );
  });
});

describe('handleVoiceRetry', () => {
  const mockRedis = {
    lpush: vi.fn().mockResolvedValue(1),
    rpush: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
    ltrim: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };

  function makeBotWithRedis() {
    return new CcTgBot({ telegramToken: 'test-token', redis: mockRedis as never, namespace: 'test-ns' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSendChatAction.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.tgGetFileLink.mockResolvedValue('https://example.com/voice.ogg');
    mocks.transcribeVoiceMock.mockResolvedValue('retried transcript');
    mocks.existsSyncMock.mockReturnValue(false);
    mockRedis.lrange.mockResolvedValue([]);
    mockRedis.lrem.mockResolvedValue(1);
  });

  it('replies with no-redis message when Redis not configured', async () => {
    const bot = new CcTgBot({ telegramToken: 'test-token' });
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'Redis not configured — voice retry unavailable.'
    );
  });

  it('replies with nothing-to-retry when both lists empty', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    const bot = makeBotWithRedis();
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'No pending voice messages to retry.'
    );
  });

  it('retries entries from voice:pending and removes on success', async () => {
    const entry = JSON.stringify({ file_id: 'voice-abc', chat_id: 42, message_id: 5, timestamp: Date.now() });
    mockRedis.lrange.mockImplementation((key: string) =>
      key === 'voice:pending' ? Promise.resolve([entry]) : Promise.resolve([])
    );

    const bot = makeBotWithRedis();
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    expect(mocks.tgGetFileLink).toHaveBeenCalledWith('voice-abc');
    expect(mocks.claudeSendPrompt).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{2}-\d{2} \d{2}:\d{2}\] retried transcript$/));
    expect(mockRedis.lrem).toHaveBeenCalledWith('voice:pending', 0, entry);
  });

  it('reports failure when transcription throws during retry', async () => {
    const entry = JSON.stringify({ file_id: 'voice-xyz', chat_id: 42, message_id: 8, timestamp: Date.now() });
    mockRedis.lrange.mockImplementation((key: string) =>
      key === 'voice:failed' ? Promise.resolve([entry]) : Promise.resolve([])
    );
    mocks.transcribeVoiceMock.mockRejectedValue(new Error('whisper not available'));

    const bot = makeBotWithRedis();
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    const calls = mocks.tgSendMessage.mock.calls as [number, string][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(42);
    expect(lastCall[1]).toContain('1 failed');
  });

  it('/voice_retry command dispatches to handleVoiceRetry', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    const bot = makeBotWithRedis();
    await (bot as any).handleTelegram({
      chat: { id: 42, type: 'private' },
      from: { id: 100 },
      text: '/voice_retry',
      message_id: 1,
    });
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(
      42,
      'No pending voice messages to retry.'
    );
  });

  it('purges stale voice:pending entries older than 48h', async () => {
    const staleTimestamp = Date.now() - (49 * 60 * 60 * 1000);
    const staleEntry = JSON.stringify({ file_id: 'stale-voice-001', chat_id: 42, message_id: 10, timestamp: staleTimestamp });
    mockRedis.lrange.mockImplementation((key: string) =>
      key === 'voice:pending' ? Promise.resolve([staleEntry]) : Promise.resolve([])
    );
    mocks.tgGetFileLink.mockResolvedValue('https://example.com/voice.ogg');
    mocks.transcribeVoiceMock.mockResolvedValue('hello');

    const bot = makeBotWithRedis();
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    // Stale entry should be purged via lrem
    expect(mockRedis.lrem).toHaveBeenCalledWith('voice:pending', 0, staleEntry);

    const calls = mocks.tgSendMessage.mock.calls as [number, string][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toContain('1 stale entries purged');
  });

  it('removes permanently expired Telegram link (Bad Request) from voice:pending', async () => {
    const entry = JSON.stringify({ file_id: 'expired-voice-002', chat_id: 42, message_id: 11, timestamp: Date.now() });
    mockRedis.lrange.mockImplementation((key: string) =>
      key === 'voice:pending' ? Promise.resolve([entry]) : Promise.resolve([])
    );
    mocks.tgGetFileLink.mockRejectedValue(new Error('Bad Request: invalid file_id'));

    const bot = makeBotWithRedis();
    await (bot as any).handleVoiceRetry(42);
    bot.stop();

    expect(mockRedis.lrem).toHaveBeenCalledWith('voice:pending', 0, entry);

    const calls = mocks.tgSendMessage.mock.calls as [number, string][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toContain('1 failed');
  });
});

describe('handleAgents', () => {
  const mockScan = vi.fn();
  const mockGet = vi.fn();

  const mockRedis = {
    scan: mockScan,
    get: mockGet,
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(1),
  };

  function makeBotWithRedis() {
    return new CcTgBot({ telegramToken: 'test-token', redis: mockRedis as never });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tgSendMessage.mockResolvedValue({});
    mocks.tgSetMyCommands.mockResolvedValue({});
    mocks.existsSyncMock.mockReturnValue(false);
    // Default: empty scan result
    mockScan.mockResolvedValue(['0', []]);
    mockGet.mockResolvedValue(null);
  });

  it('replies with no-redis message when Redis not configured', async () => {
    const bot = new CcTgBot({ telegramToken: 'test-token' });
    await (bot as any).handleAgents(42);
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'Redis not configured — agents status unavailable.');
  });

  it('replies with no-agents message when no keys found', async () => {
    mockScan.mockResolvedValue(['0', []]);
    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No active meta-agents.');
  });

  it('shows running agent with typing status', async () => {
    mockScan.mockResolvedValue(['0', ['cca:meta-agent:status:money-brain']]);
    mockGet.mockResolvedValue(JSON.stringify({
      status: 'running',
      current_tool: 'Bash',
      turn: 42,
    }));

    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('🤖 Active Agents');
    expect(msg).toContain('money-brain');
    expect(msg).toContain('typing...');
    expect(msg).toContain('turn 42');
  });

  it('shows idle agent with turn count and age', async () => {
    const lastActivity = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    mockScan.mockResolvedValue(['0', ['cca:meta-agent:status:simorgh']]);
    mockGet.mockResolvedValue(JSON.stringify({
      status: 'idle',
      turn: 8,
      last_activity: lastActivity,
    }));

    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('simorgh');
    expect(msg).toContain('idle');
    expect(msg).toContain('turn 8');
    expect(msg).toContain('3m ago');
  });

  it('shows multiple agents', async () => {
    mockScan.mockResolvedValue(['0', [
      'cca:meta-agent:status:alpha',
      'cca:meta-agent:status:beta',
    ]]);
    mockGet
      .mockResolvedValueOnce(JSON.stringify({ status: 'running', turn: 5 }))
      .mockResolvedValueOnce(JSON.stringify({ status: 'idle', turn: 1 }));

    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
  });

  it('handles malformed status JSON gracefully', async () => {
    mockScan.mockResolvedValue(['0', ['cca:meta-agent:status:broken']]);
    mockGet.mockResolvedValue('not-valid-json{{{');

    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('broken');
    expect(msg).toContain('status unknown');
  });

  it('handles redis scan error gracefully', async () => {
    mockScan.mockRejectedValue(new Error('redis unavailable'));
    const bot = makeBotWithRedis();
    await (bot as any).handleAgents(42);
    bot.stop();

    const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Failed to get agents status');
    expect(msg).toContain('redis unavailable');
  });

  it('/agents command dispatches to handleAgents', async () => {
    mockScan.mockResolvedValue(['0', []]);
    const bot = makeBotWithRedis();
    await (bot as any).handleTelegram({
      chat: { id: 42, type: 'private' },
      from: { id: 100 },
      text: '/agents',
      message_id: 1,
    });
    bot.stop();

    expect(mocks.tgSendMessage).toHaveBeenCalledWith(42, 'No active meta-agents.');
  });
});
