/**
 * Notifier — subscribes to Redis pub/sub channels and bridges messages to Telegram.
 *
 * Channels:
 *   cca:notify:{namespace}       — job completion notifications from cc-agent → forward to Telegram
 *   cca:chat:incoming:{namespace} — messages from the web UI → echo to Telegram + feed into Claude session
 *
 * All messages (Telegram incoming, Claude responses) are also written to:
 *   cca:chat:log:{namespace}     — LPUSH + LTRIM 0 499 (last 500 messages)
 *   cca:chat:outgoing:{namespace} — PUBLISH for web UI to consume
 */

import { Redis } from "ioredis";
import TelegramBot from "node-telegram-bot-api";

export interface ChatMessage {
  id: string;
  source: "telegram" | "ui" | "claude" | "cc-tg";
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  chatId: number;
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn("[notifier]", ...args);
}

/**
 * Write a message to the chat log in Redis.
 * Fire-and-forget — errors are logged but not thrown.
 */
export function writeChatLog(
  redis: Redis,
  namespace: string,
  msg: ChatMessage
): void {
  const logKey = `cca:chat:log:${namespace}`;
  const outKey = `cca:chat:outgoing:${namespace}`;
  const payload = JSON.stringify(msg);
  redis.lpush(logKey, payload).catch((err: Error) => {
    log("warn", "writeChatLog lpush failed:", err.message);
  });
  redis.ltrim(logKey, 0, 499).catch((err: Error) => {
    log("warn", "writeChatLog ltrim failed:", err.message);
  });
  redis.publish(outKey, payload).catch((err: Error) => {
    log("warn", "writeChatLog publish failed:", err.message);
  });
}

/**
 * Start the notifier.
 *
 * @param bot       - Telegram bot instance (for sending messages)
 * @param chatId    - Telegram chat ID to forward notifications to. Pass null to use getActiveChatId.
 * @param namespace - cc-agent namespace (used to build Redis channel names)
 * @param redis     - ioredis client in normal mode (will be duplicated for pub/sub)
 * @param handleUserMessage - Optional callback to feed UI messages into the active Claude session
 * @param getActiveChatId   - Optional callback to resolve chatId dynamically (used when chatId is null)
 */
export function startNotifier(
  bot: TelegramBot,
  chatId: number | null,
  namespace: string,
  redis: Redis,
  handleUserMessage?: (chatId: number, text: string) => void,
  getActiveChatId?: () => number | undefined
): void {
  const sub = redis.duplicate({
    retryStrategy: (times: number) => {
      const delay = Math.min(1000 * Math.pow(2, times - 1), 30_000);
      log("info", `subscriber reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  sub.on("error", (err: Error) => {
    log("warn", "subscriber error:", err.message);
  });

  sub.on("close", () => {
    log("info", "subscriber disconnected, will reconnect with backoff");
  });

  // cca:notify:{namespace} — forward job completion notifications to Telegram
  sub.subscribe(`cca:notify:${namespace}`, (err) => {
    if (err) {
      log("error", `subscribe cca:notify:${namespace} failed:`, err.message);
    } else {
      log("info", `subscribed to cca:notify:${namespace}`);
    }
  });

  // cca:chat:incoming:{namespace} — messages from UI
  sub.subscribe(`cca:chat:incoming:${namespace}`, (err) => {
    if (err) {
      log("error", `subscribe cca:chat:incoming:${namespace} failed:`, err.message);
    } else {
      log("info", `subscribed to cca:chat:incoming:${namespace}`);
    }
  });

  sub.on("message", (channel: string, message: string) => {
    const notifyChannel = `cca:notify:${namespace}`;
    const incomingChannel = `cca:chat:incoming:${namespace}`;

    if (channel === notifyChannel) {
      if (chatId !== null) {
        bot.sendMessage(chatId, message).catch((err: Error) => {
          log("warn", "sendMessage failed:", err.message);
        });
      }
      return;
    }

    if (channel === incomingChannel) {
      let content = message;
      try {
        const parsed = JSON.parse(message) as { content?: string };
        if (parsed.content) content = parsed.content;
      } catch {
        // raw string message — use as-is
      }

      // Resolve the target chatId: prefer the fixed chatId, fall back to last active
      const targetChatId = chatId ?? getActiveChatId?.();

      if (targetChatId !== undefined) {
        // Echo to Telegram so the user sees UI messages in the chat
        bot.sendMessage(targetChatId, `📱 [from UI]: ${content}`).catch((err: Error) => {
          log("warn", "sendMessage (UI echo) failed:", err.message);
        });

        // Log the incoming message
        const inMsg: ChatMessage = {
          id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: "ui",
          role: "user",
          content,
          timestamp: new Date().toISOString(),
          chatId: targetChatId,
        };
        writeChatLog(redis, namespace, inMsg);

        // Feed into active Claude session as if user typed it
        if (handleUserMessage) {
          handleUserMessage(targetChatId, content);
        }
      } else {
        log("warn", "cca:chat:incoming: no active chatId to route message to");
      }
    }
  });
}
