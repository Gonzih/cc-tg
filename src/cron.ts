/**
 * Cron job manager for cc-tg.
 * Persists jobs to <cwd>/.cc-tg/crons.json.
 * Fires prompts into Claude sessions on schedule.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface CronJob {
  id: string;
  chatId: number;
  intervalMs: number;
  prompt: string;
  createdAt: string;
  schedule: string; // human-readable, e.g. "every 1h"
}

/** Called when a job fires. `done` must be called when the task completes so
 *  the next scheduled tick is allowed to run. Until `done` is called, concurrent
 *  ticks for the same job are silently skipped (prevents the resume-loop explosion
 *  where each tick spawns more agents than the last). */
type FireCallback = (chatId: number, prompt: string, jobId: string, done: () => void) => void;

export class CronManager {
  private jobs = new Map<string, CronJob & { timer: ReturnType<typeof setInterval> }>();
  /** Job IDs whose fire callback has been invoked but whose `done` hasn't fired yet. */
  private activeJobs = new Set<string>();
  private storePath: string;
  private fire: FireCallback;

  constructor(cwd: string, fire: FireCallback) {
    this.storePath = join(cwd, ".cc-tg", "crons.json");
    this.fire = fire;
    this.load();
  }

  /** Parse "every 30m", "every 2h", "every 1d" → ms */
  static parseSchedule(schedule: string): number | null {
    const m = schedule.trim().match(/^every\s+(\d+)(m|h|d)$/i);
    if (!m) return null;
    const n = parseInt(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "m") return n * 60_000;
    if (unit === "h") return n * 3_600_000;
    if (unit === "d") return n * 86_400_000;
    return null;
  }

  add(chatId: number, schedule: string, prompt: string): CronJob | null {
    const intervalMs = CronManager.parseSchedule(schedule);
    if (!intervalMs) return null;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const job: CronJob = { id, chatId, intervalMs, prompt, schedule, createdAt: new Date().toISOString() };

    const timer = setInterval(() => {
      if (this.activeJobs.has(id)) {
        console.log(`[cron:${id}] skipping tick — previous task still running`);
        return;
      }
      this.activeJobs.add(id);
      console.log(`[cron:${id}] firing for chat=${chatId} prompt="${prompt}"`);
      this.fire(chatId, prompt, id, () => { this.activeJobs.delete(id); });
    }, intervalMs);

    this.jobs.set(id, { ...job, timer });
    this.persist();
    return job;
  }

  remove(chatId: number, id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.chatId !== chatId) return false;
    clearInterval(job.timer);
    this.activeJobs.delete(id);
    this.jobs.delete(id);
    this.persist();
    return true;
  }

  clearAll(chatId: number): number {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.chatId === chatId) {
        clearInterval(job.timer);
        this.activeJobs.delete(id);
        this.jobs.delete(id);
        count++;
      }
    }
    if (count) this.persist();
    return count;
  }

  list(chatId: number): CronJob[] {
    return [...this.jobs.values()]
      .filter((j) => j.chatId === chatId)
      .map(({ timer: _t, ...j }) => j);
  }

  update(chatId: number, id: string, updates: { schedule?: string; prompt?: string }): CronJob | null | false {
    const job = this.jobs.get(id);
    if (!job || job.chatId !== chatId) return false;

    if (updates.schedule !== undefined) {
      const intervalMs = CronManager.parseSchedule(updates.schedule);
      if (!intervalMs) return null;
      job.intervalMs = intervalMs;
      job.schedule = updates.schedule;
    }

    if (updates.prompt !== undefined) {
      job.prompt = updates.prompt;
    }

    // Recreate timer so it uses updated intervalMs and always reads latest job.prompt
    clearInterval(job.timer);
    // Also clear any active-job lock so the updated timer can fire immediately next tick
    this.activeJobs.delete(job.id);
    job.timer = setInterval(() => {
      if (this.activeJobs.has(job.id)) {
        console.log(`[cron:${job.id}] skipping tick — previous task still running`);
        return;
      }
      this.activeJobs.add(job.id);
      console.log(`[cron:${job.id}] firing for chat=${job.chatId} prompt="${job.prompt}"`);
      this.fire(job.chatId, job.prompt, job.id, () => { this.activeJobs.delete(job.id); });
    }, job.intervalMs);

    this.persist();
    const { timer: _t, ...cronJob } = job;
    return cronJob;
  }

  private persist(): void {
    try {
      const dir = join(this.storePath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: CronJob[] = [...this.jobs.values()].map(({ timer: _t, ...j }) => j);
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[cron] persist error:", (err as Error).message);
    }
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.storePath, "utf8")) as CronJob[];
      for (const job of data) {
        const timer = setInterval(() => {
          if (this.activeJobs.has(job.id)) {
            console.log(`[cron:${job.id}] skipping tick — previous task still running`);
            return;
          }
          this.activeJobs.add(job.id);
          console.log(`[cron:${job.id}] firing for chat=${job.chatId} prompt="${job.prompt}"`);
          this.fire(job.chatId, job.prompt, job.id, () => { this.activeJobs.delete(job.id); });
        }, job.intervalMs);
        this.jobs.set(job.id, { ...job, timer });
      }
      console.log(`[cron] loaded ${data.length} jobs from disk`);
    } catch (err) {
      console.error("[cron] load error:", (err as Error).message);
    }
  }
}
