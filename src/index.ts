#!/usr/bin/env node
/**
 * cc-tg — Claude Code Telegram bot
 *
 * Usage:
 *   npx @gonzih/cc-tg
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   CLAUDE_CODE_TOKEN    — your Claude Code OAuth token (or ANTHROPIC_API_KEY)
 *
 * Optional env:
 *   ALLOWED_USER_IDS     — comma-separated Telegram user IDs (leave empty to allow all)
 *   GROUP_CHAT_IDS       — comma-separated Telegram group/supergroup chat IDs (leave empty to allow all groups)
 *   CWD                  — working directory for Claude Code (default: process.cwd())
 */

import { createServer, createConnection } from "net";
import { unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import os from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import { CcTgBot } from "./bot.js";
import { loadTokens, getTokenCount } from "./tokens.js";
import { Registry, startControlServer } from "@gonzih/agent-ops";
import { Redis } from "ioredis";
import { startNotifier } from "./notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

// Make lock socket unique per bot token so multiple users on the same machine don't collide
const _tokenHash = Buffer.from(process.env.TELEGRAM_BOT_TOKEN ?? "default").toString("base64").replace(/[^a-z0-9]/gi, "").slice(0, 16);
const LOCK_SOCKET = join(tmpdir(), `cc-tg-${_tokenHash}.sock`);

function acquireLock(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.listen(LOCK_SOCKET, () => {
      // Bound successfully — we own the lock. Socket auto-released on any exit incl. SIGKILL.
      resolve(true);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        resolve(true); // unrelated error, proceed
        return;
      }
      // Socket path exists — probe if anything is actually listening
      const probe = createConnection(LOCK_SOCKET);
      probe.on("connect", () => {
        probe.destroy();
        console.error("[cc-tg] Another instance is already running. Exiting.");
        resolve(false);
      });
      probe.on("error", () => {
        // Nothing listening — stale socket, remove and retry
        try { unlinkSync(LOCK_SOCKET); } catch {}
        const retry = createServer();
        retry.listen(LOCK_SOCKET, () => resolve(true));
        retry.on("error", () => resolve(true)); // give up on lock, just start
      });
    });
  });
}

const lockAcquired = await acquireLock();
if (!lockAcquired) {
  process.exit(1);
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`
ERROR: ${name} is not set.

cc-tg requires:
  TELEGRAM_BOT_TOKEN   — get one from @BotFather on Telegram
  CLAUDE_CODE_TOKEN    — your Claude Code OAuth token

Set them and run again:
  TELEGRAM_BOT_TOKEN=xxx CLAUDE_CODE_TOKEN=yyy npx @gonzih/cc-tg

Or add to your shell profile / .env file.
`);
    process.exit(1);
  }
  return val;
}

const telegramToken = required("TELEGRAM_BOT_TOKEN");

// Accept CLAUDE_CODE_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY
const claudeToken =
  process.env.CLAUDE_CODE_TOKEN ??
  process.env.CLAUDE_CODE_OAUTH_TOKEN ??
  process.env.ANTHROPIC_API_KEY;

if (!claudeToken) {
  console.error(`
ERROR: No Claude token set. Set one of: CLAUDE_CODE_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY.

Set one and run again:
  TELEGRAM_BOT_TOKEN=xxx CLAUDE_CODE_TOKEN=yyy npx @gonzih/cc-tg
`);
  process.exit(1);
}

// Load OAuth token pool (supports CLAUDE_CODE_OAUTH_TOKENS for multi-account rotation)
const tokenPool = loadTokens();
if (tokenPool.length > 1) {
  console.log(`[cc-tg] Token pool loaded: ${tokenPool.length} tokens — will rotate on usage limit`);
}

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : [];

const groupChatIds = process.env.GROUP_CHAT_IDS
  ? process.env.GROUP_CHAT_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : [];

const cwd = process.env.CWD ?? process.cwd();

const bot = new CcTgBot({
  telegramToken,
  claudeToken,
  cwd,
  allowedUserIds,
  groupChatIds,
});

// agent-ops: optional self-registration + HTTP control endpoint
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const namespace = process.env.CC_AGENT_NAMESPACE || "default";
let sharedRedis: Redis | null = null;

if (process.env.CC_AGENT_OPS_PORT) {
  const botInfo = await bot.getMe();
  sharedRedis = new Redis(redisUrl);
  const registry = new Registry(sharedRedis);
  await registry.register({
    namespace,
    hostname: os.hostname(),
    user: os.userInfo().username,
    pid: String(process.pid),
    version: pkg.version,
    cwd: process.env.CWD || process.cwd(),
    control_port: process.env.CC_AGENT_OPS_PORT,
    bot_username: botInfo.username ?? "",
    started_at: new Date().toISOString(),
  });
  setInterval(() => registry.heartbeat(namespace), 60_000);
  startControlServer(Number(process.env.CC_AGENT_OPS_PORT), {
    namespace,
    version: pkg.version,
    logFile: process.env.CC_AGENT_LOG_FILE || process.env.LOG_FILE,
  });
  console.log(`[ops] control server on port ${process.env.CC_AGENT_OPS_PORT}`);
}

// Notifier — subscribe to cca:notify:{namespace} and cca:chat:incoming:{namespace}
const notifyChatId = process.env.CC_AGENT_NOTIFY_CHAT_ID
  ? Number(process.env.CC_AGENT_NOTIFY_CHAT_ID)
  : null;

if (notifyChatId) {
  if (!sharedRedis) sharedRedis = new Redis(redisUrl);
  const notifierBot = new TelegramBot(telegramToken, { polling: false });
  startNotifier(notifierBot, notifyChatId, namespace, sharedRedis);
  console.log(`[notifier] started for namespace=${namespace} chatId=${notifyChatId}`);
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});
