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
 *   CWD                  — working directory for Claude Code (default: process.cwd())
 */

import { CcTgBot } from "./bot.js";

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

// Accept either CLAUDE_CODE_TOKEN or ANTHROPIC_API_KEY
const claudeToken =
  process.env.CLAUDE_CODE_TOKEN ??
  process.env.ANTHROPIC_API_KEY;

if (!claudeToken) {
  console.error(`
ERROR: Neither CLAUDE_CODE_TOKEN nor ANTHROPIC_API_KEY is set.

Set one and run again:
  TELEGRAM_BOT_TOKEN=xxx CLAUDE_CODE_TOKEN=yyy npx @gonzih/cc-tg
`);
  process.exit(1);
}

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : [];

const cwd = process.env.CWD ?? process.cwd();

const bot = new CcTgBot({
  telegramToken,
  claudeToken,
  cwd,
  allowedUserIds,
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});
