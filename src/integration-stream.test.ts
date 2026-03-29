/**
 * Integration tests: ClaudeProcess stream-parsing pipeline + formatter composition.
 *
 * spawn is mocked; all parsing/event logic is real (drainBuffer, parseMessage,
 * event emission, sendPrompt, sendImage). Also tests formatForTelegram composed
 * with splitLongMessage to exercise the full Telegram message-formatting pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── mock setup ────────────────────────────────────────────────────────────────

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, execFileSync: vi.fn() };
});

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { ClaudeProcess } from './claude.js';
import { formatForTelegram, splitLongMessage } from './formatter.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a controllable fake child process. */
function makeFakeProc() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { write: vi.fn() },
    kill: vi.fn(),
  });
  return proc as typeof proc & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ClaudeProcess stream-parsing pipeline
// ═════════════════════════════════════════════════════════════════════════════

describe('ClaudeProcess stream-parsing pipeline', () => {
  let fakeProc: ReturnType<typeof makeFakeProc>;
  let claude: ClaudeProcess;

  beforeEach(() => {
    fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    claude = new ClaudeProcess();
  });

  /** Push raw data into the fake stdout. */
  function push(data: string) {
    fakeProc.stdout.emit('data', Buffer.from(data));
  }

  // ── message events ──────────────────────────────────────────────────────

  it('emits a message event for a complete JSON line', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    push(JSON.stringify({ type: 'result', result: 'done', session_id: 'sess-1' }) + '\n');

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).type).toBe('result');
    expect((messages[0] as any).session_id).toBe('sess-1');
  });

  it('emits multiple message events from a single data chunk', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    const line1 = JSON.stringify({ type: 'system', content: 'init' });
    const line2 = JSON.stringify({ type: 'assistant', message: { content: 'Hello' } });
    push(line1 + '\n' + line2 + '\n');

    expect(messages).toHaveLength(2);
    expect((messages[0] as any).type).toBe('system');
    expect((messages[1] as any).type).toBe('assistant');
  });

  it('buffers an incomplete line and emits when the rest arrives', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    const payload = JSON.stringify({ type: 'result', result: 'hello world' });
    const mid = Math.floor(payload.length / 2);

    push(payload.slice(0, mid));    // partial — no newline
    expect(messages).toHaveLength(0);

    push(payload.slice(mid) + '\n'); // completion + newline
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).type).toBe('result');
  });

  it('silently ignores non-JSON lines (startup noise)', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    push('Claude Code v1.0.0\n');
    push('(c) Anthropic, Inc.\n');

    expect(messages).toHaveLength(0);
  });

  it('silently ignores blank lines', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    push('\n\n  \n');
    expect(messages).toHaveLength(0);
  });

  it('handles JSON interleaved with noise lines', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    push('startup noise\n');
    push(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
    push('more noise\n');

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).type).toBe('result');
  });

  it('includes the raw payload in emitted messages', () => {
    const messages: unknown[] = [];
    claude.on('message', (m) => messages.push(m));

    const raw = { type: 'result', result: 'data', session_id: 'abc', uuid: 'xyz' };
    push(JSON.stringify(raw) + '\n');

    const msg = messages[0] as any;
    expect(msg.raw).toMatchObject(raw);
    expect(msg.session_id).toBe('abc');
    expect(msg.uuid).toBe('xyz');
  });

  // ── usage events ────────────────────────────────────────────────────────

  it('emits a usage event for message_start with token counts', () => {
    const usages: unknown[] = [];
    claude.on('usage', (u) => usages.push(u));

    push(JSON.stringify({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 40,
        },
      },
    }) + '\n');

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      inputTokens: 200,
      outputTokens: 0,
      cacheReadTokens: 80,
      cacheWriteTokens: 40,
    });
  });

  it('emits a usage event for message_delta with output_tokens', () => {
    const usages: unknown[] = [];
    claude.on('usage', (u) => usages.push(u));

    push(JSON.stringify({ type: 'message_delta', usage: { output_tokens: 150 } }) + '\n');

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      outputTokens: 150,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('does not emit usage for message_delta without output_tokens', () => {
    const usages: unknown[] = [];
    claude.on('usage', (u) => usages.push(u));

    push(JSON.stringify({ type: 'message_delta', stop_reason: 'end_turn' }) + '\n');
    expect(usages).toHaveLength(0);
  });

  it('does not emit usage for message_start without usage block', () => {
    const usages: unknown[] = [];
    claude.on('usage', (u) => usages.push(u));

    push(JSON.stringify({ type: 'message_start', model: 'claude-sonnet-4-6' }) + '\n');
    expect(usages).toHaveLength(0);
  });

  // ── lifecycle events ─────────────────────────────────────────────────────

  it('propagates the exit event and marks the process as exited', () => {
    let code: number | null = -99;
    claude.on('exit', (c) => { code = c; });

    fakeProc.emit('exit', 0);

    expect(code).toBe(0);
    expect(claude.exited).toBe(true);
  });

  it('propagates exit with non-zero code', () => {
    let code: number | null = null;
    claude.on('exit', (c) => { code = c; });

    fakeProc.emit('exit', 1);
    expect(code).toBe(1);
  });

  it('propagates stderr data as a string event', () => {
    const lines: string[] = [];
    claude.on('stderr', (d) => lines.push(d));

    fakeProc.stderr.emit('data', Buffer.from('warning: some stderr output'));
    expect(lines).toEqual(['warning: some stderr output']);
  });

  it('propagates process-level error event', () => {
    const errors: Error[] = [];
    claude.on('error', (e) => errors.push(e));

    fakeProc.emit('error', new Error('ENOENT: not found'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ENOENT');
  });

  // ── sendPrompt / sendImage ───────────────────────────────────────────────

  it('throws when sendPrompt is called after process exit', () => {
    fakeProc.emit('exit', 1);
    expect(() => claude.sendPrompt('hello')).toThrow('Claude process has exited');
  });

  it('throws when sendImage is called after process exit', () => {
    fakeProc.emit('exit', 1);
    expect(() => claude.sendImage('data', 'image/jpeg')).toThrow('Claude process has exited');
  });

  it('writes correctly-shaped JSON to stdin on sendPrompt', () => {
    claude.sendPrompt('what is 2 + 2?');

    expect(fakeProc.stdin.write).toHaveBeenCalledOnce();
    const written: string = (fakeProc.stdin.write as any).mock.calls[0][0];
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'what is 2 + 2?' },
    });
  });

  it('writes image content block with text caption to stdin on sendImage', () => {
    claude.sendImage('base64data==', 'image/jpeg', 'describe this');

    const written: string = (fakeProc.stdin.write as any).mock.calls[0][0];
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.content).toContainEqual({ type: 'text', text: 'describe this' });
    expect(parsed.message.content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'base64data==' },
    });
  });

  it('sendImage without caption omits the text block', () => {
    claude.sendImage('imgdata', 'image/png');

    const written: string = (fakeProc.stdin.write as any).mock.calls[0][0];
    const parsed = JSON.parse(written.trim());
    const textBlocks = parsed.message.content.filter((b: any) => b.type === 'text');
    expect(textBlocks).toHaveLength(0);
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0].type).toBe('image');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. formatForTelegram + splitLongMessage composition
// ═════════════════════════════════════════════════════════════════════════════

describe('formatForTelegram + splitLongMessage composition', () => {
  it('formats and returns a single chunk for short markdown', () => {
    const input = '## Hello\n\n**World**';
    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('<b>Hello</b>');
    expect(chunks[0]).toContain('<b>World</b>');
  });

  it('splits a long formatted response at paragraph boundaries', () => {
    // Build a response with many sections that will exceed 4096 chars after formatting
    const sections = Array.from({ length: 20 }, (_, i) =>
      `## Section ${i + 1}\n\nThis is the body text for section ${i + 1}. `.repeat(8)
    );
    const input = sections.join('\n\n');

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // All chunks joined equal the formatted text (minus trimming at split points)
    const reassembled = chunks.join('');
    expect(reassembled.length).toBeLessThanOrEqual(formatted.length);
  });

  it('preserves code blocks intact (not split mid-block)', () => {
    // One large code block in the middle of long text
    const codeContent = 'x = 1\n'.repeat(200); // ~1200 chars inside the block
    const prefix = 'Introduction text\n\n'.repeat(40); // ~760 chars
    const suffix = '\n\nSuffix text\n\n'.repeat(40);
    const input = `${prefix}\`\`\`python\n${codeContent}\`\`\`${suffix}`;

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    // Verify <pre> tag is always opened and closed in the same chunk
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) ?? []).length;
      const closes = (chunk.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('HTML-escapes special characters before splitting', () => {
    const input = 'a < b & c > d\n\n'.repeat(300);

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[<>&](?!amp;|lt;|gt;|\/?\w+>|pre>|code>|b>|i>)/);
    }
    // At least one chunk should contain HTML entities
    expect(chunks.join('')).toContain('&lt;');
    expect(chunks.join('')).toContain('&gt;');
    expect(chunks.join('')).toContain('&amp;');
  });

  it('bullet lists survive formatting and splitting', () => {
    const items = Array.from({ length: 200 }, (_, i) => `- Item ${i + 1}: description text here`);
    const input = items.join('\n');

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Verify bullets are converted
    expect(chunks.join('')).toContain('•');
    expect(chunks.join('')).not.toMatch(/^- /m);
  });

  it('full content is preserved across all chunks (no data loss)', () => {
    const input = Array.from({ length: 100 }, (_, i) =>
      `**Item ${i}**: Some description for item number ${i}.`
    ).join('\n');

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);

    const reassembled = chunks.join(' ').replace(/\s+/g, ' ');
    // All items should appear somewhere across the chunks
    for (let i = 0; i < 100; i++) {
      expect(reassembled).toContain(`Item ${i}`);
    }
  });
});
