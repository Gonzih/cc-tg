/**
 * Telegram bot that routes messages to/from a Claude Code subprocess.
 * One ClaudeProcess per chat_id — sessions are isolated per user.
 */

import TelegramBot from "node-telegram-bot-api";
import { existsSync, createWriteStream, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, basename, join } from "path";
import os from "os";
import { execSync, spawn } from "child_process";
import https from "https";
import http from "http";
import { ClaudeProcess, extractText, ClaudeMessage, UsageEvent } from "./claude.js";
import { transcribeVoice, isVoiceAvailable } from "./voice.js";
import { CronManager } from "./cron.js";
import { formatForTelegram, splitLongMessage } from "./formatter.js";
import { detectUsageLimit } from "./usage-limit.js";
import { getCurrentToken, rotateToken, getTokenIndex, getTokenCount } from "./tokens.js";

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Reset session and start fresh" },
  { command: "reset", description: "Reset Claude session" },
  { command: "stop", description: "Stop the current Claude task" },
  { command: "status", description: "Check if a session is active" },
  { command: "help", description: "Show all available commands" },
  { command: "cron", description: "Manage cron jobs — add/list/edit/remove/clear" },
  { command: "reload_mcp", description: "Restart the cc-agent MCP server process" },
  { command: "mcp_status", description: "Check MCP server connection status" },
  { command: "mcp_version", description: "Show cc-agent npm version and npx cache info" },
  { command: "clear_npx_cache", description: "Clear npx cache and restart MCP to pick up latest version" },
  { command: "restart", description: "Restart the bot process in-place" },
  { command: "get_file", description: "Send a file from the server to this chat" },
  { command: "cost", description: "Show session token usage and cost" },
];

export interface BotOptions {
  telegramToken: string;
  claudeToken?: string;
  cwd?: string;
  allowedUserIds?: number[];
  groupChatIds?: number[];
}

interface Session {
  claude: ClaudeProcess;
  pendingText: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;
  lastMessageId?: number;
  /** Files written by Claude tools during this turn — cleared after each result */
  writtenFiles: Set<string>;
  /** The last prompt sent to this session — used for usage-limit retries */
  currentPrompt: string;
  /** When true, prepend "✅ Claude is back!" to the next flushed response */
  isRetry: boolean;
  /** Forum topic thread_id (undefined for DMs and non-topic groups) */
  threadId?: number;
}

interface PendingRetry {
  text: string;
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
}

const FLUSH_DELAY_MS = 800; // debounce streaming chunks into one Telegram message
const TYPING_INTERVAL_MS = 4000; // re-send typing action before Telegram's 5s expiry

// Claude Sonnet 4.6 pricing (per 1M tokens)
const PRICING = {
  inputPerM: 3.00,
  outputPerM: 15.00,
  cacheReadPerM: 0.30,
  cacheWritePerM: 3.75,
};

interface SessionCost {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

function computeCostUsd(usage: UsageEvent): number {
  return (
    usage.inputTokens * PRICING.inputPerM / 1_000_000 +
    usage.outputTokens * PRICING.outputPerM / 1_000_000 +
    usage.cacheReadTokens * PRICING.cacheReadPerM / 1_000_000 +
    usage.cacheWriteTokens * PRICING.cacheWritePerM / 1_000_000
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCostReport(cost: SessionCost): string {
  const inputCost = cost.totalInputTokens * PRICING.inputPerM / 1_000_000;
  const outputCost = cost.totalOutputTokens * PRICING.outputPerM / 1_000_000;
  const cacheReadCost = cost.totalCacheReadTokens * PRICING.cacheReadPerM / 1_000_000;
  const cacheWriteCost = cost.totalCacheWriteTokens * PRICING.cacheWritePerM / 1_000_000;
  return [
    "📊 Session cost",
    `Messages: ${cost.messageCount}`,
    `Total: $${cost.totalCostUsd.toFixed(3)}`,
    `  Input: ${formatTokens(cost.totalInputTokens)} tokens ($${inputCost.toFixed(3)})`,
    `  Output: ${formatTokens(cost.totalOutputTokens)} tokens ($${outputCost.toFixed(3)})`,
    `  Cache read: ${formatTokens(cost.totalCacheReadTokens)} tokens ($${cacheReadCost.toFixed(3)})`,
    `  Cache write: ${formatTokens(cost.totalCacheWriteTokens)} tokens ($${cacheWriteCost.toFixed(3)})`,
  ].join("\n");
}

function formatCronCostFooter(usage: UsageEvent): string {
  const cost = computeCostUsd(usage);
  return `\n💰 Cron cost: $${cost.toFixed(4)} (${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out tokens)`;
}

function formatAgentCostSummary(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const totalCost = ((data.total_cost_usd ?? data.total_cost ?? 0) as number);
    const totalJobs = ((data.total_jobs ?? data.job_count ?? 0) as number);
    const byRepo = (data.by_repo ?? []) as Array<Record<string, unknown>>;
    const lines = [
      "🤖 Agent jobs (all time)",
      `Total: $${totalCost.toFixed(2)} across ${totalJobs} jobs`,
    ];
    for (const entry of byRepo) {
      const repo = (entry.repo ?? entry.repository ?? "unknown") as string;
      const cost = ((entry.cost_usd ?? entry.cost ?? 0) as number);
      const jobs = ((entry.job_count ?? entry.jobs ?? 0) as number);
      lines.push(`  ${repo}: $${cost.toFixed(2)} (${jobs} jobs)`);
    }
    return lines.join("\n");
  } catch {
    return `🤖 Agent jobs (all time)\n${text}`;
  }
}

class CostStore {
  private costs = new Map<number, SessionCost>();
  private storePath: string;

  constructor(cwd: string) {
    this.storePath = join(cwd, ".cc-tg", "costs.json");
    this.load();
  }

  get(chatId: number): SessionCost {
    let cost = this.costs.get(chatId);
    if (!cost) {
      cost = { totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: 0, messageCount: 0 };
      this.costs.set(chatId, cost);
    }
    return cost;
  }

  addUsage(chatId: number, usage: UsageEvent): void {
    const cost = this.get(chatId);
    cost.totalInputTokens += usage.inputTokens;
    cost.totalOutputTokens += usage.outputTokens;
    cost.totalCacheReadTokens += usage.cacheReadTokens;
    cost.totalCacheWriteTokens += usage.cacheWriteTokens;
    cost.totalCostUsd += computeCostUsd(usage);
    this.persist();
  }

  incrementMessages(chatId: number): void {
    const cost = this.get(chatId);
    cost.messageCount++;
    this.persist();
  }

  private persist(): void {
    try {
      const dir = join(this.storePath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: Record<string, SessionCost> = {};
      for (const [chatId, cost] of this.costs) {
        data[String(chatId)] = cost;
      }
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[costs] persist error:", (err as Error).message);
    }
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.storePath, "utf8")) as Record<string, SessionCost>;
      for (const [key, cost] of Object.entries(data)) {
        this.costs.set(Number(key), cost);
      }
      console.log(`[costs] loaded ${this.costs.size} session costs from disk`);
    } catch (err) {
      console.error("[costs] load error:", (err as Error).message);
    }
  }
}

export class CcTgBot {
  private bot: TelegramBot;
  private sessions = new Map<string, Session>();
  private pendingRetries = new Map<string, PendingRetry>();
  private opts: BotOptions;
  private cron: CronManager;
  private costStore: CostStore;
  private botUsername = "";
  private botId = 0;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.bot = new TelegramBot(opts.telegramToken, { polling: true });
    this.bot.on("message", (msg) => this.handleTelegram(msg));
    this.bot.on("polling_error", (err) => console.error("[tg]", err.message));

    this.bot.getMe().then((me) => {
      this.botUsername = me.username ?? "";
      this.botId = me.id;
      console.log(`[tg] bot identity: @${this.botUsername} (id=${this.botId})`);
    }).catch((err: Error) => console.error("[tg] getMe failed:", err.message));

    // Cron manager — fires each task into an isolated ClaudeProcess.
    // The `done` callback is passed through to runCronTask so the cron manager
    // knows when a task finishes and can allow the next tick to run.
    this.cron = new CronManager(opts.cwd ?? process.cwd(), (chatId, prompt, jobId, done) => {
      this.runCronTask(chatId, prompt, done);
    });

    this.costStore = new CostStore(opts.cwd ?? process.cwd());

    this.registerBotCommands();

    console.log("cc-tg bot started");
    console.log(`[voice] whisper available: ${isVoiceAvailable()}`);
  }

  private registerBotCommands(): void {
    this.bot.setMyCommands(BOT_COMMANDS)
      .then(() => console.log("[tg] bot commands registered"))
      .catch((err: Error) => console.error("[tg] setMyCommands failed:", err.message));
  }

  /** Session key: "chatId:threadId" for topics, "chatId:main" for DMs/non-topic groups */
  private sessionKey(chatId: number, threadId?: number): string {
    return `${chatId}:${threadId ?? 'main'}`;
  }

  /**
   * Send a message back to the correct thread (or plain chat if no thread).
   * When threadId is undefined, calls sendMessage with exactly 2 args to preserve
   * backward-compatible call signatures (no extra options object).
   */
  private replyToChat(chatId: number, text: string, threadId?: number, opts?: TelegramBot.SendMessageOptions): Promise<TelegramBot.Message> {
    if (threadId !== undefined) {
      return this.bot.sendMessage(chatId, text, { ...opts, message_thread_id: threadId } as TelegramBot.SendMessageOptions);
    }
    if (opts) {
      return this.bot.sendMessage(chatId, text, opts);
    }
    return this.bot.sendMessage(chatId, text);
  }

  /** Parse THREAD_CWD_MAP env var — maps thread name or thread_id to a CWD path */
  private getThreadCwdMap(): Record<string, string> {
    const raw = process.env.THREAD_CWD_MAP;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      console.warn('[cc-tg] THREAD_CWD_MAP is not valid JSON, ignoring');
      return {};
    }
  }

  private isAllowed(userId: number): boolean {
    if (!this.opts.allowedUserIds?.length) return true;
    return this.opts.allowedUserIds.includes(userId);
  }

  private async handleTelegram(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    // Forum topic thread_id — undefined for DMs and non-topic group messages
    const threadId = msg.message_thread_id;
    // Thread name is available on the service message that creates a new topic.
    // forum_topic_created is not in older @types/node-telegram-bot-api versions, so cast via unknown.
    const rawMsg = msg as unknown as Record<string, unknown>;
    const threadName = rawMsg.forum_topic_created
      ? (rawMsg.forum_topic_created as Record<string, unknown>).name as string | undefined
      : undefined;

    if (!this.isAllowed(userId)) {
      await this.replyToChat(chatId, "Not authorized.", threadId);
      return;
    }

    // Group chat handling
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (isGroup) {
      // If GROUP_CHAT_IDS allowlist is set, only respond in those chats
      if (this.opts.groupChatIds?.length && !this.opts.groupChatIds.includes(chatId)) {
        return;
      }
      // Only respond if: bot is @mentioned, message is a reply to the bot, or text starts with /
      const text = msg.text?.trim() ?? "";
      const isMentioned = this.botUsername && text.includes(`@${this.botUsername}`);
      const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;
      const isCommand = text.startsWith("/");
      if (!isMentioned && !isReplyToBot && !isCommand) {
        return;
      }
    }

    // Voice message — transcribe then feed as text
    if (msg.voice || msg.audio) {
      await this.handleVoice(chatId, msg, threadId, threadName);
      return;
    }

    // Photo — send as base64 image content block to Claude
    if (msg.photo?.length) {
      await this.handlePhoto(chatId, msg, threadId, threadName);
      return;
    }

    // Document — download to CWD/.cc-tg/uploads/, tell Claude the path
    if (msg.document) {
      await this.handleDocument(chatId, msg, threadId, threadName);
      return;
    }

    let text = msg.text?.trim();

    if (!text) return;

    // Strip @botname mention prefix in group chats
    if (this.botUsername) {
      text = text.replace(new RegExp(`@${this.botUsername}\\s*`, "g"), "").trim();
    }

    const sessionKey = this.sessionKey(chatId, threadId);

    // /start or /reset — kill existing session and ack
    if (text === "/start" || text === "/reset") {
      this.killSession(chatId, true, threadId);
      await this.replyToChat(chatId, "Session reset. Send a message to start.", threadId);
      return;
    }

    // /stop — kill active session (interrupt running Claude task)
    if (text === "/stop") {
      const has = this.sessions.has(sessionKey);
      this.killSession(chatId, true, threadId);
      await this.replyToChat(chatId, has ? "Stopped." : "No active session.", threadId);
      return;
    }

    // /help — list all commands
    if (text === "/help") {
      const lines = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
      await this.replyToChat(chatId, lines.join("\n"), threadId);
      return;
    }

    // /status
    if (text === "/status") {
      const has = this.sessions.has(sessionKey);
      let status = has ? "Session active." : "No active session.";
      const sleeping = this.pendingRetries.size;
      if (sleeping > 0) status += `\n⏸ ${sleeping} request(s) sleeping (usage limit).`;
      await this.replyToChat(chatId, status, threadId);
      return;
    }

    // /cron <schedule> <prompt> | /cron list | /cron clear | /cron remove <id>
    if (text.startsWith("/cron")) {
      await this.handleCron(chatId, text, threadId);
      return;
    }

    // /reload_mcp — kill cc-agent process so Claude Code auto-restarts it
    if (text === "/reload_mcp") {
      await this.handleReloadMcp(chatId, threadId);
      return;
    }

    // /mcp_status — run `claude mcp list` and show connection status
    if (text === "/mcp_status") {
      await this.handleMcpStatus(chatId, threadId);
      return;
    }

    // /mcp_version — show published npm version and cached npx entries
    if (text === "/mcp_version") {
      await this.handleMcpVersion(chatId, threadId);
      return;
    }

    // /clear_npx_cache — wipe ~/.npm/_npx/ then restart cc-agent
    if (text === "/clear_npx_cache") {
      await this.handleClearNpxCache(chatId, threadId);
      return;
    }

    // /restart — restart the bot process in-place
    if (text === "/restart") {
      await this.handleRestart(chatId, threadId);
      return;
    }

    // /get_file <path> — send a file from the server to the user
    if (text.startsWith("/get_file")) {
      await this.handleGetFile(chatId, text, threadId);
      return;
    }

    // /cost — show session token usage and cost
    if (text === "/cost") {
      const cost = this.costStore.get(chatId);
      let reply = formatCostReport(cost);
      try {
        const rawSummary = await this.callCcAgentTool("cost_summary");
        if (rawSummary) {
          reply += "\n\n" + formatAgentCostSummary(rawSummary);
        }
      } catch (err) {
        console.error("[cost] cc-agent cost_summary failed:", (err as Error).message);
      }
      await this.replyToChat(chatId, reply, threadId);
      return;
    }

    const session = this.getOrCreateSession(chatId, threadId, threadName);
    try {
      const prompt = buildPromptWithReplyContext(text, msg);
      session.currentPrompt = prompt;
      session.claude.sendPrompt(prompt);
      this.startTyping(chatId, session);
    } catch (err) {
      await this.replyToChat(chatId, `Error sending to Claude: ${(err as Error).message}`, threadId);
      this.killSession(chatId, true, threadId);
    }
  }

  private async handleVoice(chatId: number, msg: TelegramBot.Message, threadId?: number, threadName?: string): Promise<void> {
    const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
    if (!fileId) return;

    console.log(`[voice:${chatId}] received voice message, transcribing...`);
    this.bot.sendChatAction(chatId, "typing", threadId !== undefined ? { message_thread_id: threadId } : undefined).catch(() => {});

    try {
      const fileLink = await this.bot.getFileLink(fileId);
      const transcript = await transcribeVoice(fileLink);
      console.log(`[voice:${chatId}] transcribed: ${transcript}`);

      if (!transcript || transcript === "[empty transcription]") {
        await this.replyToChat(chatId, "Could not transcribe voice message.", threadId);
        return;
      }

      // Feed transcript into Claude as if user typed it
      const session = this.getOrCreateSession(chatId, threadId, threadName);
      try {
        const prompt = buildPromptWithReplyContext(transcript, msg);
        session.currentPrompt = prompt;
        session.claude.sendPrompt(prompt);
        this.startTyping(chatId, session);
      } catch (err) {
        await this.replyToChat(chatId, `Error sending to Claude: ${(err as Error).message}`, threadId);
        this.killSession(chatId, true, threadId);
      }
    } catch (err) {
      console.error(`[voice:${chatId}] error:`, (err as Error).message);
      await this.replyToChat(chatId, `Voice transcription failed: ${(err as Error).message}`, threadId);
    }
  }

  private async handlePhoto(chatId: number, msg: TelegramBot.Message, threadId?: number, threadName?: string): Promise<void> {
    // Pick highest resolution photo
    const photos = msg.photo!;
    const best = photos[photos.length - 1];
    const caption = msg.caption?.trim();

    console.log(`[photo:${chatId}] received image file_id=${best.file_id}`);
    this.bot.sendChatAction(chatId, "typing", threadId !== undefined ? { message_thread_id: threadId } : undefined).catch(() => {});

    try {
      const fileLink = await this.bot.getFileLink(best.file_id);
      const imageData = await fetchAsBase64(fileLink);
      // Telegram photos are always JPEG
      const session = this.getOrCreateSession(chatId, threadId, threadName);
      session.claude.sendImage(imageData, "image/jpeg", caption);
      this.startTyping(chatId, session);
    } catch (err) {
      console.error(`[photo:${chatId}] error:`, (err as Error).message);
      await this.replyToChat(chatId, `Failed to process image: ${(err as Error).message}`, threadId);
    }
  }

  private async handleDocument(chatId: number, msg: TelegramBot.Message, threadId?: number, threadName?: string): Promise<void> {
    const doc = msg.document!;
    const caption = msg.caption?.trim();
    const fileName = doc.file_name ?? `file_${doc.file_id}`;

    console.log(`[doc:${chatId}] received document file_name=${fileName} mime=${doc.mime_type}`);
    this.bot.sendChatAction(chatId, "typing", threadId !== undefined ? { message_thread_id: threadId } : undefined).catch(() => {});

    try {
      const uploadsDir = join(this.opts.cwd ?? process.cwd(), ".cc-tg", "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const destPath = join(uploadsDir, fileName);

      const fileLink = await this.bot.getFileLink(doc.file_id);
      await downloadToFile(fileLink, destPath);

      console.log(`[doc:${chatId}] saved to ${destPath}`);

      const prompt = caption
        ? `${caption}\n\nATTACHMENTS: [${fileName}](${destPath})`
        : `ATTACHMENTS: [${fileName}](${destPath})`;

      const session = this.getOrCreateSession(chatId, threadId, threadName);
      session.claude.sendPrompt(prompt);
      this.startTyping(chatId, session);
    } catch (err) {
      console.error(`[doc:${chatId}] error:`, (err as Error).message);
      await this.replyToChat(chatId, `Failed to receive document: ${(err as Error).message}`, threadId);
    }
  }

  private getOrCreateSession(chatId: number, threadId?: number, threadName?: string): Session {
    const key = this.sessionKey(chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing && !existing.claude.exited) return existing;

    // Determine CWD for this thread — check THREAD_CWD_MAP by name then by ID
    let sessionCwd = this.opts.cwd;
    const threadCwdMap = this.getThreadCwdMap();
    if (threadName && threadCwdMap[threadName]) {
      sessionCwd = threadCwdMap[threadName];
      console.log(`[cc-tg] thread "${threadName}" → cwd: ${sessionCwd}`);
    } else if (threadId !== undefined && threadCwdMap[String(threadId)]) {
      sessionCwd = threadCwdMap[String(threadId)];
      console.log(`[cc-tg] thread ${threadId} → cwd: ${sessionCwd}`);
    }

    const claude = new ClaudeProcess({
      cwd: sessionCwd,
      token: getCurrentToken() || this.opts.claudeToken,
    });

    const session: Session = {
      claude,
      pendingText: "",
      flushTimer: null,
      typingTimer: null,
      writtenFiles: new Set(),
      currentPrompt: "",
      isRetry: false,
      threadId,
    };

    claude.on("usage", (usage: UsageEvent) => {
      this.costStore.addUsage(chatId, usage);
    });

    claude.on("message", (msg) => {
      // Verbose logging — log every message type and subtype
      const subtype = (msg.payload.subtype as string) ?? "";
      const toolName = this.extractToolName(msg);
      const logParts = [`[claude:${key}] msg=${msg.type}`];
      if (subtype) logParts.push(`subtype=${subtype}`);
      if (toolName) logParts.push(`tool=${toolName}`);
      console.log(logParts.join(" "));

      // Track files written by Write/Edit tool calls
      this.trackWrittenFiles(msg, session, sessionCwd);

      this.handleClaudeMessage(chatId, session, msg);
    });
    claude.on("stderr", (data) => {
      const line = data.trim();
      if (line) console.error(`[claude:${key}:stderr]`, line);
    });
    claude.on("exit", (code) => {
      console.log(`[claude:${key}] exited code=${code}`);
      this.stopTyping(session);
      this.sessions.delete(key);
    });
    claude.on("error", (err) => {
      console.error(`[claude:${key}] process error: ${err.message}`);
      this.bot.sendMessage(chatId, `Claude process error: ${err.message}`).catch(() => {});
      this.stopTyping(session);
      this.sessions.delete(key);
    });

    this.sessions.set(key, session);
    return session;
  }

  private handleClaudeMessage(chatId: number, session: Session, msg: ClaudeMessage): void {
    // Use only the final `result` message — it contains the complete response text.
    // Ignore `assistant` streaming chunks to avoid duplicates.
    if (msg.type !== "result") return;

    this.stopTyping(session);
    this.costStore.incrementMessages(chatId);

    const text = extractText(msg);
    if (!text) return;

    // Check for usage/rate limit signals before forwarding to Telegram
    const sig = detectUsageLimit(text);
    if (sig.detected) {
      const threadId = session.threadId;
      const retryKey = this.sessionKey(chatId, threadId);
      const lastPrompt = session.currentPrompt;
      const prevRetry = this.pendingRetries.get(retryKey);
      const attempt = (prevRetry?.attempt ?? 0) + 1;

      if (prevRetry) clearTimeout(prevRetry.timer);

      this.replyToChat(chatId, sig.humanMessage, threadId).catch(() => {});
      this.killSession(chatId, true, threadId);

      // Token rotation: if this is a usage_exhausted signal and we have multiple
      // tokens, rotate to the next one and retry immediately instead of sleeping.
      // Only rotate if we haven't yet cycled through all tokens (attempt <= count-1).
      if (sig.reason === "usage_exhausted" && getTokenCount() > 1 && attempt <= getTokenCount() - 1) {
        const prevIdx = getTokenIndex();
        rotateToken();
        const newIdx = getTokenIndex();
        const total = getTokenCount();
        console.log(`[cc-tg] Token ${prevIdx + 1}/${total} exhausted, rotating to token ${newIdx + 1}/${total}`);
        this.replyToChat(chatId, `🔄 Token ${prevIdx + 1}/${total} exhausted, switching to token ${newIdx + 1}/${total}...`, threadId).catch(() => {});

        this.pendingRetries.set(retryKey, { text: lastPrompt, attempt, timer: setTimeout(() => {}, 0) });
        try {
          const retrySession = this.getOrCreateSession(chatId, threadId);
          retrySession.currentPrompt = lastPrompt;
          retrySession.isRetry = true;
          retrySession.claude.sendPrompt(lastPrompt);
          this.startTyping(chatId, retrySession);
        } catch (err) {
          this.replyToChat(chatId, `❌ Failed to retry with rotated token: ${(err as Error).message}`, threadId).catch(() => {});
        }
        return;
      }

      if (attempt > 3) {
        this.replyToChat(chatId, "❌ Claude usage limit persists after 3 retries. Please try again later.", threadId).catch(() => {});
        this.pendingRetries.delete(retryKey);
        return;
      }

      console.log(`[usage-limit:${retryKey}] ${sig.reason} — scheduling retry attempt=${attempt} in ${sig.retryAfterMs}ms`);
      const timer = setTimeout(() => {
        this.pendingRetries.delete(retryKey);
        try {
          const retrySession = this.getOrCreateSession(chatId, threadId);
          retrySession.currentPrompt = lastPrompt;
          retrySession.isRetry = true;
          retrySession.claude.sendPrompt(lastPrompt);
          this.startTyping(chatId, retrySession);
        } catch (err) {
          this.replyToChat(chatId, `❌ Failed to retry: ${(err as Error).message}`, threadId).catch(() => {});
        }
      }, sig.retryAfterMs);

      this.pendingRetries.set(retryKey, { text: lastPrompt, attempt, timer });
      return;
    }

    // Accumulate text and debounce — Claude streams chunks rapidly
    session.pendingText += text;

    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = setTimeout(() => this.flushPending(chatId, session), FLUSH_DELAY_MS);
  }

  private startTyping(chatId: number, session: Session): void {
    this.stopTyping(session);
    // Send immediately, then keep alive every 4s
    // Pass message_thread_id so typing appears in the correct forum topic thread
    const threadOpts = session.threadId !== undefined ? { message_thread_id: session.threadId } : undefined;
    this.bot.sendChatAction(chatId, "typing", threadOpts).catch(() => {});
    session.typingTimer = setInterval(() => {
      this.bot.sendChatAction(chatId, "typing", threadOpts).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private stopTyping(session: Session): void {
    if (session.typingTimer) {
      clearInterval(session.typingTimer);
      session.typingTimer = null;
    }
  }

  private flushPending(chatId: number, session: Session): void {
    const raw = session.pendingText.trim();
    session.pendingText = "";
    session.flushTimer = null;
    if (!raw) return;

    const text = session.isRetry ? `✅ Claude is back!\n\n${raw}` : raw;
    session.isRetry = false;

    // Format for Telegram HTML and split if needed (max 4096 chars)
    const formatted = formatForTelegram(text);
    const chunks = splitLongMessage(formatted);
    const threadId = session.threadId;
    for (const chunk of chunks) {
      this.replyToChat(chatId, chunk, threadId, { parse_mode: "HTML" }).catch(() => {
        // HTML parse failed — retry as plain text
        this.replyToChat(chatId, chunk, threadId).catch((err) =>
          console.error(`[tg:${chatId}] send failed:`, err.message)
        );
      });
    }

    // Hybrid file upload: find files mentioned in result text that Claude actually wrote
    try {
      this.uploadMentionedFiles(chatId, text, session);
    } catch (err) {
      console.error(`[tg:${chatId}] uploadMentionedFiles error:`, (err as Error).message);
    }
  }

  private trackWrittenFiles(msg: ClaudeMessage, session: Session, cwd?: string): void {
    // Only look at assistant messages with tool_use blocks
    if (msg.type !== "assistant") return;
    const message = msg.payload.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== "tool_use") continue;
      const name = block.name as string;
      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;

      if (["Write", "Edit", "NotebookEdit"].includes(name)) {
        // Write tool uses file_path, Edit uses file_path
        const filePath = (input.file_path as string) ?? (input.path as string);
        if (!filePath) continue;

        // Resolve relative paths against cwd
        const resolved = filePath.startsWith("/")
          ? filePath
          : resolve(cwd ?? process.cwd(), filePath);

        console.log(`[claude:files] tracked written file: ${resolved}`);
        session.writtenFiles.add(resolved);
      } else if (name === "Bash") {
        const cmd = (input.command as string) ?? "";
        if (/\byt-dlp\b|\bffmpeg\b/.test(cmd)) {
          // Scan output dir for recently modified media files (template paths like /tmp/%(title)s.%(ext)s
          // make the actual filename unknowable at tracking time)
          const oFlagMatch = cmd.match(/-o\s+["']?([^\s"']+)/);
          let scanDir = "/tmp/";
          if (oFlagMatch) {
            const oPath = oFlagMatch[1].replace(/["'].*$/, "");
            const dirEnd = oPath.lastIndexOf("/");
            if (dirEnd > 0) scanDir = oPath.slice(0, dirEnd + 1);
          }
          const MEDIA_EXTS = new Set([".mp3", ".mp4", ".wav", ".ogg", ".flac", ".webm", ".m4a", ".aac"]);
          const nowMs = Date.now();
          try {
            for (const entry of readdirSync(scanDir)) {
              const dotIdx = entry.lastIndexOf(".");
              if (dotIdx < 0) continue;
              const ext = entry.slice(dotIdx).toLowerCase();
              if (!MEDIA_EXTS.has(ext)) continue;
              const full = join(scanDir, entry);
              try {
                if (nowMs - statSync(full).mtimeMs <= 90_000) {
                  console.log(`[claude:files] tracked yt-dlp/ffmpeg output: ${full}`);
                  session.writtenFiles.add(full);
                }
              } catch { /* skip unreadable entries */ }
            }
          } catch { /* scanDir doesn't exist or unreadable */ }
        } else {
          // Other bash commands: try to extract output path from -o flag
          const oFlag = cmd.match(/-o\s+["']?([^\s"']+\.[\w]{1,10})["']?/);
          if (oFlag) session.writtenFiles.add(resolve(cwd ?? process.cwd(), oFlag[1]));
        }
        // mv source dest — track dest
        const mvMatch = cmd.match(/\bmv\s+\S+\s+["']?([^\s"']+)["']?$/);
        if (mvMatch) session.writtenFiles.add(resolve(cwd ?? process.cwd(), mvMatch[1]));
        // cp source dest — track dest
        const cpMatch = cmd.match(/\bcp\s+\S+\s+["']?([^\s"']+)["']?$/);
        if (cpMatch) session.writtenFiles.add(resolve(cwd ?? process.cwd(), cpMatch[1]));
        // curl -o path or wget -O path
        const curlMatch = cmd.match(/curl\s+.*?-o\s+["']?([^\s"']+)["']?/);
        if (curlMatch) session.writtenFiles.add(resolve(cwd ?? process.cwd(), curlMatch[1]));
        // wget -O path
        const wgetMatch = cmd.match(/wget\s+.*?-O\s+["']?([^\s"']+)["']?/);
        if (wgetMatch) session.writtenFiles.add(resolve(cwd ?? process.cwd(), wgetMatch[1]));
      }
    }
  }

  private isSensitiveFile(filePath: string): boolean {
    const name = basename(filePath).toLowerCase();
    const sensitivePatterns = [
      /credential/i, /secret/i, /password/i, /passwd/i, /\.env/i,
      /api[_-]?key/i, /token/i, /private[_-]?key/i, /id_rsa/i,
      /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i,
      /gmail/i, /oauth/i, /\bauth\b/i,
    ];
    return sensitivePatterns.some((p) => p.test(name));
  }

  private uploadMentionedFiles(chatId: number, resultText: string, session: Session): void {
    // Extract file path candidates from result text
    // Match: /absolute/path/file.ext or relative like ./foo/bar.csv or just foo.pdf
    const pathPattern = /(?:^|[\s`'"(])(\/?[\w.\-/]+\.[\w]{1,10})(?:[\s`'")\n]|$)/gm;
    const quotedPattern = /"([^"]+\.[a-zA-Z0-9]{1,10})"|'([^']+\.[a-zA-Z0-9]{1,10})'/g;
    const candidates = new Set<string>();
    let match;
    while ((match = pathPattern.exec(resultText)) !== null) {
      candidates.add(match[1]);
    }
    while ((match = quotedPattern.exec(resultText)) !== null) {
      candidates.add(match[1] ?? match[2]);
    }

    const safeDirs = ["/tmp/", "/var/folders/", os.homedir() + "/Downloads/"];
    const isSafeDir = (p: string) =>
      safeDirs.some(d => p.startsWith(d)) || p.startsWith(this.opts.cwd ?? process.cwd());

    const toUpload: string[] = [];

    if (session.writtenFiles.size > 0) {
      for (const candidate of candidates) {
        // Try as-is (absolute), or resolve against cwd
        const resolved = candidate.startsWith("/")
          ? candidate
          : resolve(this.opts.cwd ?? process.cwd(), candidate);

        if (session.writtenFiles.has(resolved) && existsSync(resolved)) {
          toUpload.push(resolved);
        } else {
          // Also check by basename — result might mention just the filename
          for (const written of session.writtenFiles) {
            if (basename(written) === basename(candidate) && existsSync(written)) {
              toUpload.push(written);
              break;
            }
          }
        }
      }
    }

    // Also upload files mentioned in result text that exist in safe dirs
    // even if not tracked via Write tool
    for (const candidate of candidates) {
      const resolved = candidate.startsWith("/")
        ? candidate
        : resolve(this.opts.cwd ?? process.cwd(), candidate);
      if (existsSync(resolved) && isSafeDir(resolved) && !toUpload.includes(resolved)) {
        toUpload.push(resolved);
      }
    }

    // Deduplicate and filter sensitive files
    const unique = [...new Set(toUpload)];
    for (const filePath of unique) {
      if (this.isSensitiveFile(filePath)) {
        console.log(`[claude:files] skipping sensitive file: ${filePath}`);
        continue;
      }
      let fileSize: number;
      try {
        fileSize = statSync(filePath).size;
      } catch {
        continue; // file disappeared between existsSync and statSync
      }
      const MAX_TG_FILE_BYTES = 50 * 1024 * 1024;
      if (fileSize > MAX_TG_FILE_BYTES) {
        const mb = (fileSize / (1024 * 1024)).toFixed(1);
        this.replyToChat(chatId, `File too large for Telegram (${mb}mb). Find it at: ${filePath}`, session.threadId).catch(() => {});
        continue;
      }
      console.log(`[claude:files] uploading to telegram: ${filePath}`);
      const docOpts = session.threadId ? { message_thread_id: session.threadId } as TelegramBot.SendDocumentOptions : undefined;
      this.bot.sendDocument(chatId, filePath, docOpts).catch((err) =>
        console.error(`[tg:${chatId}] sendDocument failed for ${filePath}:`, err.message)
      );
    }

    // Clear written files for next turn
    session.writtenFiles.clear();
  }

  private extractToolName(msg: ClaudeMessage): string {
    const message = msg.payload.message as Record<string, unknown> | undefined;
    if (!message) return "";
    const content = message.content;
    if (!Array.isArray(content)) return "";
    const toolUse = content.find((b: Record<string, unknown>) => b.type === "tool_use") as Record<string, unknown> | undefined;
    return (toolUse?.name as string) ?? "";
  }

  private runCronTask(chatId: number, prompt: string, done: () => void = () => {}): void {
    // Fresh isolated Claude session — never touches main conversation
    const cronProcess = new ClaudeProcess({
      cwd: this.opts.cwd,
      token: this.opts.claudeToken,
    });

    const taskPrompt = [
      "You are handling a scheduled background task.",
      "This is NOT part of the user's ongoing conversation.",
      "Be concise. Report results only. No greetings or pleasantries.",
      "If there is nothing to report, say so in one sentence.",
      "DEDUP RULE: If this task involves resuming or restarting interrupted agents/jobs,",
      "  skip any job whose task description already starts with 'RESUMING' (it is already",
      "  a resume attempt). Also skip any job that has a non-empty 'resumed_by' field.",
      "  Only spawn a resume agent for a job if resume_count < 2 (when that field exists).",
      "  This prevents exponential job growth when a cron re-discovers its own spawned agents.",
      "",
      `SCHEDULED TASK: ${prompt}`,
    ].join("\n");

    let output = "";
    const cronUsage: UsageEvent = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    cronProcess.on("usage", (usage: UsageEvent) => {
      cronUsage.inputTokens += usage.inputTokens;
      cronUsage.outputTokens += usage.outputTokens;
      cronUsage.cacheReadTokens += usage.cacheReadTokens;
      cronUsage.cacheWriteTokens += usage.cacheWriteTokens;
    });

    cronProcess.on("message", (msg: ClaudeMessage) => {
      if (msg.type === "result") {
        const text = extractText(msg);
        if (text) output += text;

        const result = output.trim();
        if (result) {
          let footer = "";
          try {
            footer = formatCronCostFooter(cronUsage);
          } catch (err) {
            console.error(`[cron] cost footer error:`, (err as Error).message);
          }
          const cronFormatted = formatForTelegram(`🕐 ${result}${footer}`);
          const chunks = splitLongMessage(cronFormatted);
          (async () => {
            for (const chunk of chunks) {
              try {
                await this.bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });
              } catch {
                // HTML parse failed — retry as plain text
                try {
                  await this.bot.sendMessage(chatId, chunk);
                } catch (err) {
                  console.error(`[cron] failed to send result to chat=${chatId}:`, (err as Error).message);
                }
              }
            }
          })();
        }

        cronProcess.kill();
      }
    });

    cronProcess.on("error", (err: Error) => {
      console.error(`[cron] task error for chat=${chatId}:`, err.message);
      cronProcess.kill();
      done();
    });

    cronProcess.on("exit", () => {
      console.log(`[cron] task complete for chat=${chatId}`);
      done();
    });

    cronProcess.sendPrompt(taskPrompt);
  }

  private async handleCron(chatId: number, text: string, threadId?: number): Promise<void> {
    const args = text.slice("/cron".length).trim();

    // /cron list
    if (args === "list" || args === "") {
      const jobs = this.cron.list(chatId);
      if (!jobs.length) {
        await this.replyToChat(chatId, "No cron jobs.", threadId);
        return;
      }
      const lines = jobs.map((j, i) => {
        const short = j.prompt.length > 50 ? j.prompt.slice(0, 50) + "…" : j.prompt;
        return `#${i + 1} ${j.schedule} — "${short}"`;
      });
      await this.replyToChat(chatId, `Cron jobs (${jobs.length}):\n${lines.join("\n")}`, threadId);
      return;
    }

    // /cron clear
    if (args === "clear") {
      const n = this.cron.clearAll(chatId);
      await this.replyToChat(chatId, `Cleared ${n} cron job(s).`, threadId);
      return;
    }

    // /cron remove <id>
    if (args.startsWith("remove ")) {
      const id = args.slice("remove ".length).trim();
      const ok = this.cron.remove(chatId, id);
      await this.replyToChat(chatId, ok ? `Removed ${id}.` : `Not found: ${id}`, threadId);
      return;
    }

    // /cron edit [<#> ...]
    if (args === "edit" || args.startsWith("edit ")) {
      await this.handleCronEdit(chatId, args.slice("edit".length).trim(), threadId);
      return;
    }

    // /cron every 1h <prompt>
    const scheduleMatch = args.match(/^(every\s+\d+[mhd])\s+(.+)$/i);
    if (!scheduleMatch) {
      await this.replyToChat(
        chatId,
        "Usage:\n/cron every 1h <prompt>\n/cron list\n/cron edit\n/cron remove <id>\n/cron clear",
        threadId
      );
      return;
    }

    const schedule = scheduleMatch[1];
    const prompt = scheduleMatch[2];
    const job = this.cron.add(chatId, schedule, prompt);
    if (!job) {
      await this.replyToChat(chatId, "Invalid schedule. Use: every 30m / every 2h / every 1d", threadId);
      return;
    }
    await this.replyToChat(chatId, `Cron set [${job.id}]: ${schedule} — "${prompt}"`, threadId);
  }

  private async handleCronEdit(chatId: number, editArgs: string, threadId?: number): Promise<void> {
    const jobs = this.cron.list(chatId);

    // No args — show numbered list with edit instructions
    if (!editArgs) {
      if (!jobs.length) {
        await this.replyToChat(chatId, "No cron jobs to edit.", threadId);
        return;
      }
      const lines = jobs.map((j, i) => {
        const short = j.prompt.length > 50 ? j.prompt.slice(0, 50) + "…" : j.prompt;
        return `#${i + 1} ${j.schedule} — "${short}"`;
      });
      await this.replyToChat(
        chatId,
        `Cron jobs:\n${lines.join("\n")}\n\n` +
        "Edit options:\n" +
        "/cron edit <#> every <N><unit> <new prompt>\n" +
        "/cron edit <#> schedule every <N><unit>\n" +
        "/cron edit <#> prompt <new prompt>",
        threadId
      );
      return;
    }

    // Expect: <index> <rest>
    const indexMatch = editArgs.match(/^(\d+)\s+(.+)$/);
    if (!indexMatch) {
      await this.replyToChat(chatId, "Usage: /cron edit <#> every <N><unit> <new prompt>", threadId);
      return;
    }

    const index = parseInt(indexMatch[1], 10) - 1;
    if (index < 0 || index >= jobs.length) {
      await this.replyToChat(chatId, `Invalid job number. Use /cron edit to see the list.`, threadId);
      return;
    }

    const job = jobs[index];
    const editCmd = indexMatch[2];

    // /cron edit <#> schedule every <N><unit>
    if (editCmd.startsWith("schedule ")) {
      const newSchedule = editCmd.slice("schedule ".length).trim();
      const result = this.cron.update(chatId, job.id, { schedule: newSchedule });
      if (result === null) {
        await this.replyToChat(chatId, "Invalid schedule. Use: every 30m / every 2h / every 1d", threadId);
      } else if (result === false) {
        await this.replyToChat(chatId, "Job not found.", threadId);
      } else {
        await this.replyToChat(chatId, `#${index + 1} schedule updated to ${newSchedule}.`, threadId);
      }
      return;
    }

    // /cron edit <#> prompt <new-prompt>
    if (editCmd.startsWith("prompt ")) {
      const newPrompt = editCmd.slice("prompt ".length).trim();
      const result = this.cron.update(chatId, job.id, { prompt: newPrompt });
      if (result === false) {
        await this.replyToChat(chatId, "Job not found.", threadId);
      } else {
        await this.replyToChat(chatId, `#${index + 1} prompt updated to "${newPrompt}".`, threadId);
      }
      return;
    }

    // /cron edit <#> every <N><unit> <new-prompt>
    const fullMatch = editCmd.match(/^(every\s+\d+[mhd])\s+(.+)$/i);
    if (fullMatch) {
      const newSchedule = fullMatch[1];
      const newPrompt = fullMatch[2];
      const result = this.cron.update(chatId, job.id, { schedule: newSchedule, prompt: newPrompt });
      if (result === null) {
        await this.replyToChat(chatId, "Invalid schedule. Use: every 30m / every 2h / every 1d", threadId);
      } else if (result === false) {
        await this.replyToChat(chatId, "Job not found.", threadId);
      } else {
        await this.replyToChat(chatId, `#${index + 1} updated: ${newSchedule} — "${newPrompt}"`, threadId);
      }
      return;
    }

    await this.replyToChat(
      chatId,
      "Edit options:\n" +
      "/cron edit <#> every <N><unit> <new prompt>\n" +
      "/cron edit <#> schedule every <N><unit>\n" +
      "/cron edit <#> prompt <new prompt>",
      threadId
    );
  }

  /** Find cc-agent PIDs via pgrep. Returns array of numeric PIDs. */
  private findCcAgentPids(): number[] {
    try {
      const out = execSync("pgrep -f cc-agent", { encoding: "utf8" }).trim();
      return out.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
    } catch {
      // pgrep exits with code 1 when no match — that's fine
      return [];
    }
  }

  /** Kill cc-agent PIDs with SIGTERM. Returns the list of killed PIDs. */
  private killCcAgent(): number[] {
    const pids = this.findCcAgentPids();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[mcp] sent SIGTERM to cc-agent pid=${pid}`);
      } catch (err) {
        console.warn(`[mcp] failed to kill pid=${pid}:`, (err as Error).message);
      }
    }
    return pids;
  }

  private async handleReloadMcp(chatId: number, threadId?: number): Promise<void> {
    await this.replyToChat(chatId, "Clearing npx cache and reloading MCP...", threadId);

    try {
      const home = process.env.HOME ?? "~";
      execSync(`rm -rf "${home}/.npm/_npx/"`, { encoding: "utf8", shell: "/bin/sh" });
      console.log("[mcp] cleared ~/.npm/_npx/");
    } catch (err) {
      await this.replyToChat(chatId, `Warning: failed to clear npx cache: ${(err as Error).message}`, threadId);
    }

    const pids = this.killCcAgent();
    if (pids.length === 0) {
      await this.replyToChat(chatId, "NPX cache cleared. No cc-agent process found — MCP will start fresh on the next agent call.", threadId);
      return;
    }
    await this.replyToChat(
      chatId,
      `NPX cache cleared. Sent SIGTERM to cc-agent (pid${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}).\nMCP restarted. New process will load on next agent call.`,
      threadId
    );
  }

  private async handleMcpStatus(chatId: number, threadId?: number): Promise<void> {
    try {
      const output = execSync("claude mcp list", { encoding: "utf8", shell: "/bin/sh" }).trim();
      await this.replyToChat(chatId, `MCP server status:\n\n${output || "(no output)"}`, threadId);
    } catch (err) {
      await this.replyToChat(chatId, `Failed to run claude mcp list: ${(err as Error).message}`, threadId);
    }
  }

  private async handleMcpVersion(chatId: number, threadId?: number): Promise<void> {
    let npmVersion = "unknown";
    let cacheEntries = "(unavailable)";

    try {
      npmVersion = execSync("npm view @gonzih/cc-agent version", { encoding: "utf8" }).trim();
    } catch (err) {
      npmVersion = `error: ${(err as Error).message.split("\n")[0]}`;
    }

    try {
      const home = process.env.HOME ?? "~";
      const cacheOut = execSync(`ls "${home}/.npm/_npx/" 2>/dev/null | head -5`, { encoding: "utf8", shell: "/bin/sh" }).trim();
      cacheEntries = cacheOut || "(empty)";
    } catch {
      cacheEntries = "(empty or not found)";
    }

    await this.replyToChat(
      chatId,
      `cc-agent npm version: ${npmVersion}\n\nnpx cache (~/.npm/_npx/):\n${cacheEntries}`,
      threadId
    );
  }

  private async handleClearNpxCache(chatId: number, threadId?: number): Promise<void> {
    const home = process.env.HOME ?? "/tmp";
    const cleared: string[] = [];
    const failed: string[] = [];

    // Clear both npx execution cache and full npm package cache
    for (const dir of [`${home}/.npm/_npx`, `${home}/.npm/cache`]) {
      try {
        execSync(`rm -rf "${dir}"`, { encoding: "utf8", shell: "/bin/sh" });
        cleared.push(dir.replace(home, "~"));
        console.log(`[cache] cleared ${dir}`);
      } catch (err) {
        failed.push(dir.replace(home, "~"));
        console.warn(`[cache] failed to clear ${dir}:`, (err as Error).message);
      }
    }

    const pids = this.killCcAgent();
    const pidNote = pids.length > 0
      ? ` Sent SIGTERM to cc-agent pid${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}.`
      : " No cc-agent running.";

    const clearNote = failed.length
      ? `Cleared: ${cleared.join(", ")}. Failed: ${failed.join(", ")}.`
      : `Cleared: ${cleared.join(", ")}.`;

    await this.replyToChat(chatId, `${clearNote}${pidNote} Next call picks up latest npm version.`, threadId);
  }

  private async handleRestart(chatId: number, threadId?: number): Promise<void> {
    await this.replyToChat(chatId, "Clearing cache and restarting... brb.", threadId);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Clear npm caches before restart so launchd brings up fresh version
    const home = process.env.HOME ?? "/tmp";
    for (const dir of [`${home}/.npm/_npx`, `${home}/.npm/cache`]) {
      try { execSync(`rm -rf "${dir}"`, { shell: "/bin/sh" }); } catch {}
    }

    // Kill all active Claude sessions cleanly
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      session.claude.kill();
    }
    this.sessions.clear();

    await new Promise(resolve => setTimeout(resolve, 200));
    process.exit(0);
  }

  private async handleGetFile(chatId: number, text: string, threadId?: number): Promise<void> {
    const arg = text.slice("/get_file".length).trim();
    if (!arg) {
      await this.replyToChat(chatId, "Usage: /get_file <path>", threadId);
      return;
    }

    const filePath = resolve(arg);

    const safeDirs = ["/tmp/", "/var/folders/", os.homedir() + "/Downloads/", this.opts.cwd ?? process.cwd()];
    const inSafeDir = safeDirs.some(d => filePath.startsWith(d));
    if (!inSafeDir) {
      await this.replyToChat(chatId, "Access denied: path not in allowed directories", threadId);
      return;
    }

    if (!existsSync(filePath)) {
      await this.replyToChat(chatId, `File not found: ${filePath}`, threadId);
      return;
    }

    if (!statSync(filePath).isFile()) {
      await this.replyToChat(chatId, `Not a file: ${filePath}`, threadId);
      return;
    }

    if (this.isSensitiveFile(filePath)) {
      await this.replyToChat(chatId, "Access denied: sensitive file", threadId);
      return;
    }

    const MAX_TG_FILE_BYTES = 50 * 1024 * 1024;
    const fileSize = statSync(filePath).size;
    if (fileSize > MAX_TG_FILE_BYTES) {
      const mb = (fileSize / (1024 * 1024)).toFixed(1);
      await this.replyToChat(chatId, `File too large for Telegram (${mb}mb). Find it at: ${filePath}`, threadId);
      return;
    }

    const docOpts = threadId ? { message_thread_id: threadId } as TelegramBot.SendDocumentOptions : undefined;
    await this.bot.sendDocument(chatId, filePath, docOpts);
  }

  private callCcAgentTool(toolName: string, args: Record<string, unknown> = {}): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val: string | null) => {
        if (!settled) { settled = true; resolve(val); }
      };

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("npx", ["-y", "@gonzih/cc-agent@latest"], {
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        console.error("[mcp] failed to spawn cc-agent:", (err as Error).message);
        done(null);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn("[mcp] cc-agent tool call timed out");
        proc.kill();
        done(null);
      }, 30_000);

      let buffer = "";
      const sendMsg = (msg: unknown) => { proc.stdin!.write(JSON.stringify(msg) + "\n"); };

      sendMsg({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cc-tg", version: "1.0.0" } },
      });

      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id === 1 && "result" in msg) {
              sendMsg({ jsonrpc: "2.0", method: "notifications/initialized" });
              sendMsg({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } });
            } else if (msg.id === 2) {
              clearTimeout(timeout);
              if (msg.error) {
                console.error("[mcp] cost_summary error:", JSON.stringify(msg.error));
                proc.kill();
                done(null);
                return;
              }
              const result = msg.result as Record<string, unknown> | undefined;
              const content = result?.content as Array<Record<string, unknown>> | undefined;
              const text = (content ?? []).filter((b) => b.type === "text").map((b) => b.text as string).join("");
              proc.kill();
              done(text || null);
            }
          } catch { /* ignore non-JSON lines */ }
        }
      });

      proc.on("error", (err) => {
        console.error("[mcp] cc-agent spawn error:", err.message);
        clearTimeout(timeout);
        done(null);
      });

      proc.on("exit", () => { clearTimeout(timeout); done(null); });
    });
  }

  private killSession(chatId: number, keepCrons = true, threadId?: number): void {
    const key = this.sessionKey(chatId, threadId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopTyping(session);
      session.claude.kill();
      this.sessions.delete(key);
    }
    if (!keepCrons) this.cron.clearAll(chatId);
  }

  getMe(): Promise<TelegramBot.User> {
    return this.bot.getMe();
  }

  stop(): void {
    this.bot.stopPolling();
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      session.claude.kill();
    }
    this.sessions.clear();
  }
}

function buildPromptWithReplyContext(text: string, msg: TelegramBot.Message): string {
  const reply = msg.reply_to_message;
  if (!reply) return text;

  const quotedText = reply.text || reply.caption || null;
  if (!quotedText) return text;

  const truncated = quotedText.length > 500
    ? quotedText.slice(0, 500) + "... [truncated]"
    : quotedText;

  return `[Replying to: "${truncated}"]\n\n${text}`;
}

/** Download a URL and return its contents as a base64 string */
function fetchAsBase64(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Download a URL to a local file path */
function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = createWriteStream(destPath);
    client.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}
