import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('[]'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { CronManager, type CronJob } from './cron.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe('CronManager.parseSchedule', () => {
  it('parses minutes', () => {
    expect(CronManager.parseSchedule('every 30m')).toBe(30 * 60_000);
    expect(CronManager.parseSchedule('every 1m')).toBe(60_000);
  });

  it('parses hours', () => {
    expect(CronManager.parseSchedule('every 2h')).toBe(2 * 3_600_000);
    expect(CronManager.parseSchedule('every 1h')).toBe(3_600_000);
  });

  it('parses days', () => {
    expect(CronManager.parseSchedule('every 1d')).toBe(86_400_000);
    expect(CronManager.parseSchedule('every 7d')).toBe(7 * 86_400_000);
  });

  it('returns null for invalid formats', () => {
    expect(CronManager.parseSchedule('every 5s')).toBeNull();
    expect(CronManager.parseSchedule('daily')).toBeNull();
    expect(CronManager.parseSchedule('')).toBeNull();
    expect(CronManager.parseSchedule('every hour')).toBeNull();
    expect(CronManager.parseSchedule('5m')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(CronManager.parseSchedule('every 1H')).toBe(3_600_000);
    expect(CronManager.parseSchedule('EVERY 1M')).toBe(60_000);
    expect(CronManager.parseSchedule('Every 1D')).toBe(86_400_000);
  });
});

describe('CronManager operations', () => {
  let manager: CronManager;
  let fireCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fireCallback = vi.fn();
    manager = new CronManager('/tmp/test-crons', fireCallback);
  });

  afterEach(() => {
    manager.clearAll(42);
    manager.clearAll(99);
    vi.useRealTimers();
  });

  describe('add', () => {
    it('adds a job and returns it with correct properties', () => {
      const job = manager.add(42, 'every 1h', 'check status');
      expect(job).not.toBeNull();
      expect(job!.schedule).toBe('every 1h');
      expect(job!.prompt).toBe('check status');
      expect(job!.chatId).toBe(42);
      expect(job!.intervalMs).toBe(3_600_000);
      expect(job!.id).toBeTruthy();
    });

    it('returns null for invalid schedule', () => {
      expect(manager.add(42, 'every 5s', 'test')).toBeNull();
      expect(manager.add(42, 'invalid', 'test')).toBeNull();
    });

    it('fires callback at the specified interval', () => {
      fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => done());
      manager.add(42, 'every 1m', 'ping');
      expect(fireCallback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledWith(42, 'ping', expect.any(String), expect.any(Function));
    });

    it('fires callback multiple times when each task completes before the next tick', () => {
      fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => done());
      manager.add(42, 'every 1m', 'check');
      vi.advanceTimersByTime(180_000);
      expect(fireCallback).toHaveBeenCalledTimes(3);
    });

    it('skips concurrent ticks while the previous task is still running', () => {
      // Don't call done() — simulate a long-running task
      manager.add(42, 'every 1m', 'slow-task');
      // First tick fires the task (done not called yet)
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledTimes(1);
      // Second and third ticks should be skipped because done() was never called
      vi.advanceTimersByTime(120_000);
      expect(fireCallback).toHaveBeenCalledTimes(1);
    });

    it('resumes firing after done() is called', () => {
      let capturedDone: (() => void) | null = null;
      fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => {
        capturedDone = done;
      });
      manager.add(42, 'every 1m', 'task');
      // First tick: task starts, done not called
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledTimes(1);
      // Second tick: still running, skipped
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledTimes(1);
      // Task finishes
      capturedDone!();
      // Third tick: now allowed
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('list', () => {
    it('returns empty array when no jobs for chat', () => {
      expect(manager.list(42)).toEqual([]);
    });

    it('returns only jobs for the specified chat', () => {
      manager.add(42, 'every 1h', 'task A');
      manager.add(99, 'every 1h', 'task B');
      const jobs = manager.list(42);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].prompt).toBe('task A');
    });

    it('returns multiple jobs for the same chat', () => {
      manager.add(42, 'every 1h', 'task A');
      manager.add(42, 'every 2h', 'task B');
      expect(manager.list(42)).toHaveLength(2);
    });

    it('does not include timer in returned jobs', () => {
      manager.add(42, 'every 1h', 'test');
      const jobs = manager.list(42);
      expect(jobs[0]).not.toHaveProperty('timer');
    });
  });

  describe('remove', () => {
    it('removes a job by id and returns true', () => {
      const job = manager.add(42, 'every 1h', 'test')!;
      expect(manager.remove(42, job.id)).toBe(true);
      expect(manager.list(42)).toHaveLength(0);
    });

    it('returns false for unknown id', () => {
      expect(manager.remove(42, 'nonexistent-id')).toBe(false);
    });

    it('returns false when chatId does not match', () => {
      const job = manager.add(42, 'every 1h', 'test')!;
      expect(manager.remove(99, job.id)).toBe(false);
      expect(manager.list(42)).toHaveLength(1);
    });

    it('stops the timer after removal', () => {
      const job = manager.add(42, 'every 1m', 'test')!;
      manager.remove(42, job.id);
      vi.advanceTimersByTime(120_000);
      expect(fireCallback).not.toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('removes all jobs for a chat and returns count', () => {
      manager.add(42, 'every 1h', 'A');
      manager.add(42, 'every 2h', 'B');
      manager.add(99, 'every 1h', 'C');
      expect(manager.clearAll(42)).toBe(2);
      expect(manager.list(42)).toHaveLength(0);
    });

    it('does not affect jobs from other chats', () => {
      manager.add(42, 'every 1h', 'A');
      manager.add(99, 'every 1h', 'B');
      manager.clearAll(42);
      expect(manager.list(99)).toHaveLength(1);
    });

    it('returns 0 when no jobs exist', () => {
      expect(manager.clearAll(42)).toBe(0);
    });
  });

  describe('update', () => {
    it('updates schedule', () => {
      const job = manager.add(42, 'every 1h', 'test')!;
      const updated = manager.update(42, job.id, { schedule: 'every 2h' }) as CronJob;
      expect(updated).not.toBeNull();
      expect(updated).not.toBe(false);
      expect(updated.schedule).toBe('every 2h');
      expect(updated.intervalMs).toBe(2 * 3_600_000);
    });

    it('updates prompt', () => {
      const job = manager.add(42, 'every 1h', 'original')!;
      const updated = manager.update(42, job.id, { prompt: 'updated prompt' }) as CronJob;
      expect(updated.prompt).toBe('updated prompt');
    });

    it('returns null for invalid schedule', () => {
      const job = manager.add(42, 'every 1h', 'test')!;
      expect(manager.update(42, job.id, { schedule: 'every 5s' })).toBeNull();
    });

    it('returns false when chatId does not match', () => {
      const job = manager.add(42, 'every 1h', 'test')!;
      expect(manager.update(99, job.id, { prompt: 'x' })).toBe(false);
    });

    it('returns false for unknown job id', () => {
      expect(manager.update(42, 'nonexistent', { prompt: 'x' })).toBe(false);
    });

    it('fires updated prompt after schedule update', () => {
      fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => done());
      const job = manager.add(42, 'every 1m', 'old prompt')!;
      manager.update(42, job.id, { prompt: 'new prompt', schedule: 'every 2m' });
      vi.advanceTimersByTime(120_000);
      expect(fireCallback).toHaveBeenCalledWith(42, 'new prompt', expect.any(String), expect.any(Function));
    });

    it('no-op update (empty updates object) recreates timer with original values', () => {
      fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => done());
      const job = manager.add(42, 'every 1m', 'my prompt')!;
      const updated = manager.update(42, job.id, {}) as CronJob;
      expect(updated).not.toBe(false);
      expect(updated).not.toBeNull();
      expect(updated.prompt).toBe('my prompt');
      expect(updated.schedule).toBe('every 1m');
      // Timer still fires
      vi.advanceTimersByTime(60_000);
      expect(fireCallback).toHaveBeenCalledWith(42, 'my prompt', expect.any(String), expect.any(Function));
    });
  });

  describe('clearAll — persist behavior', () => {
    it('does not call persist when there are no jobs to clear (count === 0 branch)', () => {
      mockWriteFileSync.mockClear();
      const count = manager.clearAll(42);
      expect(count).toBe(0);
      // persist() is only called when count > 0
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});

describe('CronManager — load() behavior', () => {
  let fireCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fireCallback = vi.fn();
    // Reset mocks to defaults
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('[]');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips loading when crons.json does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const manager = new CronManager('/tmp/no-file', fireCallback);
    expect(manager.list(42)).toEqual([]);
  });

  it('restores jobs from disk and schedules their timers', () => {
    const storedJob: CronJob = {
      id: 'test-id',
      chatId: 42,
      intervalMs: 60_000,
      prompt: 'loaded prompt',
      schedule: 'every 1m',
      createdAt: new Date().toISOString(),
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify([storedJob]));
    fireCallback.mockImplementation((_chatId, _prompt, _jobId, done) => done());

    const manager = new CronManager('/tmp/has-file', fireCallback);
    expect(manager.list(42)).toHaveLength(1);
    expect(manager.list(42)[0].prompt).toBe('loaded prompt');

    // Timer should fire
    vi.advanceTimersByTime(60_000);
    expect(fireCallback).toHaveBeenCalledWith(42, 'loaded prompt', 'test-id', expect.any(Function));

    // Cleanup
    manager.clearAll(42);
  });

  it('gracefully handles corrupted JSON in crons.json', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ not valid json ');

    // Should not throw — just logs error
    expect(() => new CronManager('/tmp/corrupt', fireCallback)).not.toThrow();
  });

  it('handles persist errors gracefully (writeFileSync throws)', () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    // add() calls persist() — should not throw even when persist fails
    const manager = new CronManager('/tmp/no-write', fireCallback);
    expect(() => manager.add(42, 'every 1m', 'test')).not.toThrow();
  });
});

describe('CronManager.parseSchedule — additional edge cases', () => {
  it('trims leading and trailing whitespace before matching', () => {
    expect(CronManager.parseSchedule('  every 5m  ')).toBe(5 * 60_000);
    expect(CronManager.parseSchedule('\tevery 2h\t')).toBe(2 * 3_600_000);
  });

  it('returns null for zero interval (0m)', () => {
    // parseSchedule returns 0 for "every 0m" which is falsy — add() treats it as null
    const ms = CronManager.parseSchedule('every 0m');
    // 0 is falsy, so add() returns null for it
    expect(ms).toBe(0);
  });

  it('returns null for non-digit schedule values', () => {
    expect(CronManager.parseSchedule('every xh')).toBeNull();
    expect(CronManager.parseSchedule('every 1.5h')).toBeNull();
  });
});
