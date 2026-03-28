/**
 * Integration tests — exercise real I/O and multi-module interactions
 * without mocking the filesystem, token management, or formatter internals.
 *
 * Additional coverage:
 *  - ClaudeProcess stream parsing: single/multi-chunk JSON, partial lines, usage events
 *  - detectUsageLimit + token rotation end-to-end flow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeProcess, extractText, type ClaudeMessage, type UsageEvent } from './claude.js';
import { detectUsageLimit } from './usage-limit.js';

// ─── ClaudeProcess: real subprocess stream parsing ───────────────────────────
//
// Spawns a tiny Node.js script that emits fake Claude-CLI-style JSON lines.
// Exercises drainBuffer(), parseMessage(), usage event emission, and the
// full event pipeline end-to-end without the actual `claude` binary.

describe('ClaudeProcess integration (fake claude binary)', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-tg-claude-test-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a fake `claude` Node script to tmpDir that outputs messages then exits. */
  function createFakeClaude(messages: object[], exitCode = 0): void {
    const lines = messages.map((m) => JSON.stringify(m));
    writeFileSync(
      join(tmpDir, 'claude'),
      `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
for (const line of lines) process.stdout.write(line + '\\n');
process.exit(${exitCode});
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}:${originalPath}`;
  }

  /** Write a fake `claude` that reads one prompt from stdin and echoes it back. */
  function createEchoClaude(): void {
    writeFileSync(
      join(tmpDir, 'claude'),
      `#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const line = Buffer.concat(chunks).toString().split('\\n').find(l => l.trim());
  const msg = line ? JSON.parse(line) : {};
  const content = msg?.message?.content ?? 'empty';
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    session_id: 'echo-sess',
    message: { role: 'assistant', content: 'Echo: ' + content },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    session_id: 'echo-sess',
    result: 'Echo: ' + content,
  }) + '\\n');
  process.exit(0);
});
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}:${originalPath}`;
  }

  it('emits message events for each JSON line on stdout', async () => {
    createFakeClaude([
      { type: 'system', session_id: 'sess-1' },
      { type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: 'Hi' } },
      { type: 'result', session_id: 'sess-1', result: 'Hi' },
    ]);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const received: ClaudeMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      proc.on('message', (msg) => received.push(msg));
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe('system');
    expect(received[1].type).toBe('assistant');
    expect(received[2].type).toBe('result');
    expect(received[0].session_id).toBe('sess-1');
  });

  it('emits usage events from message_start and message_delta lines', async () => {
    createFakeClaude([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 42, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } },
      },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'result', result: 'done' },
    ]);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const usageEvents: UsageEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      proc.on('usage', (u) => usageEvents.push(u));
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({ inputTokens: 42, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 0 });
    expect(usageEvents[1]).toMatchObject({ outputTokens: 7, inputTokens: 0 });
  });

  it('ignores non-JSON startup noise on stdout without throwing', async () => {
    writeFileSync(
      join(tmpDir, 'claude'),
      `#!/usr/bin/env node
process.stdout.write('startup noise\\n');
process.stdout.write('  \\n');
process.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\\n');
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}:${originalPath}`;

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const received: ClaudeMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      proc.on('message', (msg) => received.push(msg));
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('result');
  });

  it('marks exited=true and emits the exit code after the process exits', async () => {
    createFakeClaude([], 42);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    expect(proc.exited).toBe(false);

    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('exit', (c) => resolve(c));
    });

    expect(proc.exited).toBe(true);
    expect(code).toBe(42);
  });

  it('handles large burst output — drainBuffer assembles all lines', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      type: 'assistant',
      session_id: 'sess-burst',
      message: { role: 'assistant', content: `msg-${i}` },
    }));
    createFakeClaude(messages);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const received: ClaudeMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      proc.on('message', (msg) => received.push(msg));
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(received).toHaveLength(50);
  });

  it('throws when sendPrompt is called after the process has exited', async () => {
    createFakeClaude([{ type: 'result', result: 'done' }]);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    await new Promise<void>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(() => proc.sendPrompt('hello')).toThrow('Claude process has exited');
  });

  it('round-trip: sendPrompt payload reaches stdin and response is emitted', async () => {
    createEchoClaude();

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const received: ClaudeMessage[] = [];

    const done = new Promise<void>((resolve, reject) => {
      proc.on('message', (msg) => received.push(msg));
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    proc.sendPrompt('hello world');
    // Close stdin so the fake script's 'end' event fires
    (proc as unknown as { proc: { stdin: NodeJS.WritableStream } }).proc.stdin.end();

    await done;

    const resultMsg = received.find((m) => m.type === 'result');
    expect(resultMsg).toBeDefined();
    expect((resultMsg!.payload as { result?: string }).result).toContain('hello world');
  });

  it('extractText + ClaudeProcess message event — full parsing pipeline', async () => {
    createFakeClaude([
      {
        type: 'assistant',
        session_id: 'sess-pipe',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The answer is ' },
            { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
            { type: 'text', text: '42.' },
          ],
        },
      },
      { type: 'result', session_id: 'sess-pipe', result: 'The answer is 42.' },
    ]);

    const proc = new ClaudeProcess({ cwd: tmpDir });
    const texts: string[] = [];

    await new Promise<void>((resolve, reject) => {
      proc.on('message', (msg) => {
        const t = extractText(msg);
        if (t) texts.push(t);
      });
      proc.on('error', reject);
      proc.on('exit', () => resolve());
    });

    expect(texts).toContain('The answer is 42.');
  });
});

// ─── CronManager: real filesystem persist / reload ─────────────────────────

import { CronManager, type CronJob } from './cron.js';

describe('CronManager — real filesystem integration', () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'cc-tg-cron-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a job to disk and a new instance reloads it', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    const job = mgr.add(42, 'every 1h', 'run diagnostics')!;
    expect(job).not.toBeNull();

    // The .cc-tg/crons.json file must exist now
    const storePath = join(dir, '.cc-tg', 'crons.json');
    expect(existsSync(storePath)).toBe(true);

    // A freshly-created instance with the same directory should reload the job
    const mgr2 = new CronManager(dir, fire);
    const reloaded = mgr2.list(42);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(job.id);
    expect(reloaded[0].prompt).toBe('run diagnostics');
    expect(reloaded[0].schedule).toBe('every 1h');
    expect(reloaded[0].intervalMs).toBe(3_600_000);
    expect(reloaded[0].chatId).toBe(42);

    // Clean up timers from both managers
    mgr.clearAll(42);
    mgr2.clearAll(42);
  });

  it('persists multiple jobs across chats and reloads all of them', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    mgr.add(42, 'every 30m', 'check logs');
    mgr.add(42, 'every 2h', 'weekly report');
    mgr.add(99, 'every 1d', 'backup');

    const mgr2 = new CronManager(dir, fire);
    expect(mgr2.list(42)).toHaveLength(2);
    expect(mgr2.list(99)).toHaveLength(1);
    expect(mgr2.list(99)[0].prompt).toBe('backup');

    mgr.clearAll(42);
    mgr.clearAll(99);
    mgr2.clearAll(42);
    mgr2.clearAll(99);
  });

  it('removal is reflected on disk — a new instance sees the updated list', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    const a = mgr.add(42, 'every 1h', 'job A')!;
    const b = mgr.add(42, 'every 2h', 'job B')!;

    mgr.remove(42, a.id);

    const mgr2 = new CronManager(dir, fire);
    const jobs = mgr2.list(42);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(b.id);

    mgr.clearAll(42);
    mgr2.clearAll(42);
  });

  it('clearAll removes all entries from disk', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    mgr.add(42, 'every 1h', 'A');
    mgr.add(42, 'every 2h', 'B');
    mgr.clearAll(42);

    const storePath = join(dir, '.cc-tg', 'crons.json');
    const data: CronJob[] = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(data).toHaveLength(0);
  });

  it('update is persisted and visible to a new instance', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    const job = mgr.add(42, 'every 1h', 'original prompt')!;
    mgr.update(42, job.id, { prompt: 'updated prompt', schedule: 'every 2h' });

    const mgr2 = new CronManager(dir, fire);
    const reloaded = mgr2.list(42)[0];
    expect(reloaded.prompt).toBe('updated prompt');
    expect(reloaded.schedule).toBe('every 2h');
    expect(reloaded.intervalMs).toBe(2 * 3_600_000);

    mgr.clearAll(42);
    mgr2.clearAll(42);
  });

  it('clearAll with no jobs is a no-op that leaves an empty store on reload', () => {
    const fire = vi.fn();
    const mgr = new CronManager(dir, fire);
    expect(mgr.clearAll(42)).toBe(0); // no jobs, no error

    // Add and clear to ensure persist() has been called at least once
    mgr.add(42, 'every 1h', 'A');
    mgr.clearAll(42);

    const mgr2 = new CronManager(dir, fire);
    expect(mgr2.list(42)).toHaveLength(0);
  });

  it('reloaded jobs fire their callbacks when the timer elapses', () => {
    const fire = vi.fn().mockImplementation((_chatId, _prompt, _jobId, done) => done());

    // Populate disk with a job using a first instance, then let it go out of scope
    // without clearing (clearAll would erase the persisted data)
    const mgr = new CronManager(dir, fire);
    const job = mgr.add(42, 'every 1m', 'ping')!;

    // Second instance loads from disk — it must also schedule the timer
    const mgr2 = new CronManager(dir, fire);
    expect(mgr2.list(42)[0].id).toBe(job.id);

    // Advance time: both mgr and mgr2 have timers, so fire is called at least twice.
    // The important thing is that mgr2's reloaded timer fires correctly.
    vi.advanceTimersByTime(60_000);
    expect(fire).toHaveBeenCalledWith(42, 'ping', expect.any(String), expect.any(Function));
    expect(fire.mock.calls.length).toBeGreaterThanOrEqual(1);

    mgr.clearAll(42);
    mgr2.clearAll(42);
  });
});

// ─── Formatter + splitLongMessage pipeline ────────────────────────────────

import { formatForTelegram, splitLongMessage } from './formatter.js';

describe('formatForTelegram → splitLongMessage pipeline', () => {
  it('short Claude reply passes through as-is', () => {
    const input = '## Result\n\nThe answer is **42**.';
    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('<b>Result</b>');
    expect(chunks[0]).toContain('<b>42</b>');
  });

  it('long reply with fenced code block is split without breaking the <pre> tag', () => {
    // Build a long response: preamble + big code block + postamble
    const codeLine = 'const x = 1; // some code\n';
    const codeBlock = '```typescript\n' + codeLine.repeat(100) + '```';
    const preamble = 'Here is the implementation:\n\n';
    const postamble = '\n\nLet me know if you have questions.';
    const input = preamble + codeBlock + postamble;

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted, 4096);

    // All chunks must be within size
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }

    // Reassembled output must preserve full content
    const reassembled = chunks.join('\n');
    expect(reassembled).toContain('<pre>');
    expect(reassembled).toContain('</pre>');
    expect(reassembled).toContain('const x = 1;');
  });

  it('bullet list is formatted then split correctly', () => {
    const items = Array.from({ length: 200 }, (_, i) => `- Item ${i + 1}: some description text here`);
    const input = '## Items\n\n' + items.join('\n');

    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }

    // All bullet items must survive across chunks
    const full = chunks.join('\n');
    expect(full).toContain('• Item 1:');
    expect(full).toContain('• Item 200:');
  });

  it('HTML special chars in code blocks are escaped, not double-escaped', () => {
    const input = '```\nif (a < b && c > d) { return &something; }\n```';
    const formatted = formatForTelegram(input);
    const chunks = splitLongMessage(formatted);
    expect(chunks).toHaveLength(1);
    // Special chars inside <pre> must be escaped exactly once
    expect(chunks[0]).toContain('&lt;');
    expect(chunks[0]).toContain('&gt;');
    expect(chunks[0]).toContain('&amp;');
    // Must not be double-escaped
    expect(chunks[0]).not.toContain('&amp;lt;');
    expect(chunks[0]).not.toContain('&amp;amp;');
  });

  it('realistic Claude response formats and splits correctly', () => {
    const response = `## Summary

I found **3 issues** in your code:

- Missing \`null\` check in \`processUser()\`
- Off-by-one error in the loop
- Unhandled promise rejection

Here is the fixed version:

\`\`\`typescript
async function processUser(id: string | null): Promise<void> {
  if (!id) throw new Error('id is required');
  const user = await db.find(id);
  for (let i = 0; i < user.items.length; i++) {
    await handleItem(user.items[i]);
  }
}
\`\`\`

The _key change_ is the null guard at the top. Let me know if you'd like me to add tests.`;

    const formatted = formatForTelegram(response);
    const chunks = splitLongMessage(formatted);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const full = chunks.join('\n');
    expect(full).toContain('<b>Summary</b>');
    expect(full).toContain('<b>3 issues</b>');
    expect(full).toContain('• Missing');
    expect(full).toContain('<code>null</code>');
    expect(full).toContain('<pre>');
    expect(full).toContain('<i>key change</i>');
  });
});

// ─── Token pool lifecycle ─────────────────────────────────────────────────

import { loadTokens, getCurrentToken, rotateToken, getTokenIndex, getTokenCount } from './tokens.js';

describe('token pool lifecycle integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    // Reset module state
    loadTokens();
  });

  it('single token: getCurrentToken returns it, rotateToken wraps back', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = undefined as unknown as string;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-single';
    loadTokens();

    expect(getTokenCount()).toBe(1);
    expect(getCurrentToken()).toBe('tok-single');
    expect(getTokenIndex()).toBe(0);

    // Rotating with one token stays at index 0
    const next = rotateToken();
    expect(next).toBe('tok-single');
    expect(getTokenIndex()).toBe(0);
  });

  it('multi-token pool: rotates through all tokens and wraps around', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'tok-a,tok-b,tok-c';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    loadTokens();

    expect(getTokenCount()).toBe(3);
    expect(getCurrentToken()).toBe('tok-a');

    const t1 = rotateToken();
    expect(t1).toBe('tok-b');
    expect(getTokenIndex()).toBe(1);

    const t2 = rotateToken();
    expect(t2).toBe('tok-c');
    expect(getTokenIndex()).toBe(2);

    // Wrap around
    const t3 = rotateToken();
    expect(t3).toBe('tok-a');
    expect(getTokenIndex()).toBe(0);
  });

  it('CLAUDE_CODE_OAUTH_TOKENS takes priority over CLAUDE_CODE_OAUTH_TOKEN', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'multi-1,multi-2';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'single-fallback';
    loadTokens();

    expect(getTokenCount()).toBe(2);
    expect(getCurrentToken()).toBe('multi-1');
  });

  it('whitespace around tokens is trimmed', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = ' tok-x , tok-y , tok-z ';
    loadTokens();

    expect(getCurrentToken()).toBe('tok-x');
    expect(rotateToken()).toBe('tok-y');
    expect(rotateToken()).toBe('tok-z');
  });

  it('no env vars configured: empty pool, getCurrentToken returns empty string', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKENS;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    loadTokens();

    expect(getTokenCount()).toBe(0);
    expect(getCurrentToken()).toBe('');
    expect(rotateToken()).toBe('');
    expect(getTokenIndex()).toBe(0);
  });

  it('full rotation cycle returns to first token after N steps', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'a,b,c,d,e';
    loadTokens();

    const first = getCurrentToken();
    // Rotate 5 times (full circle)
    for (let i = 0; i < 5; i++) rotateToken();
    expect(getCurrentToken()).toBe(first);
    expect(getTokenIndex()).toBe(0);
  });

  it('rotation guard: attempt <= count-1 correctly signals when all tokens exhausted', () => {
    // Mirrors the bot logic: rotate only while attempt <= getTokenCount() - 1
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'a,b,c';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    loadTokens();

    const total = getTokenCount(); // 3
    expect(total).toBe(3);

    let attempt = 1;
    expect(attempt <= total - 1).toBe(true); // can rotate on attempt 1 (1 <= 2)
    rotateToken();
    expect(getCurrentToken()).toBe('b');

    attempt = 2;
    expect(attempt <= total - 1).toBe(true); // can rotate on attempt 2 (2 <= 2)
    rotateToken();
    expect(getCurrentToken()).toBe('c');

    attempt = 3;
    expect(attempt <= total - 1).toBe(false); // all tokens exhausted (3 > 2)
  });
});

// ─── detectUsageLimit + token rotation flow ──────────────────────────────

describe('detectUsageLimit + token rotation integration', () => {
  const origTokens = process.env.CLAUDE_CODE_OAUTH_TOKENS;

  afterEach(() => {
    if (origTokens !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKENS = origTokens;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKENS;
    }
    loadTokens();
  });

  it('usage_exhausted signal detected and token is rotated to secondary', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'token-primary,token-secondary';
    loadTokens();

    const signal = detectUsageLimit('Claude: usage limit reached — extra usage has been disabled');

    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe('usage_exhausted');
    expect(signal.retryAfterMs).toBeGreaterThan(0);

    const before = getCurrentToken();
    rotateToken();
    const after = getCurrentToken();

    expect(before).toBe('token-primary');
    expect(after).toBe('token-secondary');
  });

  it('rate_limit signal returns 2-minute retry window', () => {
    const signal = detectUsageLimit('The API is currently overloaded');
    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe('rate_limit');
    expect(signal.retryAfterMs).toBe(2 * 60 * 1000);
  });

  it('clean text produces no signal', () => {
    const signal = detectUsageLimit('Task complete. All tests passed.');
    expect(signal.detected).toBe(false);
    expect(signal.retryAfterMs).toBe(0);
    expect(signal.humanMessage).toBe('');
  });
});
