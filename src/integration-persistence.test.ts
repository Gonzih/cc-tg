/**
 * Integration tests: CronManager filesystem persistence.
 *
 * No mocks — uses real temp directories for genuine disk I/O.
 * Verifies that jobs written by one CronManager instance are correctly
 * loaded and re-scheduled by a fresh instance pointing to the same directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { CronManager, type CronJob } from './cron.js';

describe('CronManager filesystem persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    // Unique temp dir per test so tests are fully isolated
    tmpDir = join(
      tmpdir(),
      `cc-tg-cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  // ── persistence round-trip ──────────────────────────────────────────────────

  it('persists a job to disk on add() and reloads it in a new instance', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 1h', 'check status');

    const mgr2 = new CronManager(tmpDir, vi.fn());
    const loaded = mgr2.list(42);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      schedule: 'every 1h',
      prompt: 'check status',
      chatId: 42,
      intervalMs: 3_600_000,
    });
    expect(loaded[0].id).toBeTruthy();
    expect(loaded[0].createdAt).toBeTruthy();

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  it('reloaded job fires its callback at the correct interval', () => {
    const fire1 = vi.fn();
    const mgr1 = new CronManager(tmpDir, fire1);
    mgr1.add(42, 'every 1m', 'ping');
    // mgr1 persists on add(); do NOT clear so data stays on disk

    const fire2 = vi.fn().mockImplementation((_cid, _p, _id, done) => done());
    const mgr2 = new CronManager(tmpDir, fire2);

    expect(mgr2.list(42)).toHaveLength(1);

    vi.advanceTimersByTime(60_000);

    expect(fire2).toHaveBeenCalledWith(42, 'ping', expect.any(String), expect.any(Function));

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  it('reloaded job respects the stored intervalMs (hours)', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 2h', 'hourly task');

    const fire = vi.fn().mockImplementation((_c, _p, _id, done) => done());
    const mgr2 = new CronManager(tmpDir, fire);

    // Exactly 1h passes — should NOT fire (interval is 2h)
    vi.advanceTimersByTime(3_600_000);
    expect(fire).not.toHaveBeenCalled();

    // Full 2h passes — should fire once
    vi.advanceTimersByTime(3_600_000);
    expect(fire).toHaveBeenCalledTimes(1);

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  // ── remove() persistence ────────────────────────────────────────────────────

  it('remove() updates disk — new instance sees empty list', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    const job = mgr1.add(42, 'every 1h', 'to-remove')!;

    mgr1.remove(42, job.id);

    const mgr2 = new CronManager(tmpDir, vi.fn());
    expect(mgr2.list(42)).toHaveLength(0);
  });

  it('remove() leaves other jobs intact on disk', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    const jobA = mgr1.add(42, 'every 1h', 'keep me')!;
    const jobB = mgr1.add(42, 'every 2h', 'remove me')!;

    mgr1.remove(42, jobB.id);

    const mgr2 = new CronManager(tmpDir, vi.fn());
    const loaded = mgr2.list(42);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(jobA.id);
    expect(loaded[0].prompt).toBe('keep me');

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  // ── clearAll() persistence ──────────────────────────────────────────────────

  it('clearAll() removes all jobs for a chat from disk', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 1h', 'A');
    mgr1.add(42, 'every 2h', 'B');
    mgr1.clearAll(42);

    const mgr2 = new CronManager(tmpDir, vi.fn());
    expect(mgr2.list(42)).toHaveLength(0);
  });

  it('clearAll() leaves jobs for other chats on disk', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 1h', 'chat-42 job');
    mgr1.add(99, 'every 2h', 'chat-99 job');
    mgr1.clearAll(42);

    const mgr2 = new CronManager(tmpDir, vi.fn());
    expect(mgr2.list(42)).toHaveLength(0);
    expect(mgr2.list(99)).toHaveLength(1);
    expect(mgr2.list(99)[0].chatId).toBe(99);

    mgr1.clearAll(99);
    mgr2.clearAll(99);
  });

  // ── update() persistence ────────────────────────────────────────────────────

  it('update() persists schedule and prompt changes across reload', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    const job = mgr1.add(42, 'every 1h', 'original')!;
    mgr1.update(42, job.id, { prompt: 'updated prompt', schedule: 'every 3h' });

    const mgr2 = new CronManager(tmpDir, vi.fn());
    const loaded = mgr2.list(42) as CronJob[];

    expect(loaded).toHaveLength(1);
    expect(loaded[0].prompt).toBe('updated prompt');
    expect(loaded[0].schedule).toBe('every 3h');
    expect(loaded[0].intervalMs).toBe(3 * 3_600_000);

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  it('update() prompt-only change survives reload', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    const job = mgr1.add(42, 'every 1h', 'old prompt')!;
    mgr1.update(42, job.id, { prompt: 'new prompt' });

    const mgr2 = new CronManager(tmpDir, vi.fn());
    expect(mgr2.list(42)[0].prompt).toBe('new prompt');
    expect(mgr2.list(42)[0].schedule).toBe('every 1h'); // schedule unchanged

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  // ── multi-job persistence ───────────────────────────────────────────────────

  it('multiple jobs for the same chat all persist and reload', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 30m', 'job A');
    mgr1.add(42, 'every 1h', 'job B');
    mgr1.add(42, 'every 2h', 'job C');

    const mgr2 = new CronManager(tmpDir, vi.fn());
    const jobs = mgr2.list(42);

    expect(jobs).toHaveLength(3);
    const prompts = jobs.map(j => j.prompt).sort();
    expect(prompts).toEqual(['job A', 'job B', 'job C']);

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });

  it('jobs for multiple chats are all persisted independently', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(1, 'every 1h', 'chat-1');
    mgr1.add(2, 'every 1h', 'chat-2');
    mgr1.add(3, 'every 1h', 'chat-3');

    const mgr2 = new CronManager(tmpDir, vi.fn());
    expect(mgr2.list(1)[0].prompt).toBe('chat-1');
    expect(mgr2.list(2)[0].prompt).toBe('chat-2');
    expect(mgr2.list(3)[0].prompt).toBe('chat-3');

    mgr1.clearAll(1); mgr1.clearAll(2); mgr1.clearAll(3);
    mgr2.clearAll(1); mgr2.clearAll(2); mgr2.clearAll(3);
  });

  // ── file location ───────────────────────────────────────────────────────────

  it('writes crons.json to <cwd>/.cc-tg/crons.json', () => {
    const mgr = new CronManager(tmpDir, vi.fn());
    mgr.add(42, 'every 1h', 'test job');

    const expectedPath = join(tmpDir, '.cc-tg', 'crons.json');
    expect(existsSync(expectedPath)).toBe(true);

    const onDisk = JSON.parse(readFileSync(expectedPath, 'utf8')) as CronJob[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].prompt).toBe('test job');

    mgr.clearAll(42);
  });

  it('crons.json contains all required CronJob fields', () => {
    const mgr = new CronManager(tmpDir, vi.fn());
    mgr.add(42, 'every 1h', 'field check');

    const data = JSON.parse(
      readFileSync(join(tmpDir, '.cc-tg', 'crons.json'), 'utf8')
    ) as CronJob[];

    const job = data[0];
    expect(job).toHaveProperty('id');
    expect(job).toHaveProperty('chatId', 42);
    expect(job).toHaveProperty('intervalMs', 3_600_000);
    expect(job).toHaveProperty('prompt', 'field check');
    expect(job).toHaveProperty('schedule', 'every 1h');
    expect(job).toHaveProperty('createdAt');
    expect(job).not.toHaveProperty('timer'); // timer must not be serialized

    mgr.clearAll(42);
  });

  // ── concurrent-tick prevention survives reload ─────────────────────────────

  it('reloaded job prevents concurrent ticks while previous task runs', () => {
    const mgr1 = new CronManager(tmpDir, vi.fn());
    mgr1.add(42, 'every 1m', 'slow task');

    // Long-running task: never calls done()
    const fire = vi.fn();
    const mgr2 = new CronManager(tmpDir, fire);

    vi.advanceTimersByTime(60_000); // first tick fires, done not called
    expect(fire).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120_000); // two more ticks skipped
    expect(fire).toHaveBeenCalledTimes(1); // still 1

    mgr1.clearAll(42);
    mgr2.clearAll(42);
  });
});
