/**
 * cc-agent Redis event subscriber.
 *
 * Listens to the `cca:events` pub/sub channel for job completion events,
 * asks Claude to decide what to do, and acts accordingly:
 *   NOTIFY_ONLY    — send a Telegram message to the configured chat
 *   SPAWN_FOLLOWUP — spawn a follow-up cc-agent job via MCP + notify Telegram
 *   SILENT         — log and do nothing
 *
 * Controlled via CC_AGENT_EVENTS_ENABLED env var (default: true).
 * Requires CC_AGENT_NOTIFY_CHAT_ID to send Telegram notifications.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { Redis } from "ioredis";
import TelegramBot from "node-telegram-bot-api";

const STREAM_KEY = "cca:event-stream";
import { ClaudeProcess, extractText } from "./claude.js";

export interface JobEvent {
  jobId: string;
  status: "done" | "failed" | "interrupted" | "running" | "cancelled";
  title: string;
  repoUrl: string;
  lastLines: string[];
  score?: number;
  timestamp: number;
}

export interface CoordinatorPlan {
  nextStep?: { repo_url: string; task: string };
  summary: string;
}

export interface DecisionResult {
  action: "NOTIFY_ONLY" | "SPAWN_FOLLOWUP" | "SILENT";
  message?: string;
  followup?: {
    repo_url: string;
    task: string;
  };
}

/** Injectable dependencies for testability */
export interface HandlerDeps {
  askClaude: (prompt: string) => Promise<string>;
  sendTelegramMessage: (chatId: number, text: string) => Promise<void>;
  spawnFollowupAgent: (repoUrl: string, task: string) => Promise<void>;
  readJobOutput: (jobId: string) => Promise<string[]>;
  readCoordinatorPlan: (jobId: string) => Promise<CoordinatorPlan | null>;
  getRunningJobCount: () => Promise<number>;
  getActiveChatIds: () => Promise<number[]>;
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn("[cc-agent-events]", ...args);
}

export function buildDecisionPrompt(
  event: JobEvent,
  last40lines: string[],
  coordinatorPlan: CoordinatorPlan | null
): string {
  const scoreStr = event.score !== undefined ? String(event.score) : "n/a";
  const planStr = coordinatorPlan ? JSON.stringify(coordinatorPlan, null, 2) : "none";
  return `A cc-agent job just completed.

Job: ${event.title}
Repo: ${event.repoUrl}
Status: ${event.status}
Score: ${scoreStr}

Last output + LEARNINGS:
${last40lines.join("\n")}

Coordinator plan for this job (if any):
${planStr}

Decide what to do next:
1. SPAWN_FOLLOWUP — spawn a follow-up job (provide repo_url and task)
2. NOTIFY_ONLY — send Telegram message, no spawn needed
3. SILENT — routine completion, no action

Rules:
- If LEARNINGS has "Recommendations for next agent" with a clear actionable next step → consider SPAWN_FOLLOWUP
- If coordinator plan has nextStep → SPAWN_FOLLOWUP with that task (prefer coordinator plan over LEARNINGS)
- Failed jobs → NOTIFY_ONLY always
- Score < 0.5 → NOTIFY_ONLY
- Routine/expected completions → SILENT

Reply in JSON:
{
  "action": "SPAWN_FOLLOWUP" | "NOTIFY_ONLY" | "SILENT",
  "message": "brief telegram message (1-2 lines)",
  "followup": { "repo_url": "...", "task": "..." } | null
}`;
}

function extractJson(text: string): string {
  // Strip ```json ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Find first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return "";
}

export function parseDecision(raw: string): DecisionResult {
  const extracted = extractJson(raw);
  if (!extracted) throw new Error(`No JSON found in Claude response: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(extracted) as DecisionResult;
  if (!["NOTIFY_ONLY", "SPAWN_FOLLOWUP", "SILENT"].includes(parsed.action)) {
    throw new Error(`Unknown action: ${parsed.action}`);
  }
  return parsed;
}

function formatSpawnMessage(
  event: JobEvent,
  followup: { repo_url: string; task: string },
  runningCount: number
): string {
  const scoreStr = event.score !== undefined ? ` (score: ${event.score})` : "";
  const repoShort = followup.repo_url.replace(/^https?:\/\/github\.com\//, "");
  const lines = [
    `✓ ${event.title} done${scoreStr}`,
    `→ spawned: ${followup.task} (${repoShort})`,
  ];
  if (runningCount > 0) {
    lines.push(`${runningCount} jobs running`);
  }
  return lines.join("\n");
}

function formatFailureMessage(event: JobEvent): string {
  const lastLine = event.lastLines[event.lastLines.length - 1] ?? "";
  const repoShort = event.repoUrl.replace(/^https?:\/\/github\.com\//, "");
  return `✗ ${event.title} failed\n${repoShort} — exit 1\nLast line: ${lastLine}`;
}

/**
 * Ask Claude to make a decision about a completed job.
 * Returns the raw text response from Claude.
 */
export function defaultAskClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const token =
      process.env.CLAUDE_CODE_TOKEN ??
      process.env.CLAUDE_CODE_OAUTH_TOKEN ??
      process.env.ANTHROPIC_API_KEY;

    if (!token) {
      reject(new Error("No Claude token configured"));
      return;
    }

    const claude = new ClaudeProcess({ token });
    let output = "";

    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error("Claude decision timed out after 60s"));
    }, 60_000);

    claude.on("message", (msg) => {
      if (msg.type === "result") {
        const text = extractText(msg);
        if (text) output += text;
        clearTimeout(timeout);
        claude.kill();
        resolve(output.trim());
      } else if (msg.type === "assistant") {
        const text = extractText(msg);
        if (text) output += text;
      }
    });

    claude.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    claude.on("exit", (code) => {
      clearTimeout(timeout);
      if (!output) {
        reject(new Error(`Claude exited with code ${code} and no output`));
      } else {
        resolve(output.trim());
      }
    });

    claude.sendPrompt(prompt);
  });
}

export async function defaultSendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const tg = new TelegramBot(token, { polling: false });
  await tg.sendMessage(chatId, text);
}

export async function defaultSpawnFollowupAgent(repoUrl: string, task: string): Promise<void> {
  const token =
    process.env.CLAUDE_CODE_TOKEN ??
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.ANTHROPIC_API_KEY;

  const prompt = `Use the spawn_agent MCP tool to start a new cc-agent job with these parameters:
repo_url: ${repoUrl}
task: ${task}

Call the spawn_agent tool now with these exact parameters. Report the job ID when done.`;

  return new Promise((resolve) => {
    const claude = new ClaudeProcess({ token: token ?? undefined });

    const timeout = setTimeout(() => {
      log("warn", "spawnFollowupAgent: timed out");
      claude.kill();
      resolve();
    }, 120_000);

    claude.on("message", (msg) => {
      if (msg.type === "result") {
        clearTimeout(timeout);
        claude.kill();
        resolve();
      }
    });

    claude.on("error", (err) => {
      log("error", "spawnFollowupAgent error:", err.message);
      clearTimeout(timeout);
      resolve();
    });

    claude.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    claude.sendPrompt(prompt);
  });
}

function makeRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    lazyConnect: true,
    enableOfflineQueue: false,
  });
}

export async function defaultReadJobOutput(jobId: string): Promise<string[]> {
  const redis = makeRedisClient();
  try {
    await redis.connect();
    const lines = await redis.lrange(`cca:job:${jobId}:output`, -40, -1);
    return lines;
  } finally {
    try { redis.disconnect(); } catch {}
  }
}

export async function defaultReadCoordinatorPlan(jobId: string): Promise<CoordinatorPlan | null> {
  const redis = makeRedisClient();
  try {
    await redis.connect();
    const raw = await redis.get(`cca:coordinator:plan:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw) as CoordinatorPlan;
  } finally {
    try { redis.disconnect(); } catch {}
  }
}

export async function defaultGetRunningJobCount(): Promise<number> {
  return 0;
}

/**
 * Returns chat IDs to notify about job events.
 * Reads unique chatIds from the cron jobs file (same users who set up cron jobs).
 * Falls back to CC_AGENT_NOTIFY_CHAT_ID env var for backward compatibility.
 */
export async function defaultGetActiveChatIds(): Promise<number[]> {
  const ids = new Set<number>();

  // Backward compat: explicit env var
  const chatIdStr = process.env.CC_AGENT_NOTIFY_CHAT_ID;
  if (chatIdStr) {
    const chatId = Number(chatIdStr);
    if (!isNaN(chatId)) ids.add(chatId);
  }

  // Read chatIds from cron jobs persistence file
  try {
    const cwd = process.env.CWD ?? process.cwd();
    const cronFile = join(cwd, ".cc-tg", "crons.json");
    const raw = readFileSync(cronFile, "utf-8");
    const jobs = JSON.parse(raw) as Array<{ chatId: number }>;
    for (const job of jobs) {
      if (typeof job.chatId === "number") ids.add(job.chatId);
    }
  } catch {
    // file doesn't exist or parse error — ignore
  }

  return Array.from(ids);
}

/**
 * Write a coordinator plan for a job, so cc-tg knows what follow-up to spawn.
 * Call this when spawning a job that has a planned follow-up.
 * TTL: 7 days.
 */
export async function writeCoordinatorPlan(
  jobId: string,
  plan: { nextStep?: { repo_url: string; task: string }; summary: string }
): Promise<void> {
  const redis = makeRedisClient();
  try {
    await redis.connect();
    const key = `cca:coordinator:plan:${jobId}`;
    const ttlSeconds = 7 * 24 * 60 * 60; // 7 days
    await redis.set(key, JSON.stringify(plan), "EX", ttlSeconds);
  } finally {
    try { redis.disconnect(); } catch {}
  }
}

/**
 * Handle a single job event message from Redis pub/sub.
 * Exported for testability — production code passes defaultDeps.
 */
export async function handleJobEvent(
  message: string,
  deps: HandlerDeps
): Promise<void> {
  let event: JobEvent;
  try {
    event = JSON.parse(message) as JobEvent;
  } catch (err) {
    log("error", "Failed to parse job event:", (err as Error).message);
    return;
  }

  // Only act on terminal states
  if (event.status !== "done" && event.status !== "failed") {
    log("info", `Ignoring ${event.status} event for job ${event.jobId}`);
    return;
  }

  log("info", `Processing ${event.status} event for job: ${event.title} (${event.jobId})`);

  // Read job output from Redis (fall back to event.lastLines on error)
  let last40lines: string[] = event.lastLines;
  try {
    const lines = await deps.readJobOutput(event.jobId);
    if (lines.length > 0) last40lines = lines;
  } catch (err) {
    log("warn", "Failed to read job output, using event.lastLines:", (err as Error).message);
  }

  // Read coordinator plan from Redis (fall back to null on error)
  let coordinatorPlan: CoordinatorPlan | null = null;
  try {
    coordinatorPlan = await deps.readCoordinatorPlan(event.jobId);
  } catch (err) {
    log("warn", "Failed to read coordinator plan:", (err as Error).message);
  }

  // Fast path: coordinator plan has explicit next step — spawn directly, no Claude needed
  // This eliminates JSON truncation issues when Claude regenerates long task strings.
  if (coordinatorPlan?.nextStep) {
    log("info", `Fast path: coordinator plan nextStep found for job ${event.jobId}`);
    const { repo_url, task } = coordinatorPlan.nextStep;
    let fpChatIds: number[] = [];
    try {
      fpChatIds = await deps.getActiveChatIds();
    } catch (err) {
      log("warn", "Fast path: failed to get active chat IDs:", (err as Error).message);
    }
    try {
      await deps.spawnFollowupAgent(repo_url, task);
    } catch (err) {
      log("error", "Fast path: spawnFollowupAgent failed:", (err as Error).message);
    }
    if (fpChatIds.length > 0) {
      const scoreStr = event.score !== undefined ? ` (score: ${event.score})` : "";
      const repoShort = repo_url.split("/").pop() ?? repo_url;
      const msg = `✓ ${event.title} done${scoreStr}\n→ spawned: ${repoShort}`;
      for (const chatId of fpChatIds) {
        try {
          await deps.sendTelegramMessage(chatId, msg);
        } catch (err) {
          log("error", "Fast path: sendTelegramMessage failed:", (err as Error).message);
        }
      }
    }
    return;
  }

  let decision: DecisionResult;
  let rawResponse = "";
  try {
    rawResponse = await deps.askClaude(buildDecisionPrompt(event, last40lines, coordinatorPlan));
    decision = parseDecision(rawResponse);
  } catch (err) {
    if (rawResponse) {
      log("error", "[cc-agent-events] Claude raw response:", rawResponse.slice(0, 200));
    }
    log("error", "Claude decision failed, falling back to NOTIFY_ONLY:", (err as Error).message);
    const fallbackMsg = event.status === "failed"
      ? formatFailureMessage(event)
      : `Job completed: ${event.title}`;
    decision = { action: "NOTIFY_ONLY", message: fallbackMsg };
  }

  log("info", `Decision: ${decision.action} for job ${event.jobId}`);

  let chatIds: number[] = [];
  try {
    chatIds = await deps.getActiveChatIds();
  } catch (err) {
    log("warn", "Failed to get active chat IDs:", (err as Error).message);
  }

  try {
    if (decision.action === "NOTIFY_ONLY") {
      if (chatIds.length === 0) {
        log("warn", "NOTIFY_ONLY: no active chat IDs, skipping notification");
        return;
      }
      const msg = decision.message
        ?? (event.status === "failed" ? formatFailureMessage(event) : `Job completed: ${event.title}`);
      for (const chatId of chatIds) {
        await deps.sendTelegramMessage(chatId, msg);
      }
    } else if (decision.action === "SPAWN_FOLLOWUP") {
      if (!decision.followup) {
        log("warn", "SPAWN_FOLLOWUP: no followup details in response");
        return;
      }
      await deps.spawnFollowupAgent(
        decision.followup.repo_url,
        decision.followup.task
      );
      // Send Telegram notification about the spawn
      if (chatIds.length > 0) {
        let runningCount = 0;
        try { runningCount = await deps.getRunningJobCount(); } catch {}
        const spawnMsg = formatSpawnMessage(event, decision.followup, runningCount);
        for (const chatId of chatIds) {
          await deps.sendTelegramMessage(chatId, spawnMsg);
        }
      }
    } else {
      // SILENT — log only
      log("info", `SILENT: no action taken for job ${event.jobId}`);
    }
  } catch (err) {
    log("error", `Action ${decision.action} failed:`, (err as Error).message);
  }
}

/** Parse flat key-value field array from a Redis Stream entry into a record. */
export function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

/** Convert stream entry fields to a JobEvent JSON string for handleJobEvent. */
export function streamEntryToMessage(fields: Record<string, string>): string | null {
  try {
    const score =
      fields["score"] !== undefined && fields["score"] !== ""
        ? Number(fields["score"])
        : undefined;
    const event: JobEvent = {
      jobId: fields["jobId"] ?? "",
      status: (fields["status"] ?? "done") as JobEvent["status"],
      title: fields["title"] ?? "",
      repoUrl: fields["repoUrl"] ?? "",
      lastLines: JSON.parse(fields["lastLines"] ?? "[]") as string[],
      score,
      timestamp: Number(fields["timestamp"] ?? Date.now()),
    };
    return JSON.stringify(event);
  } catch {
    return null;
  }
}

/**
 * Replay events from the Redis Stream that were missed since last-seen ID.
 * Uses `cca:event-stream:last-id:{botName}` in Redis to track position.
 * Exported for testability — pass a real or mock Redis instance.
 */
export async function replayStreamEvents(
  redis: Redis,
  deps: HandlerDeps,
  botName?: string
): Promise<void> {
  const name = botName ?? (process.env.CC_TG_BOT_NAME ?? "cc-tg");
  const lastIdKey = `cca:event-stream:last-id:${name}`;

  let lastId = "0";
  try {
    lastId = (await redis.get(lastIdKey)) ?? "0";
  } catch (err) {
    log("warn", "replayStreamEvents: failed to read last-id:", (err as Error).message);
  }

  type XReadResult = Array<[string, Array<[string, string[]]>]> | null;
  let results: XReadResult = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results = (await (redis as any).xread("COUNT", 20, "STREAMS", STREAM_KEY, lastId)) as XReadResult;
  } catch (err) {
    log("warn", "replayStreamEvents: xread failed:", (err as Error).message);
    return;
  }

  if (!results || results.length === 0) return;

  log("info", `Replaying missed stream events from last-id=${lastId}`);

  for (const [, entries] of results) {
    for (const [id, fields] of entries) {
      const message = streamEntryToMessage(parseStreamFields(fields));
      if (message) {
        await handleJobEvent(message, deps).catch((err: Error) => {
          log("error", `replayStreamEvents: handleJobEvent error for entry ${id}:`, err.message);
        });
      }
      try {
        await redis.set(lastIdKey, id);
      } catch (err) {
        log("warn", "replayStreamEvents: failed to update last-id:", (err as Error).message);
      }
    }
  }

  log("info", "Stream replay complete.");
}

function makeDefaultDeps(): HandlerDeps {
  return {
    askClaude: defaultAskClaude,
    sendTelegramMessage: defaultSendTelegramMessage,
    spawnFollowupAgent: defaultSpawnFollowupAgent,
    readJobOutput: defaultReadJobOutput,
    readCoordinatorPlan: defaultReadCoordinatorPlan,
    getRunningJobCount: defaultGetRunningJobCount,
    getActiveChatIds: defaultGetActiveChatIds,
  };
}

let subscriberClient: Redis | null = null;

/**
 * Connect to Redis and subscribe to cca:events.
 * Reconnects automatically on disconnect.
 * Call once at startup.
 */
export async function connectEventSubscriber(): Promise<void> {
  if (process.env.CC_AGENT_EVENTS_ENABLED === "false") {
    log("info", "CC_AGENT_EVENTS_ENABLED=false, skipping subscriber");
    return;
  }

  await connectWithBackoff(0);
}

async function connectWithBackoff(attempt: number): Promise<void> {
  const delay = Math.min(5_000 * Math.pow(2, attempt), 60_000);
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const botName = process.env.CC_TG_BOT_NAME ?? "cc-tg";
  const lastIdKey = `cca:event-stream:last-id:${botName}`;

  // Pub/sub subscriber client — enters subscriber mode after subscribe()
  const sub = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  // Regular command client — stays in normal mode for xread/get/set
  const reg = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: true,
  });

  subscriberClient = sub;

  sub.on("error", (err: Error) => {
    log("warn", "subscriber error, reconnecting...", err.message);
    try { sub.disconnect(); } catch {}
    try { reg.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(0), 5_000);
  });

  reg.on("error", (err: Error) => {
    log("warn", "regular client error (non-fatal):", err.message);
  });

  try {
    await sub.connect();
  } catch (err) {
    log("warn", `Redis connect failed (attempt ${attempt}), retrying in ${delay}ms:`, (err as Error).message);
    try { sub.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(attempt + 1), delay);
    return;
  }

  // Connect regular client (best-effort — stream replay is non-critical)
  try {
    await reg.connect();
  } catch (err) {
    log("warn", "Regular Redis client connect failed (stream replay skipped):", (err as Error).message);
  }

  const deps = makeDefaultDeps();

  // Replay events missed during downtime, then mark current time as last-id
  // Must happen BEFORE sub.subscribe() because subscribe() puts sub in subscriber mode
  try {
    await replayStreamEvents(reg, deps, botName);
  } catch (err) {
    log("warn", "Stream replay failed, continuing:", (err as Error).message);
  }
  // Mark current timestamp so next restart only replays events after now
  try {
    await reg.set(lastIdKey, `${Date.now()}-0`);
  } catch {
    // Non-fatal
  }

  sub.on("message", (channel: string, message: string) => {
    if (channel !== "cca:events") return;
    handleJobEvent(message, deps).then(() => {
      // Advance stream last-id so next restart doesn't re-replay this event
      reg.set(lastIdKey, `${Date.now()}-0`).catch(() => {});
    }).catch((err: Error) => {
      log("error", "handleJobEvent uncaught:", err.message);
    });
  });

  try {
    await sub.subscribe("cca:events");
    log("info", "Subscribed to cca:events");
  } catch (err) {
    log("warn", "subscribe failed, retrying...", (err as Error).message);
    try { sub.disconnect(); } catch {}
    try { reg.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(attempt + 1), delay);
    return;
  }

  const cleanup = async (): Promise<void> => {
    log("info", "SIGTERM received, shutting down event subscriber...");
    try {
      await sub.unsubscribe("cca:events");
      sub.disconnect();
      reg.disconnect();
    } catch {}
  };

  process.once("SIGTERM", () => { cleanup().catch(() => {}); });
}
