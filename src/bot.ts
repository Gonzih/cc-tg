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
import { Redis } from "ioredis";
import { ClaudeProcess, extractText, ClaudeMessage, UsageEvent } from "./claude.js";
import { transcribeVoice, isVoiceAvailable } from "./voice.js";
import { formatForTelegram, splitLongMessage } from "./formatter.js";
import { detectUsageLimit } from "./usage-limit.js";
import { getCurrentToken, rotateToken, getTokenIndex, getTokenCount } from "./tokens.js";
import { writeChatLog, type ChatMessage } from "./notifier.js";
import { CronManager } from "./cron.js";
import { parseRoutingTag, ensureMetaAgent, routeToMetaAgent } from "./router.js";
import { VOICE_PENDING_KEY, VOICE_FAILED_KEY, TTL, metaAgentStatusKey, wikiKey, wikiUpdatedKey } from "@gonzih/cc-wire";

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Reset session and start fresh" },
  { command: "reset", description: "Reset Claude session" },
  { command: "stop", description: "Stop the current Claude task" },
  { command: "status", description: "Check if a session is active" },
  { command: "help", description: "Show all available commands" },
  { command: "reload_mcp", description: "Restart the cc-agent MCP server process" },
  { command: "mcp_status", description: "Check MCP server connection status" },
  { command: "mcp_version", description: "Show cc-agent npm version and npx cache info" },
  { command: "clear_npx_cache", description: "Clear npx cache and restart MCP to pick up latest version" },
  { command: "restart", description: "Restart the bot process in-place" },
  { command: "get_file", description: "Send a file from the server to this chat" },
  { command: "cost", description: "Show session token usage and cost" },
  { command: "skills", description: "List available Claude skills with descriptions" },
  { command: "cron", description: "Manage cron jobs — add/list/edit/remove/clear" },
  { command: "voice_retry", description: "Retry failed voice message transcriptions" },
  { command: "drivers", description: "List available agent drivers" },
  { command: "agents", description: "Show running meta-agents and their live status" },
  { command: "wiki", description: "Manage wiki pages — list/show/update/delete/sync" },
];

export interface BotOptions {
  telegramToken: string;
  claudeToken?: string;
  cwd?: string;
  allowedUserIds?: number[];
  groupChatIds?: number[];
  redis?: Redis;
  namespace?: string;
  /** Called when a message is routed to a non-default namespace so the notifier
   *  can forward the response back to the originating Telegram chat. */
  registerRoutedChatId?: (namespace: string, chatId: number) => void;
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

// Debounces streaming chunks. Resets on each chunk. Fires 800ms after last chunk.
const FLUSH_DELAY_MS = 800;
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

/** Prepend [MM-DD HH:mm] so Claude knows when the message was received. Not shown in Telegram. */
export function stampPrompt(text: string, now = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `[${mm}-${dd} ${hh}:${min}] ${text}`;
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

function formatAgentCostSummary(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const totalCost = ((data.total_cost_usd ?? data.total_cost ?? 0) as number);
    const byRepo = (data.by_repo ?? []) as Array<Record<string, unknown>>;

    if (byRepo.length === 0) {
      return "No cost data available yet.";
    }

    const lines = ["💰 Cost Summary", ""];

    // Align repo names with right-padded costs
    const maxLen = Math.max(...byRepo.map((e) => ((e.repo ?? e.repository ?? "unknown") as string).length));
    for (const entry of byRepo) {
      const repo = (entry.repo ?? entry.repository ?? "unknown") as string;
      const cost = ((entry.cost_usd ?? entry.cost ?? 0) as number);
      const pad = " ".repeat(maxLen - repo.length + 3);
      lines.push(`${repo}${pad}$${cost.toFixed(2)}`);
    }

    lines.push("");
    lines.push(`Total: $${totalCost.toFixed(2)}`);
    return lines.join("\n");
  } catch {
    return `💰 Cost Summary\n${text}`;
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
  private costStore: CostStore;
  private botUsername = "";
  private botId = 0;
  private redis?: Redis;
  private namespace: string;
  private lastActiveChatId?: number;
  private cron: CronManager;
  /** In-memory cache of forum topic names: `${chatId}:${threadId}` → topic name */
  private topicNameCache = new Map<string, string>();
  /** Pending /wiki update state: chatId → {repoSlug, pageName, threadId} — awaiting user's next message as content */
  private pendingWikiUpdates = new Map<number, { repoSlug: string; pageName: string; threadId?: number }>();

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.redis = opts.redis;
    this.namespace = opts.namespace ?? "default";
    this.bot = new TelegramBot(opts.telegramToken, { polling: true });
    this.bot.on("message", (msg) => this.handleTelegram(msg));
    this.bot.on("polling_error", (err) => console.error("[tg]", err.message));

    this.bot.getMe().then((me) => {
      this.botUsername = me.username ?? "";
      this.botId = me.id;
      console.log(`[tg] bot identity: @${this.botUsername} (id=${this.botId})`);
    }).catch((err: Error) => console.error("[tg] getMe failed:", err.message));

    this.costStore = new CostStore(opts.cwd ?? process.cwd());

    this.cron = new CronManager(opts.cwd ?? process.cwd(), (chatId, prompt, _jobId, done) => {
      this.runCronTask(chatId, prompt, done);
    });

    this.registerBotCommands();

    console.log("cc-tg bot started");
    console.log(`[voice] whisper available: ${isVoiceAvailable()}`);
  }

  private registerBotCommands(): void {
    this.bot.setMyCommands(BOT_COMMANDS)
      .then(() => console.log("[tg] bot commands registered"))
      .catch((err: Error) => console.error("[tg] setMyCommands failed:", err.message));
  }

  /** Write a message to the Redis chat log. Fire-and-forget — no-op if Redis is not configured. */
  private writeChatMessage(role: ChatMessage["role"], source: ChatMessage["source"], content: string, chatId: number): void {
    if (!this.redis) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      source,
      role,
      content,
      timestamp: new Date().toISOString(),
      chatId,
    };
    writeChatLog(this.redis, this.namespace, msg);
  }

  /** Returns the last chatId that sent a message — used by the chat bridge when no fixed chatId is configured. */
  public getLastActiveChatId(): number | undefined {
    return this.lastActiveChatId;
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

  /**
   * Parse FORUM_META_AGENT_ROUTING env var.
   *   "auto" (default) → route all forum topics to meta-agents
   *   "off"            → disable forum routing entirely
   *   "topic-a,topic-b" → only route these named topics
   */
  private getForumRoutingConfig(): "auto" | "off" | Set<string> {
    const raw = process.env.FORUM_META_AGENT_ROUTING;
    if (!raw || raw === "auto") return "auto";
    if (raw === "off") return "off";
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
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

    // Cache forum topic names from service messages so routing can look them up later
    if (threadId !== undefined) {
      if (threadName) {
        this.topicNameCache.set(`${chatId}:${threadId}`, threadName);
      }
      // forum_topic_edited carries name only when the name was changed
      const editedTopicName = (rawMsg.forum_topic_edited as Record<string, unknown> | undefined)?.name as string | undefined;
      if (editedTopicName) {
        this.topicNameCache.set(`${chatId}:${threadId}`, editedTopicName);
      }
      // Best-effort: first message in a topic often has reply_to_message pointing to the creation event
      if (!this.topicNameCache.has(`${chatId}:${threadId}`)) {
        const replyRaw = msg.reply_to_message as unknown as Record<string, unknown> | undefined;
        const replyCreated = replyRaw?.forum_topic_created as Record<string, unknown> | undefined;
        const replyName = replyCreated?.name as string | undefined;
        if (replyName) {
          this.topicNameCache.set(`${chatId}:${threadId}`, replyName);
        }
      }
    }

    if (!this.isAllowed(userId)) {
      await this.replyToChat(chatId, "Not authorized.", threadId);
      return;
    }

    // Track the last chat that sent us a message for the chat bridge
    this.lastActiveChatId = chatId;

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

    // Pending /wiki update — next message is the new page content
    const pendingWiki = this.pendingWikiUpdates.get(chatId);
    if (pendingWiki && !text.startsWith("/")) {
      this.pendingWikiUpdates.delete(chatId);
      await this.handleWikiUpdateContent(chatId, pendingWiki.repoSlug, pendingWiki.pageName, text, pendingWiki.threadId);
      return;
    }

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

    // /cron <schedule> <prompt> | /cron list | /cron clear | /cron remove <id>
    if (text.startsWith("/cron")) {
      await this.handleCron(chatId, text, threadId);
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

    // /skills — list available Claude skills from ~/.claude/skills/
    if (text === "/skills") {
      await this.replyToChat(chatId, listSkills(), threadId);
      return;
    }

    // /voice_retry — retry failed voice message transcriptions
    if (text === "/voice_retry") {
      await this.handleVoiceRetry(chatId, threadId);
      return;
    }

    // /drivers — list available agent drivers via cc-agent MCP
    if (text === "/drivers") {
      await this.handleDrivers(chatId, threadId);
      return;
    }

    // /agents — show running meta-agents and their live status
    if (text === "/agents") {
      await this.handleAgents(chatId, threadId);
      return;
    }

    // /wiki <subcommand> — manage wiki pages in Redis
    if (text.startsWith("/wiki")) {
      await this.handleWiki(chatId, text, threadId);
      return;
    }

    // #tag / #org/repo routing — delegate to meta-agent instead of local Claude session
    if (this.redis) {
      const routing = parseRoutingTag(text);
      if (routing) {
        // Acknowledge routing immediately so user knows the message was delegated
        await this.replyToChat(chatId, `→ #${routing.namespace}`, threadId);
        this.writeChatMessage("user", "telegram", text, chatId);
        // Register the originating chatId so responses come back to this chat
        this.opts.registerRoutedChatId?.(routing.namespace, chatId);
        try {
          await ensureMetaAgent(
            routing.namespace,
            routing.repoUrl,
            (toolName, args) => this.callCcAgentTool(toolName, args ?? {}),
            this.redis
          );
          await routeToMetaAgent(routing.namespace, routing.strippedMessage, this.redis);
        } catch (err) {
          await this.replyToChat(
            chatId,
            `Failed to route to #${routing.namespace}: ${(err as Error).message}`,
            threadId
          );
        }
        return;
      }
    }

    // Forum topic → meta-agent routing (runs after hashtag routing so explicit #tag wins)
    if (this.redis && threadId !== undefined) {
      const topicKey = `${chatId}:${threadId}`;
      const topicName = this.topicNameCache.get(topicKey);
      if (topicName) {
        const namespace = normalizeTopicNamespace(topicName);
        const routingConfig = this.getForumRoutingConfig();
        const shouldRoute =
          routingConfig === "auto" ||
          (routingConfig instanceof Set && (routingConfig.has(topicName) || routingConfig.has(namespace)));
        if (shouldRoute) {
          const defaultOrg = process.env.DEFAULT_GITHUB_ORG ?? "gonzih";
          const repoUrl = `https://github.com/${defaultOrg}/${namespace}`;
          await this.replyToChat(chatId, `→ #${namespace} (meta-agent)`, threadId);
          this.writeChatMessage("user", "telegram", text, chatId);
          // Register the originating chatId so responses come back to this chat
          this.opts.registerRoutedChatId?.(namespace, chatId);
          try {
            await ensureMetaAgent(
              namespace,
              repoUrl,
              (toolName, args) => this.callCcAgentTool(toolName, args ?? {}),
              this.redis
            );
            await routeToMetaAgent(namespace, text, this.redis);
          } catch (err) {
            await this.replyToChat(
              chatId,
              `Failed to route to #${namespace}: ${(err as Error).message}`,
              threadId
            );
          }
          return;
        }
      }
    }

    const session = this.getOrCreateSession(chatId, threadId, threadName);
    try {
      const enriched = await enrichPromptWithUrls(text);
      const prompt = buildPromptWithReplyContext(enriched, msg);
      session.currentPrompt = prompt;
      session.claude.sendPrompt(stampPrompt(prompt));
      this.startTyping(chatId, session);
      this.writeChatMessage("user", "telegram", text, chatId);
    } catch (err) {
      await this.replyToChat(chatId, `Error sending to Claude: ${(err as Error).message}`, threadId);
      this.killSession(chatId, true, threadId);
    }
  }

  /**
   * Feed a text message into the active Claude session for the given chat.
   * Called by the notifier when a UI message arrives via Redis pub/sub.
   */
  public async handleUserMessage(chatId: number, text: string): Promise<void> {
    const session = this.getOrCreateSession(chatId);
    try {
      const enriched = await enrichPromptWithUrls(text);
      session.currentPrompt = enriched;
      session.claude.sendPrompt(stampPrompt(enriched));
      this.startTyping(chatId, session);
      this.writeChatMessage("user", "ui", text, chatId);
    } catch (err) {
      await this.replyToChat(chatId, `Error sending to Claude: ${(err as Error).message}`);
      this.killSession(chatId, true);
    }
  }

  /**
   * Forward a cc-agent job notification into an existing Claude session.
   * Unlike handleUserMessage, this never creates a new session — if no session
   * is active for the chatId, the notification is already visible in Telegram
   * and we silently skip feeding it into Claude.
   */
  public forwardNotification(chatId: number, text: string): void {
    const key = this.sessionKey(chatId);
    const session = this.sessions.get(key);
    if (!session || session.claude.exited) return;
    try {
      session.claude.sendPrompt(stampPrompt(text));
      this.writeChatMessage("user", "cc-tg", text, chatId);
    } catch (err) {
      console.error(`[forwardNotification:${chatId}] failed:`, (err as Error).message);
    }
  }

  private async handleVoice(chatId: number, msg: TelegramBot.Message, threadId?: number, threadName?: string): Promise<void> {
    const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
    if (!fileId) return;

    console.log(`[voice:${chatId}] received voice message, transcribing...`);
    this.bot.sendChatAction(chatId, "typing", threadId !== undefined ? { message_thread_id: threadId } : undefined).catch(() => {});

    // Store in Redis before transcription so we can retry on failure
    const pendingEntry = JSON.stringify({
      file_id: fileId,
      chat_id: chatId,
      message_id: msg.message_id,
      timestamp: Date.now(),
    });
    if (this.redis) {
      await this.redis.rpush(VOICE_PENDING_KEY, pendingEntry).catch((err: Error) =>
        console.warn("[voice] redis rpush voice:pending failed:", err.message)
      );
    }

    try {
      const fileLink = await this.bot.getFileLink(fileId);
      const transcript = await transcribeVoice(fileLink);
      console.log(`[voice:${chatId}] transcribed: ${transcript}`);

      // Remove from pending on success
      if (this.redis) {
        await this.redis.lrem(VOICE_PENDING_KEY, 0, pendingEntry).catch((err: Error) =>
          console.warn("[voice] redis lrem voice:pending failed:", err.message)
        );
      }

      if (!transcript || transcript === "[empty transcription]") {
        await this.replyToChat(chatId, "Could not transcribe voice message.", threadId);
        return;
      }

      // Feed transcript into Claude as if user typed it
      const session = this.getOrCreateSession(chatId, threadId, threadName);
      try {
        const prompt = buildPromptWithReplyContext(transcript, msg);
        this.writeChatMessage("user", "telegram", transcript, chatId);
        session.currentPrompt = prompt;
        session.claude.sendPrompt(stampPrompt(prompt));
        this.startTyping(chatId, session);
      } catch (err) {
        await this.replyToChat(chatId, `Error sending to Claude: ${(err as Error).message}`, threadId);
        this.killSession(chatId, true, threadId);
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`[voice:${chatId}] error:`, errMsg);

      // Push to voice:failed on failure (entry stays in voice:pending for retry)
      if (this.redis) {
        const failedEntry = JSON.stringify({
          file_id: fileId,
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
          error: errMsg,
          failed_at: Date.now(),
        });
        this.redis.rpush(VOICE_FAILED_KEY, failedEntry)
          .then(() => this.redis!.expire(VOICE_FAILED_KEY, TTL.VOICE_FAILED_SECONDS))
          .catch((redisErr: Error) =>
            console.warn("[voice] redis write voice:failed failed:", redisErr.message)
          );
      }

      // User-friendly error messages
      let userMsg: string;
      if (errMsg.includes("whisper-cpp not found") || errMsg.includes("whisper not found")) {
        userMsg = "Voice transcription unavailable — whisper-cpp not installed";
      } else if (errMsg.includes("No whisper model found")) {
        userMsg = "Voice transcription unavailable — no whisper model found";
      } else if (errMsg.includes("HTTP") && errMsg.includes("downloading")) {
        userMsg = "Could not download voice file from Telegram";
      } else {
        userMsg = `Voice transcription failed: ${errMsg}`;
      }
      await this.replyToChat(chatId, userMsg, threadId);
    }
  }

  private async handleVoiceRetry(chatId: number, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — voice retry unavailable.", threadId);
      return;
    }

    const [pendingRaw, failedRaw] = await Promise.all([
      this.redis.lrange(VOICE_PENDING_KEY, 0, -1).catch(() => [] as string[]),
      this.redis.lrange(VOICE_FAILED_KEY, 0, -1).catch(() => [] as string[]),
    ]);

    // Deduplicate by file_id across both lists
    const allEntries = new Map<string, { file_id: string; chat_id: number; message_id: number; timestamp: number }>();
    for (const raw of [...pendingRaw, ...failedRaw]) {
      try {
        const entry = JSON.parse(raw) as { file_id: string; chat_id: number; message_id: number; timestamp: number };
        if (entry.file_id) allEntries.set(entry.file_id, entry);
      } catch { /* skip malformed entries */ }
    }

    if (allEntries.size === 0) {
      await this.replyToChat(chatId, "No pending voice messages to retry.", threadId);
      return;
    }

    await this.replyToChat(chatId, `Retrying ${allEntries.size} voice message(s)...`, threadId);

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const [fileId, entry] of allEntries) {
      try {
        const fileLink = await this.bot.getFileLink(fileId);
        const transcript = await transcribeVoice(fileLink);

        if (transcript && transcript !== "[empty transcription]") {
          const session = this.getOrCreateSession(entry.chat_id, threadId, undefined);
          session.claude.sendPrompt(stampPrompt(transcript));
          this.writeChatMessage("user", "telegram", transcript, entry.chat_id);

          // Remove from both lists
          const matchPending = pendingRaw.find((r) => r.includes(`"${fileId}"`));
          const matchFailed = failedRaw.find((r) => r.includes(`"${fileId}"`));
          if (matchPending) await this.redis.lrem(VOICE_PENDING_KEY, 0, matchPending).catch(() => {});
          if (matchFailed) await this.redis.lrem(VOICE_FAILED_KEY, 0, matchFailed).catch(() => {});

          succeeded++;
        } else {
          failed++;
          errors.push(`${fileId}: empty transcription`);
        }
      } catch (err) {
        const errMsg = (err as Error).message;
        failed++;
        errors.push(`${fileId}: ${errMsg}`);
        // Permanently unretryable (expired Telegram link) — remove from voice:pending
        if (errMsg.includes("Bad Request") || errMsg.includes("file_id")) {
          const matchPending = pendingRaw.find((r) => r.includes(`"${fileId}"`));
          if (matchPending) await this.redis.lrem(VOICE_PENDING_KEY, 0, matchPending).catch(() => {});
        }
      }
    }

    // Purge stale entries from voice:pending older than 48h
    const staleThreshold = 48 * 60 * 60 * 1000;
    let purged = 0;
    for (const raw of pendingRaw) {
      try {
        const entry = JSON.parse(raw) as { timestamp?: number };
        if (entry.timestamp && Date.now() - entry.timestamp > staleThreshold) {
          await this.redis.lrem(VOICE_PENDING_KEY, 0, raw).catch(() => {});
          purged++;
        }
      } catch { /* skip malformed entries */ }
    }

    const lines = [`Voice retry complete: ${succeeded} succeeded, ${failed} failed, ${purged} stale entries purged.`];
    if (errors.length > 0) lines.push(...errors.map((e) => `• ${e}`));
    await this.replyToChat(chatId, lines.join("\n"), threadId);
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
      session.claude.sendImage(imageData, "image/jpeg", stampPrompt(caption ?? ""));
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
      session.claude.sendPrompt(stampPrompt(prompt));
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

      // Publish tool call events to the chat log
      if (msg.type === "assistant") {
        const message = msg.payload.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type !== "tool_use") continue;
            const name = block.name as string;
            const input = block.input as Record<string, unknown> | undefined;
            this.writeChatMessage(
              "tool",
              "cc-tg",
              `[tool] ${name}: ${JSON.stringify(input ?? {})}`,
              chatId
            );
          }
        }
      }

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
          retrySession.claude.sendPrompt(stampPrompt(lastPrompt));
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
          retrySession.claude.sendPrompt(stampPrompt(lastPrompt));
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

    this.writeChatMessage("assistant", "cc-tg", raw, chatId);

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

    const unique = [...new Set(toUpload)];
    for (const filePath of unique) {
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
    await this.replyToChat(chatId, "Restarting... brb.", threadId);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Kill all active Claude sessions cleanly
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      session.claude.kill();
    }
    this.sessions.clear();

    await new Promise(resolve => setTimeout(resolve, 200));
    process.exit(0);
  }

  private async handleCron(chatId: number, text: string, threadId?: number): Promise<void> {
    const args = text.slice("/cron".length).trim();

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

    if (args === "clear") {
      const n = this.cron.clearAll(chatId);
      await this.replyToChat(chatId, `Cleared ${n} cron job(s).`, threadId);
      return;
    }

    if (args.startsWith("remove ")) {
      const id = args.slice("remove ".length).trim();
      const ok = this.cron.remove(chatId, id);
      await this.replyToChat(chatId, ok ? `Removed ${id}.` : `Not found: ${id}`, threadId);
      return;
    }

    const scheduleMatch = args.match(/^(every\s+\d+[mhd])\s+(.+)$/i);
    if (!scheduleMatch) {
      await this.replyToChat(
        chatId,
        "Usage:\n/cron every 1h <prompt>\n/cron list\n/cron remove <id>\n/cron clear",
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

  private runCronTask(chatId: number, prompt: string, done: () => void = () => {}): void {
    const cronProcess = new ClaudeProcess({ cwd: this.opts.cwd ?? process.cwd() });
    cronProcess.sendPrompt(prompt);
    cronProcess.on("message", (msg: ClaudeMessage) => {
      const result = extractText(msg);
      if (result) {
        const formatted = formatForTelegram(`🕐 ${result}`);
        const chunks = splitLongMessage(formatted);
        for (const chunk of chunks) {
          this.replyToChat(chatId, chunk).catch((err: Error) =>
            console.error("[cron] send failed:", err.message)
          );
        }
      }
    });
    cronProcess.on("exit", () => done());
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

  private async handleDrivers(chatId: number, threadId?: number): Promise<void> {
    try {
      const raw = await this.callCcAgentTool("list_drivers");
      if (!raw) {
        await this.replyToChat(chatId, "No drivers available or cc-agent did not respond.", threadId);
        return;
      }
      // Try to pretty-print JSON array/object, fall back to raw string
      let reply: string;
      try {
        const data = JSON.parse(raw) as unknown;
        if (Array.isArray(data)) {
          const current = process.env.CC_AGENT_DEFAULT_DRIVER || "claude";
          const lines = (data as string[]).map((d) => d === current ? `• ${d} (default)` : `• ${d}`);
          reply = `Available drivers:\n${lines.join("\n")}`;
        } else {
          reply = `Available drivers:\n${raw}`;
        }
      } catch {
        reply = `Available drivers:\n${raw}`;
      }
      await this.replyToChat(chatId, reply, threadId);
    } catch (err) {
      await this.replyToChat(chatId, `Failed to list drivers: ${(err as Error).message}`, threadId);
    }
  }

  private async handleAgents(chatId: number, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — agents status unavailable.", threadId);
      return;
    }

    try {
      // Scan for all meta-agent status keys
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, found] = await this.redis.scan(cursor, "MATCH", metaAgentStatusKey("*"), "COUNT", 100);
        cursor = nextCursor;
        keys.push(...found);
      } while (cursor !== "0");

      if (keys.length === 0) {
        await this.replyToChat(chatId, "No active meta-agents.", threadId);
        return;
      }

      const statuses = await Promise.all(
        keys.sort().map(async (key) => ({ key, raw: await this.redis!.get(key) }))
      );

      const lines = ["🤖 Active Agents", ""];
      for (const { key, raw } of statuses) {
        const namespace = key.slice(metaAgentStatusKey("").length);
        if (!raw) {
          lines.push(`${namespace} — status unknown`);
          continue;
        }
        try {
          const status = JSON.parse(raw) as {
            status?: string;
            current_tool?: string;
            turn?: number;
            turn_count?: number;
            last_activity?: string;
            updated_at?: string;
          };

          const state = status.status ?? "unknown";
          const turns = status.turn ?? status.turn_count ?? 0;
          const tool = status.current_tool;
          const lastActivity = status.last_activity ?? status.updated_at;

          let ageStr = "";
          if (lastActivity) {
            const ageSec = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 1000);
            if (ageSec < 60) ageStr = `${ageSec}s ago`;
            else if (ageSec < 3600) ageStr = `${Math.floor(ageSec / 60)}m ago`;
            else ageStr = `${Math.floor(ageSec / 3600)}h ago`;
          }

          let statusDesc: string;
          if (state === "running" && tool) {
            statusDesc = `typing... (turn ${turns})`;
          } else if (state === "running") {
            statusDesc = `running (turn ${turns}${ageStr ? `, ${ageStr}` : ""})`;
          } else {
            statusDesc = `idle (turn ${turns}${ageStr ? `, ${ageStr}` : ""})`;
          }

          lines.push(`${namespace} — ${statusDesc}`);
        } catch {
          lines.push(`${namespace} — status unknown`);
        }
      }

      await this.replyToChat(chatId, lines.join("\n"), threadId);
    } catch (err) {
      await this.replyToChat(chatId, `Failed to get agents status: ${(err as Error).message}`, threadId);
    }
  }

  private async handleWiki(chatId: number, text: string, threadId?: number): Promise<void> {
    const args = text.slice("/wiki".length).trim();
    const parts = args.split(/\s+/);
    const subCmd = parts[0] ?? "";

    if (subCmd === "list" || subCmd === "") {
      await this.handleWikiList(chatId, parts[1], threadId);
      return;
    }

    if (subCmd === "show") {
      const repoSlug = parts[1];
      const pageName = parts.slice(2).join(" ");
      if (!repoSlug || !pageName) {
        await this.replyToChat(chatId, "Usage: /wiki show <repo_slug> <page_name>", threadId);
        return;
      }
      await this.handleWikiShow(chatId, repoSlug, pageName, threadId);
      return;
    }

    if (subCmd === "update") {
      const repoSlug = parts[1];
      const pageName = parts.slice(2).join(" ");
      if (!repoSlug || !pageName) {
        await this.replyToChat(chatId, "Usage: /wiki update <repo_slug> <page_name>", threadId);
        return;
      }
      this.pendingWikiUpdates.set(chatId, { repoSlug, pageName, threadId });
      await this.replyToChat(chatId, `Send the new content for page "${pageName}" in repo "${repoSlug}":`, threadId);
      return;
    }

    if (subCmd === "delete") {
      const repoSlug = parts[1];
      const pageName = parts.slice(2).join(" ");
      if (!repoSlug || !pageName) {
        await this.replyToChat(chatId, "Usage: /wiki delete <repo_slug> <page_name>", threadId);
        return;
      }
      await this.handleWikiDelete(chatId, repoSlug, pageName, threadId);
      return;
    }

    if (subCmd === "sync") {
      await this.handleWikiSync(chatId, threadId);
      return;
    }

    await this.replyToChat(
      chatId,
      "Usage:\n/wiki list [repo_slug]\n/wiki show <repo_slug> <page_name>\n/wiki update <repo_slug> <page_name>\n/wiki delete <repo_slug> <page_name>\n/wiki sync",
      threadId
    );
  }

  private async handleWikiList(chatId: number, repoSlug: string | undefined, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — wiki unavailable.", threadId);
      return;
    }

    if (repoSlug) {
      const pages = await this.redis.hkeys(wikiKey(repoSlug));
      if (!pages.length) {
        await this.replyToChat(chatId, `No wiki pages for "${repoSlug}".`, threadId);
        return;
      }
      const lines = pages.sort().map((p, i) => `${i + 1}. ${p}`);
      await this.replyToChat(chatId, `Wiki pages for ${repoSlug} (${pages.length}):\n${lines.join("\n")}`, threadId);
      return;
    }

    // List all repos — scan for cca:wiki:* keys, exclude :updated keys
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, found] = await this.redis.scan(cursor, "MATCH", "cca:wiki:*", "COUNT", 100);
      cursor = nextCursor;
      keys.push(...found.filter((k) => !k.endsWith(":updated")));
    } while (cursor !== "0");

    if (!keys.length) {
      await this.replyToChat(chatId, "No wiki repos found.", threadId);
      return;
    }

    const counts = await Promise.all(
      keys.sort().map(async (key) => {
        const slug = key.slice("cca:wiki:".length);
        const count = await this.redis!.hlen(key);
        return `${slug} (${count} pages)`;
      })
    );
    await this.replyToChat(chatId, `Wiki repos:\n${counts.join("\n")}`, threadId);
  }

  private async handleWikiShow(chatId: number, repoSlug: string, pageName: string, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — wiki unavailable.", threadId);
      return;
    }

    const content = await this.redis.hget(wikiKey(repoSlug), pageName);
    if (!content) {
      await this.replyToChat(chatId, `Page "${pageName}" not found in "${repoSlug}".`, threadId);
      return;
    }

    const TG_LIMIT = 4000;
    const header = `📄 ${repoSlug}/${pageName}\n\n`;
    const fullText = header + content;

    if (fullText.length <= TG_LIMIT) {
      await this.replyToChat(chatId, fullText, threadId);
      return;
    }

    const truncated = fullText.slice(0, TG_LIMIT - 20) + "\n...(truncated)";
    await this.replyToChat(chatId, truncated, threadId);
  }

  private async handleWikiUpdateContent(chatId: number, repoSlug: string, pageName: string, content: string, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — wiki unavailable.", threadId);
      return;
    }

    await this.redis.hset(wikiKey(repoSlug), pageName, content);
    await this.redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString());
    await this.replyToChat(chatId, `Updated "${pageName}" in "${repoSlug}".`, threadId);
  }

  private async handleWikiDelete(chatId: number, repoSlug: string, pageName: string, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — wiki unavailable.", threadId);
      return;
    }

    const deleted = await this.redis.hdel(wikiKey(repoSlug), pageName);
    if (deleted) {
      await this.redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString());
      await this.replyToChat(chatId, `Deleted "${pageName}" from "${repoSlug}".`, threadId);
    } else {
      await this.replyToChat(chatId, `Page "${pageName}" not found in "${repoSlug}".`, threadId);
    }
  }

  private async handleWikiSync(chatId: number, threadId?: number): Promise<void> {
    if (!this.redis) {
      await this.replyToChat(chatId, "Redis not configured — wiki unavailable.", threadId);
      return;
    }

    const wikiDir = "/Users/feral/money-brain/wiki";
    if (!existsSync(wikiDir)) {
      await this.replyToChat(chatId, `Wiki directory not found: ${wikiDir}`, threadId);
      return;
    }

    let files: string[];
    try {
      files = readdirSync(wikiDir).filter((f) => f.endsWith(".md"));
    } catch (err) {
      await this.replyToChat(chatId, `Failed to read wiki directory: ${(err as Error).message}`, threadId);
      return;
    }

    if (!files.length) {
      await this.replyToChat(chatId, "No .md files found in wiki directory.", threadId);
      return;
    }

    const repoSlug = "gonzih-money-brain";
    let synced = 0;
    const errors: string[] = [];

    for (const file of files) {
      const pageName = file.replace(/\.md$/, "");
      try {
        const content = readFileSync(join(wikiDir, file), "utf8");
        await this.redis.hset(wikiKey(repoSlug), pageName, content);
        synced++;
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }

    if (synced > 0) {
      await this.redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString());
    }

    let reply = `Synced ${synced}/${files.length} pages to cca:wiki:${repoSlug}`;
    if (errors.length) {
      reply += `\nErrors:\n${errors.join("\n")}`;
    }
    await this.replyToChat(chatId, reply, threadId);
  }

  // ────────────────────────────────────────────────────────────────────────────

  private callCcAgentTool(toolName: string, args: Record<string, unknown> = {}): Promise<string | null> {
    // For spawn tools, pass through the configured driver and model
    const spawnTools = new Set(["spawn_agent", "spawn_from_profile"]);
    if (spawnTools.has(toolName)) {
      const driver = process.env.CC_AGENT_DEFAULT_DRIVER || "claude";
      const model = process.env.CC_AGENT_DEFAULT_MODEL || undefined;
      args = { agent_driver: driver, ...(model ? { agent_model: model } : {}), ...args };
    }

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

  private killSession(chatId: number, _keepCrons = true, threadId?: number): void {
    const key = this.sessionKey(chatId, threadId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopTyping(session);
      session.claude.kill();
      this.sessions.delete(key);
    }
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

/** Fetch URL via Jina Reader and return first maxChars characters */
function fetchUrlViaJina(url: string, maxChars = 2000): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  return new Promise((resolve, reject) => {
    https.get(jinaUrl, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.slice(0, maxChars));
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Detect URLs in text, fetch each via Jina Reader, and prepend content to the prompt */
export async function enrichPromptWithUrls(text: string): Promise<string> {
  const urlRegex = /https?:\/\/[^\s]+/g;
  const urls = text.match(urlRegex);
  if (!urls || urls.length === 0) return text;

  const prefixes: string[] = [];
  for (const url of urls) {
    // Skip jina.ai URLs to avoid recursion
    if (url.includes("r.jina.ai")) continue;
    try {
      const content = await fetchUrlViaJina(url);
      if (content.trim()) {
        prefixes.push(`[Web content from ${url}]:\n${content}`);
      }
    } catch (err) {
      console.warn(`[url-fetch] failed to fetch ${url}:`, (err as Error).message);
    }
  }

  if (prefixes.length === 0) return text;
  return prefixes.join("\n\n") + "\n\n" + text;
}

/** Parse frontmatter description from a skill markdown file */
function parseSkillDescription(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : null;
}

/** List available skills from ~/.claude/skills/ */
export function listSkills(): string {
  const skillsDir = join(os.homedir(), ".claude", "skills");
  if (!existsSync(skillsDir)) {
    return "No skills directory found at ~/.claude/skills/";
  }

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return "Could not read skills directory.";
  }

  if (files.length === 0) {
    return "No skills found in ~/.claude/skills/";
  }

  const lines: string[] = ["Available skills:"];
  for (const file of files.sort()) {
    const name = "/" + file.replace(/\.md$/, "");
    try {
      const content = readFileSync(join(skillsDir, file), "utf8");
      const description = parseSkillDescription(content);
      lines.push(description ? `${name} — ${description}` : name);
    } catch {
      lines.push(name);
    }
  }
  return lines.join("\n");
}

/**
 * Normalize a Telegram forum topic name into a meta-agent namespace.
 * Rules: strip leading #, lowercase, spaces → hyphens, non-alphanumeric → hyphens,
 * collapse and trim hyphens.
 *
 * Examples:
 *   "CC Suite"  → "cc-suite"
 *   "#research" → "research"
 *   "of-stack"  → "of-stack"
 */
export function normalizeTopicNamespace(name: string): string {
  return name
    .replace(/^#+/, "")              // strip leading # prefix
    .toLowerCase()
    .replace(/\s+/g, "-")           // spaces → hyphens
    .replace(/[^a-z0-9._-]/g, "-")  // non-alphanumeric/non-safe → hyphens
    .replace(/-+/g, "-")            // collapse consecutive hyphens
    .replace(/^-|-$/g, "");         // trim leading/trailing hyphens
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
