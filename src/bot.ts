/**
 * Telegram bot that routes messages to/from a Claude Code subprocess.
 * One ClaudeProcess per chat_id — sessions are isolated per user.
 */

import TelegramBot from "node-telegram-bot-api";
import { existsSync, createWriteStream, mkdirSync } from "fs";
import { resolve, basename, join } from "path";
import https from "https";
import http from "http";
import { ClaudeProcess, extractText, ClaudeMessage } from "./claude.js";
import { transcribeVoice, isVoiceAvailable } from "./voice.js";
import { CronManager } from "./cron.js";

export interface BotOptions {
  telegramToken: string;
  claudeToken?: string;
  cwd?: string;
  allowedUserIds?: number[];
}

interface Session {
  claude: ClaudeProcess;
  pendingText: string;
  pendingPrefix: string; // prepended to next flushed message (used by cron)
  flushTimer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;
  lastMessageId?: number;
  /** Files written by Claude tools during this turn — cleared after each result */
  writtenFiles: Set<string>;
}

const FLUSH_DELAY_MS = 800; // debounce streaming chunks into one Telegram message
const TYPING_INTERVAL_MS = 4000; // re-send typing action before Telegram's 5s expiry

export class CcTgBot {
  private bot: TelegramBot;
  private sessions = new Map<number, Session>();
  private opts: BotOptions;
  private cron: CronManager;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.bot = new TelegramBot(opts.telegramToken, { polling: true });
    this.bot.on("message", (msg) => this.handleTelegram(msg));
    this.bot.on("polling_error", (err) => console.error("[tg]", err.message));

    // Cron manager — fires prompts into user sessions on schedule
    this.cron = new CronManager(opts.cwd ?? process.cwd(), (chatId, prompt) => {
      const session = this.getOrCreateSession(chatId);
      try {
        session.claude.sendPrompt(`[CRON: ${prompt}]\n\n${prompt}`);
        this.startTyping(chatId, session);
        // Tag result with cron prefix
        session.pendingPrefix = `CRON: ${prompt}\n\n`;
      } catch (err) {
        console.error(`[cron] failed to fire for chat=${chatId}:`, (err as Error).message);
      }
    });

    console.log("cc-tg bot started");
    console.log(`[voice] whisper available: ${isVoiceAvailable()}`);
  }

  private isAllowed(userId: number): boolean {
    if (!this.opts.allowedUserIds?.length) return true;
    return this.opts.allowedUserIds.includes(userId);
  }

  private async handleTelegram(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (!this.isAllowed(userId)) {
      await this.bot.sendMessage(chatId, "Not authorized.");
      return;
    }

    // Voice message — transcribe then feed as text
    if (msg.voice || msg.audio) {
      await this.handleVoice(chatId, msg);
      return;
    }

    // Photo — send as base64 image content block to Claude
    if (msg.photo?.length) {
      await this.handlePhoto(chatId, msg);
      return;
    }

    // Document — download to CWD/.cc-tg/uploads/, tell Claude the path
    if (msg.document) {
      await this.handleDocument(chatId, msg);
      return;
    }

    const text = msg.text?.trim();

    if (!text) return;

    // /start or /reset — kill existing session and ack
    if (text === "/start" || text === "/reset") {
      this.killSession(chatId);
      await this.bot.sendMessage(chatId, "Session reset. Send a message to start.");
      return;
    }

    // /stop — kill active session (interrupt running Claude task)
    if (text === "/stop") {
      const has = this.sessions.has(chatId);
      this.killSession(chatId);
      await this.bot.sendMessage(chatId, has ? "Stopped." : "No active session.");
      return;
    }

    // /status
    if (text === "/status") {
      const has = this.sessions.has(chatId);
      await this.bot.sendMessage(chatId, has ? "Session active." : "No active session.");
      return;
    }

    // /cron <schedule> <prompt> | /cron list | /cron clear | /cron remove <id>
    if (text.startsWith("/cron")) {
      await this.handleCron(chatId, text);
      return;
    }

    const session = this.getOrCreateSession(chatId);
    try {
      session.claude.sendPrompt(text);
      this.startTyping(chatId, session);
    } catch (err) {
      await this.bot.sendMessage(chatId, `Error sending to Claude: ${(err as Error).message}`);
      this.killSession(chatId);
    }
  }

  private async handleVoice(chatId: number, msg: TelegramBot.Message): Promise<void> {
    const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
    if (!fileId) return;

    console.log(`[voice:${chatId}] received voice message, transcribing...`);
    this.bot.sendChatAction(chatId, "typing").catch(() => {});

    try {
      const fileLink = await this.bot.getFileLink(fileId);
      const transcript = await transcribeVoice(fileLink);
      console.log(`[voice:${chatId}] transcribed: ${transcript}`);

      if (!transcript || transcript === "[empty transcription]") {
        await this.bot.sendMessage(chatId, "Could not transcribe voice message.");
        return;
      }

      // Feed transcript into Claude as if user typed it
      const session = this.getOrCreateSession(chatId);
      try {
        session.claude.sendPrompt(transcript);
        this.startTyping(chatId, session);
      } catch (err) {
        await this.bot.sendMessage(chatId, `Error sending to Claude: ${(err as Error).message}`);
        this.killSession(chatId);
      }
    } catch (err) {
      console.error(`[voice:${chatId}] error:`, (err as Error).message);
      await this.bot.sendMessage(chatId, `Voice transcription failed: ${(err as Error).message}`);
    }
  }

  private async handlePhoto(chatId: number, msg: TelegramBot.Message): Promise<void> {
    // Pick highest resolution photo
    const photos = msg.photo!;
    const best = photos[photos.length - 1];
    const caption = msg.caption?.trim();

    console.log(`[photo:${chatId}] received image file_id=${best.file_id}`);
    this.bot.sendChatAction(chatId, "typing").catch(() => {});

    try {
      const fileLink = await this.bot.getFileLink(best.file_id);
      const imageData = await fetchAsBase64(fileLink);
      // Telegram photos are always JPEG
      const session = this.getOrCreateSession(chatId);
      session.claude.sendImage(imageData, "image/jpeg", caption);
      this.startTyping(chatId, session);
    } catch (err) {
      console.error(`[photo:${chatId}] error:`, (err as Error).message);
      await this.bot.sendMessage(chatId, `Failed to process image: ${(err as Error).message}`);
    }
  }

  private async handleDocument(chatId: number, msg: TelegramBot.Message): Promise<void> {
    const doc = msg.document!;
    const caption = msg.caption?.trim();
    const fileName = doc.file_name ?? `file_${doc.file_id}`;

    console.log(`[doc:${chatId}] received document file_name=${fileName} mime=${doc.mime_type}`);
    this.bot.sendChatAction(chatId, "typing").catch(() => {});

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

      const session = this.getOrCreateSession(chatId);
      session.claude.sendPrompt(prompt);
      this.startTyping(chatId, session);
    } catch (err) {
      console.error(`[doc:${chatId}] error:`, (err as Error).message);
      await this.bot.sendMessage(chatId, `Failed to receive document: ${(err as Error).message}`);
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
      pendingPrefix: "",
      flushTimer: null,
      typingTimer: null,
      writtenFiles: new Set(),
    };

    claude.on("message", (msg) => {
      // Verbose logging — log every message type and subtype
      const subtype = (msg.payload.subtype as string) ?? "";
      const toolName = this.extractToolName(msg);
      const logParts = [`[claude:${chatId}] msg=${msg.type}`];
      if (subtype) logParts.push(`subtype=${subtype}`);
      if (toolName) logParts.push(`tool=${toolName}`);
      console.log(logParts.join(" "));

      // Track files written by Write/Edit tool calls
      this.trackWrittenFiles(msg, session, this.opts.cwd);

      this.handleClaudeMessage(chatId, session, msg);
    });
    claude.on("stderr", (data) => {
      const line = data.trim();
      if (line) console.error(`[claude:${chatId}:stderr]`, line);
    });
    claude.on("exit", (code) => {
      console.log(`[claude:${chatId}] exited code=${code}`);
      this.stopTyping(session);
      this.sessions.delete(chatId);
    });
    claude.on("error", (err) => {
      console.error(`[claude:${chatId}] process error: ${err.message}`);
      this.bot.sendMessage(chatId, `Claude process error: ${err.message}`).catch(() => {});
      this.stopTyping(session);
      this.sessions.delete(chatId);
    });

    this.sessions.set(chatId, session);
    return session;
  }

  private handleClaudeMessage(chatId: number, session: Session, msg: ClaudeMessage): void {
    // Use only the final `result` message — it contains the complete response text.
    // Ignore `assistant` streaming chunks to avoid duplicates.
    if (msg.type !== "result") return;

    this.stopTyping(session);

    const text = extractText(msg);
    if (!text) return;

    // Accumulate text and debounce — Claude streams chunks rapidly
    session.pendingText += text;

    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = setTimeout(() => this.flushPending(chatId, session), FLUSH_DELAY_MS);
  }

  private startTyping(chatId: number, session: Session): void {
    this.stopTyping(session);
    // Send immediately, then keep alive every 4s
    this.bot.sendChatAction(chatId, "typing").catch(() => {});
    session.typingTimer = setInterval(() => {
      this.bot.sendChatAction(chatId, "typing").catch(() => {});
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
    const prefix = session.pendingPrefix;
    session.pendingText = "";
    session.pendingPrefix = "";
    session.flushTimer = null;
    if (!raw) return;

    const text = prefix ? `${prefix}${raw}` : raw;

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

    // Hybrid file upload: find files mentioned in result text that Claude actually wrote
    this.uploadMentionedFiles(chatId, text, session);
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
      if (!["Write", "Edit", "NotebookEdit"].includes(name)) continue;

      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;

      // Write tool uses file_path, Edit uses file_path
      const filePath = (input.file_path as string) ?? (input.path as string);
      if (!filePath) continue;

      // Resolve relative paths against cwd
      const resolved = filePath.startsWith("/")
        ? filePath
        : resolve(cwd ?? process.cwd(), filePath);

      console.log(`[claude:files] tracked written file: ${resolved}`);
      session.writtenFiles.add(resolved);
    }
  }

  private isSensitiveFile(filePath: string): boolean {
    const name = basename(filePath).toLowerCase();
    const sensitivePatterns = [
      /credential/i, /secret/i, /password/i, /passwd/i, /\.env/i,
      /api[_-]?key/i, /token/i, /private[_-]?key/i, /id_rsa/i,
      /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i,
      /gmail/i, /oauth/i, /auth/i,
    ];
    return sensitivePatterns.some((p) => p.test(name));
  }

  private uploadMentionedFiles(chatId: number, resultText: string, session: Session): void {
    if (session.writtenFiles.size === 0) return;

    // Extract file path candidates from result text
    // Match: /absolute/path/file.ext or relative like ./foo/bar.csv or just foo.pdf
    const pathPattern = /(?:^|[\s`'"(])(\/?[\w.\-/]+\.[\w]{1,10})(?:[\s`'")\n]|$)/gm;
    const candidates = new Set<string>();
    let match;
    while ((match = pathPattern.exec(resultText)) !== null) {
      candidates.add(match[1]);
    }

    const toUpload: string[] = [];
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

    // Deduplicate and filter sensitive files
    const unique = [...new Set(toUpload)];
    for (const filePath of unique) {
      if (this.isSensitiveFile(filePath)) {
        console.log(`[claude:files] skipping sensitive file: ${filePath}`);
        continue;
      }
      console.log(`[claude:files] uploading to telegram: ${filePath}`);
      this.bot.sendDocument(chatId, filePath).catch((err) =>
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

  private async handleCron(chatId: number, text: string): Promise<void> {
    const args = text.slice("/cron".length).trim();

    // /cron list
    if (args === "list" || args === "") {
      const jobs = this.cron.list(chatId);
      if (!jobs.length) {
        await this.bot.sendMessage(chatId, "No cron jobs.");
        return;
      }
      const lines = jobs.map((j) => `[${j.id}] ${j.schedule}: ${j.prompt}`);
      await this.bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    // /cron clear
    if (args === "clear") {
      const n = this.cron.clearAll(chatId);
      await this.bot.sendMessage(chatId, `Cleared ${n} cron job(s).`);
      return;
    }

    // /cron remove <id>
    if (args.startsWith("remove ")) {
      const id = args.slice("remove ".length).trim();
      const ok = this.cron.remove(chatId, id);
      await this.bot.sendMessage(chatId, ok ? `Removed ${id}.` : `Not found: ${id}`);
      return;
    }

    // /cron every 1h <prompt>
    const scheduleMatch = args.match(/^(every\s+\d+[mhd])\s+(.+)$/i);
    if (!scheduleMatch) {
      await this.bot.sendMessage(
        chatId,
        "Usage:\n/cron every 1h <prompt>\n/cron list\n/cron remove <id>\n/cron clear"
      );
      return;
    }

    const schedule = scheduleMatch[1];
    const prompt = scheduleMatch[2];
    const job = this.cron.add(chatId, schedule, prompt);
    if (!job) {
      await this.bot.sendMessage(chatId, "Invalid schedule. Use: every 30m / every 2h / every 1d");
      return;
    }
    await this.bot.sendMessage(chatId, `Cron set [${job.id}]: ${schedule} — "${prompt}"`);
  }

  private killSession(chatId: number, keepCrons = true): void {
    const session = this.sessions.get(chatId);
    if (session) {
      this.stopTyping(session);
      session.claude.kill();
      this.sessions.delete(chatId);
    }
    if (!keepCrons) this.cron.clearAll(chatId);
  }

  stop(): void {
    this.bot.stopPolling();
    for (const [chatId] of this.sessions) {
      this.killSession(chatId);
    }
  }
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
