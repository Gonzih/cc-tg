/**
 * Telegram bot that routes messages to/from a Claude Code subprocess.
 * One ClaudeProcess per chat_id — sessions are isolated per user.
 */

import TelegramBot from "node-telegram-bot-api";
import { ClaudeProcess, extractText, ClaudeMessage } from "./claude.js";

export interface BotOptions {
  telegramToken: string;
  claudeToken?: string;
  cwd?: string;
  allowedUserIds?: number[];
}

interface Session {
  claude: ClaudeProcess;
  pendingText: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastMessageId?: number;
}

const FLUSH_DELAY_MS = 800; // debounce streaming chunks into one Telegram message

export class CcTgBot {
  private bot: TelegramBot;
  private sessions = new Map<number, Session>();
  private opts: BotOptions;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.bot = new TelegramBot(opts.telegramToken, { polling: true });
    this.bot.on("message", (msg) => this.handleTelegram(msg));
    this.bot.on("polling_error", (err) => console.error("[tg]", err.message));
    console.log("cc-tg bot started");
  }

  private isAllowed(userId: number): boolean {
    if (!this.opts.allowedUserIds?.length) return true;
    return this.opts.allowedUserIds.includes(userId);
  }

  private async handleTelegram(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    const text = msg.text?.trim();

    if (!text) return;

    if (!this.isAllowed(userId)) {
      await this.bot.sendMessage(chatId, "Not authorized.");
      return;
    }

    // /start or /reset — kill existing session and ack
    if (text === "/start" || text === "/reset") {
      this.killSession(chatId);
      await this.bot.sendMessage(chatId, "Session reset. Send a message to start.");
      return;
    }

    // /status
    if (text === "/status") {
      const has = this.sessions.has(chatId);
      await this.bot.sendMessage(chatId, has ? "Session active." : "No active session.");
      return;
    }

    const session = this.getOrCreateSession(chatId);
    try {
      session.claude.sendPrompt(text);
    } catch (err) {
      await this.bot.sendMessage(chatId, `Error sending to Claude: ${(err as Error).message}`);
      this.killSession(chatId);
    }
  }

  private getOrCreateSession(chatId: number): Session {
    const existing = this.sessions.get(chatId);
    if (existing && !existing.claude.exited) return existing;

    const claude = new ClaudeProcess({
      cwd: this.opts.cwd,
      token: this.opts.claudeToken,
    });

    const session: Session = {
      claude,
      pendingText: "",
      flushTimer: null,
    };

    claude.on("message", (msg) => this.handleClaudeMessage(chatId, session, msg));
    claude.on("stderr", (data) => {
      // Only surface non-noise stderr
      if (data.includes("Error") || data.includes("error")) {
        console.error(`[claude:${chatId}]`, data.trim());
      }
    });
    claude.on("exit", (code) => {
      console.log(`[claude:${chatId}] exited with code ${code}`);
      this.sessions.delete(chatId);
    });
    claude.on("error", (err) => {
      console.error(`[claude:${chatId}] process error:`, err.message);
      this.bot.sendMessage(chatId, `Claude process error: ${err.message}`).catch(() => {});
      this.sessions.delete(chatId);
    });

    this.sessions.set(chatId, session);
    return session;
  }

  private handleClaudeMessage(chatId: number, session: Session, msg: ClaudeMessage): void {
    // Use only the final `result` message — it contains the complete response text.
    // Ignore `assistant` streaming chunks to avoid duplicates.
    if (msg.type !== "result") return;

    const text = extractText(msg);
    if (!text) return;

    // Accumulate text and debounce — Claude streams chunks rapidly
    session.pendingText += text;

    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = setTimeout(() => this.flushPending(chatId, session), FLUSH_DELAY_MS);
  }

  private flushPending(chatId: number, session: Session): void {
    const text = session.pendingText.trim();
    session.pendingText = "";
    session.flushTimer = null;
    if (!text) return;

    // Telegram max message length is 4096 chars — split if needed
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      this.bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(() => {
        // Markdown parse failed — retry as plain text
        this.bot.sendMessage(chatId, chunk).catch((err) =>
          console.error(`[tg:${chatId}] send failed:`, err.message)
        );
      });
    }
  }

  private killSession(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.claude.kill();
      this.sessions.delete(chatId);
    }
  }

  stop(): void {
    this.bot.stopPolling();
    for (const [chatId] of this.sessions) {
      this.killSession(chatId);
    }
  }
}

function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}
