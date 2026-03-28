/**
 * cc-agent Redis event subscriber.
 *
 * Listens to the `cca:events` pub/sub channel for job completion events,
 * asks Claude to decide what to do, and acts accordingly:
 *   NOTIFY_ONLY    — send a Telegram message to the configured chat
 *   SPAWN_FOLLOWUP — spawn a follow-up cc-agent job via MCP
 *   SILENT         — log and do nothing
 *
 * Controlled via CC_AGENT_EVENTS_ENABLED env var (default: true).
 * Requires CC_AGENT_NOTIFY_CHAT_ID to send Telegram notifications.
 */

import { Redis } from "ioredis";
import TelegramBot from "node-telegram-bot-api";
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

export function buildDecisionPrompt(event: JobEvent): string {
  return `A cc-agent job just completed.

Job: ${event.title}
Repo: ${event.repoUrl}
Status: ${event.status}
Last output:
${event.lastLines.join("\n")}

Decide what to do next. Options:
1. NOTIFY_ONLY — send a brief Telegram message to Maksim summarizing what completed
2. SPAWN_FOLLOWUP — spawn a follow-up cc-agent job (provide repo_url and task)
3. SILENT — log it, no action needed (routine/expected completion)

Reply in this exact JSON format:
{
  "action": "NOTIFY_ONLY" | "SPAWN_FOLLOWUP" | "SILENT",
  "message": "...",
  "followup": {
    "repo_url": "...",
    "task": "..."
  }
}

Be conservative. Only SPAWN_FOLLOWUP if clearly needed. Only NOTIFY_ONLY for important completions. Use SILENT for routine jobs.`;
}

export function parseDecision(raw: string): DecisionResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in Claude response: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as DecisionResult;
  if (!["NOTIFY_ONLY", "SPAWN_FOLLOWUP", "SILENT"].includes(parsed.action)) {
    throw new Error(`Unknown action: ${parsed.action}`);
  }
  return parsed;
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

  let decision: DecisionResult;
  try {
    const rawResponse = await deps.askClaude(buildDecisionPrompt(event));
    decision = parseDecision(rawResponse);
  } catch (err) {
    log("error", "Claude decision failed:", (err as Error).message);
    return;
  }

  log("info", `Decision: ${decision.action} for job ${event.jobId}`);

  try {
    if (decision.action === "NOTIFY_ONLY") {
      const chatIdStr =
        process.env.CC_AGENT_NOTIFY_CHAT_ID;
      if (!chatIdStr) {
        log("warn", "NOTIFY_ONLY: CC_AGENT_NOTIFY_CHAT_ID not set, skipping notification");
        return;
      }
      const chatId = Number(chatIdStr);
      if (isNaN(chatId)) {
        log("warn", `NOTIFY_ONLY: invalid CC_AGENT_NOTIFY_CHAT_ID: ${chatIdStr}`);
        return;
      }
      await deps.sendTelegramMessage(
        chatId,
        decision.message ?? `Job completed: ${event.title}`
      );
    } else if (decision.action === "SPAWN_FOLLOWUP") {
      if (!decision.followup) {
        log("warn", "SPAWN_FOLLOWUP: no followup details in response");
        return;
      }
      await deps.spawnFollowupAgent(
        decision.followup.repo_url,
        decision.followup.task
      );
    } else {
      // SILENT — log only
      log("info", `SILENT: no action taken for job ${event.jobId}`);
    }
  } catch (err) {
    log("error", `Action ${decision.action} failed:`, (err as Error).message);
  }
}

function makeDefaultDeps(): HandlerDeps {
  return {
    askClaude: defaultAskClaude,
    sendTelegramMessage: defaultSendTelegramMessage,
    spawnFollowupAgent: defaultSpawnFollowupAgent,
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

  const sub = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  subscriberClient = sub;

  sub.on("error", (err: Error) => {
    log("warn", "subscriber error, reconnecting...", err.message);
    try { sub.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(0), 5_000);
  });

  try {
    await sub.connect();
  } catch (err) {
    log("warn", `Redis connect failed (attempt ${attempt}), retrying in ${delay}ms:`, (err as Error).message);
    try { sub.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(attempt + 1), delay);
    return;
  }

  const deps = makeDefaultDeps();

  sub.on("message", (channel: string, message: string) => {
    if (channel !== "cca:events") return;
    handleJobEvent(message, deps).catch((err: Error) => {
      log("error", "handleJobEvent uncaught:", err.message);
    });
  });

  try {
    await sub.subscribe("cca:events");
    log("info", "Subscribed to cca:events");
  } catch (err) {
    log("warn", "subscribe failed, retrying...", (err as Error).message);
    try { sub.disconnect(); } catch {}
    setTimeout(() => connectWithBackoff(attempt + 1), delay);
    return;
  }

  const cleanup = async (): Promise<void> => {
    log("info", "SIGTERM received, shutting down event subscriber...");
    try {
      await sub.unsubscribe("cca:events");
      sub.disconnect();
    } catch {}
  };

  process.once("SIGTERM", () => { cleanup().catch(() => {}); });
}
