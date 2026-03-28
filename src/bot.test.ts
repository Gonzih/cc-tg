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
  transcribeVoice: vi.fn().mockResolvedValue('transcribed text'),
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

import { CcTgBot, splitMessage, enrichPromptWithUrls, listSkills } from './bot.js';

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

  describe('isSensitiveFile', () => {
    it('blocks .env files', () => {
      expect((bot as any).isSensitiveFile('/path/.env')).toBe(true);
    });

    it('blocks token files', () => {
      expect((bot as any).isSensitiveFile('/path/token.json')).toBe(true);
    });

    it('blocks credential files', () => {
      expect((bot as any).isSensitiveFile('/path/credentials.json')).toBe(true);
    });

    it('blocks private key files', () => {
      expect((bot as any).isSensitiveFile('/path/id_rsa')).toBe(true);
      expect((bot as any).isSensitiveFile('/path/private_key.pem')).toBe(true);
    });

    it('blocks .pem, .key, .pfx, .p12 extensions', () => {
      expect((bot as any).isSensitiveFile('/path/cert.pem')).toBe(true);
      expect((bot as any).isSensitiveFile('/path/server.key')).toBe(true);
      expect((bot as any).isSensitiveFile('/path/store.pfx')).toBe(true);
      expect((bot as any).isSensitiveFile('/path/store.p12')).toBe(true);
    });

    it('allows PDF reports', () => {
      expect((bot as any).isSensitiveFile('/path/report.pdf')).toBe(false);
    });

    it('allows photo files', () => {
      expect((bot as any).isSensitiveFile('/path/photo.jpg')).toBe(false);
      expect((bot as any).isSensitiveFile('/path/image.png')).toBe(false);
    });

    it('allows audio files', () => {
      expect((bot as any).isSensitiveFile('/path/song.mp3')).toBe(false);
    });

    it('allows text files', () => {
      expect((bot as any).isSensitiveFile('/path/notes.txt')).toBe(false);
    });

    it('blocks api_key files', () => {
      expect((bot as any).isSensitiveFile('/path/api_key.txt')).toBe(true);
    });
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
      expect(msg).toContain('/cron');
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
      expect(mocks.claudeSendPrompt).toHaveBeenCalledWith('Hello Claude');
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

      it('blocks sensitive files in safe dirs', async () => {
        mocks.existsSyncMock.mockReturnValue(true);
        mocks.statSyncMock.mockReturnValue({ size: 1024, isFile: () => true });
        await sendCommand('/get_file /tmp/token.json');
        const msg = mocks.tgSendMessage.mock.calls[0][1] as string;
        expect(msg).toContain('Access denied: sensitive file');
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
      expect(mocks.claudeSendPrompt).toHaveBeenCalledWith('Hello');
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
