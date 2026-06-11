/**
 * Notifier — subscribes to Redis pub/sub channels and bridges messages to Telegram.
 *
 * Channels:
 *   cca:notify:{namespace}       — job completion notifications from cc-agent → forward to Telegram
 *   cca:chat:incoming:{namespace} — messages from the web UI → echo to Telegram + feed into Claude session
 *   cca:chat:outgoing:*          — meta-agent stdout lines (source=claude) → buffer+debounce → Telegram
 *
 * All messages (Telegram incoming, Claude responses) are also written to:
 *   cca:chat:log:{namespace}     — LPUSH + LTRIM 0 499 (last 500 messages)
 *   cca:chat:outgoing:{namespace} — PUBLISH for web UI to consume
 */

import { Redis } from "ioredis";
import TelegramBot from "node-telegram-bot-api";
import {
  chatLogKey,
  chatOutgoingChannel,
  chatIncomingChannel,
  notifyChannel,
  notifyListKey,
  metaAgentStatusKey,
  metaInputKey,
  type NotificationPayload,
  type ChatMessage,
} from "@gonzih/cc-wire";
import { splitLongMessage } from "./formatter.js";

export type { ChatMessage };

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn("[notifier]", ...args);
}

/**
 * Shorten a model name for display in a badge.
 * - Strips driver prefix (e.g. "claude-sonnet-4-6" with driver "claude" → "sonnet-4-6")
 * - Strips vendor/ prefix for openrouter-style names (e.g. "openai/gpt-4o" → "gpt-4o")
 * - Returns empty string when model is absent.
 */
function shortenModelName(model: string, driver: string): string {
  if (!model.trim()) return "";
  const pfx = driver.toLowerCase() + "-";
  if (model.toLowerCase().startsWith(pfx)) return model.slice(pfx.length);
  const slashIdx = model.indexOf("/");
  if (slashIdx >= 0) return model.slice(slashIdx + 1);
  return model;
}

/** Strip ANSI escape sequences from a string before sending to Telegram. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}

/**
 * Returns true when the notification payload has discord_only: true.
 * These messages are intended for Discord only and must be silently skipped by Telegram.
 */
export function isDiscordOnly(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as NotificationPayload & { discord_only?: boolean };
    return parsed.discord_only === true;
  } catch {
    return false;
  }
}

/**
 * Returns true when the notification should be skipped by Telegram.
 * Skips when:
 *   - discord_only: true (legacy flag), OR
 *   - routing is a non-empty array that does not include "telegram"
 *
 * Absent or empty routing means deliver everywhere (backward compatible).
 */
export function shouldSkipForTelegram(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as NotificationPayload & { discord_only?: boolean };
    if (parsed.discord_only === true) return true;
    if (Array.isArray(parsed.routing) && parsed.routing.length > 0) {
      return !parsed.routing.includes("telegram");
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse a notification payload and return the display text.
 * Appends a [driver] or [driver:model] badge whenever the driver field is present.
 * Appends " cost: $X.XXX" if a numeric cost field is present.
 *
 * Payload format (JSON): { text: string, driver?: string, model?: string, cost?: number }
 * Falls back to raw string if not valid JSON.
 */
export function parseNotification(raw: string): string {
  let text = raw;
  let driver: string | undefined;
  let model: string | undefined;
  let cost: number | undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPayload>;
    if (parsed.text) text = parsed.text;
    driver = parsed.driver;
    model = parsed.model;
    if (typeof parsed.cost === "number") cost = parsed.cost;
  } catch {
    // not JSON — use raw string as-is, no badge
    return text;
  }

  // Show badge whenever driver field is present
  if (!driver) return text;

  const shortModel = shortenModelName(model ?? "", driver);
  const badge = shortModel ? `${driver}:${shortModel}` : driver;
  const costStr = cost != null ? ` cost: $${cost.toFixed(3)}` : "";
  return `${text}\n[${badge}]${costStr}`;
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
  const logKey = chatLogKey(namespace);
  const outKey = chatOutgoingChannel(namespace);
  const payload = JSON.stringify(msg);
  // LIFO — newest first. Consumers must LRANGE 0 N then reverse for chronological order.
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

export interface NotifierHandle {
  /**
   * Register the originating Telegram chat ID for a routed namespace.
   * When the meta-agent for `namespace` publishes a response, it will be
   * forwarded to `chatId` instead of the global fixed/dynamic chatId.
   * Call this before routing each message to ensure the response returns
   * to the correct chat.
   */
  registerRoutedChatId: (namespace: string, chatId: number) => void;
}

/**
 * Start the notifier.
 *
 * @param bot       - Telegram bot instance (for sending messages)
 * @param chatId    - Telegram chat ID to forward notifications to. Pass null to use getActiveChatId.
 * @param namespace - cc-agent namespace (used to build Redis channel names)
 * @param redis     - ioredis client in normal mode (will be duplicated for pub/sub)
 * @param handleUserMessage    - Optional callback to feed UI messages into the active Claude session
 * @param forwardNotification  - Optional callback to forward job notifications to an existing Claude session only (no session creation)
 * @param getActiveChatId      - Optional callback to resolve chatId dynamically (used when chatId is null)
 *
 * @returns NotifierHandle with registerRoutedChatId for per-namespace response routing
 */
export function startNotifier(
  bot: TelegramBot,
  chatId: number | null,
  namespace: string,
  redis: Redis,
  handleUserMessage?: (chatId: number, text: string) => void,
  forwardNotification?: (chatId: number, text: string) => void,
  getActiveChatId?: () => number | undefined
): NotifierHandle {
  // Per-namespace chatId registry: when a message is routed to a non-default namespace,
  // the originating Telegram chatId is registered here so responses go back to the right chat.
  const routedChatIds = new Map<string, number>();
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

  // notifyChannel(namespace) — forward job completion notifications to Telegram
  sub.subscribe(notifyChannel(namespace), (err) => {
    if (err) {
      log("error", `subscribe ${notifyChannel(namespace)} failed:`, err.message);
    } else {
      log("info", `subscribed to ${notifyChannel(namespace)}`);
    }
  });

  // chatIncomingChannel(namespace) — messages from UI
  sub.subscribe(chatIncomingChannel(namespace), (err) => {
    if (err) {
      log("error", `subscribe ${chatIncomingChannel(namespace)} failed:`, err.message);
    } else {
      log("info", `subscribed to ${chatIncomingChannel(namespace)}`);
    }
  });

  // chatOutgoingChannel("*") — meta-agent stdout lines (source=claude) → buffer+debounce → Telegram
  // Using psubscribe so we catch all namespaces (money-brain, isoc-nevada, etc.)
  sub.psubscribe(chatOutgoingChannel("*"), (err) => {
    if (err) {
      log("error", `psubscribe ${chatOutgoingChannel("*")} failed:`, err.message);
    } else {
      log("info", `psubscribed to ${chatOutgoingChannel("*")}`);
    }
  });

  // 1.5s silence buffer. Combined with cc-agent's 3s poll = up to 4.5s meta-agent response latency.
  const META_AGENT_FLUSH_DELAY_MS = 1500;
  // Per-namespace debounce buffer: accumulate streaming lines, flush after silence
  const metaAgentBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>();

  function flushMetaAgentBuffer(ns: string, targetChatId: number): void {
    const buf = metaAgentBuffers.get(ns);
    if (!buf || !buf.text.trim()) return;
    const text = `← [${ns}] ` + stripAnsi(buf.text.trim());
    buf.text = "";
    buf.timer = null;
    const chunks = splitLongMessage(text);
    for (const chunk of chunks) {
      bot.sendMessage(targetChatId, chunk).catch((err: Error) => {
        log("warn", `meta-agent flush sendMessage failed (ns=${ns}):`, err.message);
      });
    }
  }

  sub.on("pmessage", (pattern: string, channel: string, message: string) => {
    void pattern; // used only as a type guard
    const ns = channel.slice(chatOutgoingChannel("").length);

    let parsed: { source?: string; content?: string } | null = null;
    try {
      parsed = JSON.parse(message) as { source?: string; content?: string };
    } catch {
      return; // non-JSON line — skip
    }

    // Only forward messages from the meta-agent (source=claude).
    // cc-tg itself publishes to this channel with source "cc-tg"/"telegram"/"ui" — skip those.
    if (parsed.source !== "claude") return;

    const content = parsed.content;
    if (!content) return;

    // Per-namespace chatId wins (set by registerRoutedChatId when a message is routed).
    // Falls back to the global fixed chatId or the last-active dynamic chatId.
    const targetChatId = routedChatIds.get(ns) ?? chatId ?? getActiveChatId?.();
    if (targetChatId == null) {
      log("warn", `meta-agent output: no chatId for namespace=${ns}, dropping line`);
      return;
    }

    // Accumulate into per-namespace buffer and (re-)arm debounce timer
    let buf = metaAgentBuffers.get(ns);
    if (!buf) {
      buf = { text: "", timer: null };
      metaAgentBuffers.set(ns, buf);
    }
    buf.text += (buf.text ? "\n" : "") + content;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushMetaAgentBuffer(ns, targetChatId), META_AGENT_FLUSH_DELAY_MS);
  });

  // Poll the notifyListKey(namespace) LIST every 5 seconds.
  // Jobs push to this list via RPUSH; pub/sub alone won't deliver those messages.
  const MAX_PER_CYCLE = 20;

  const pollNotifyList = async (): Promise<void> => {
    const targetId = chatId ?? getActiveChatId?.();
    if (targetId == null) return;

    const items: string[] = [];
    try {
      for (let i = 0; i < MAX_PER_CYCLE; i++) {
        const item = await redis.rpop(notifyListKey(namespace));
        if (item === null) break;
        items.push(item);
      }
    } catch (err) {
      log("warn", "notify list rpop failed:", (err as Error).message);
      return;
    }

    if (items.length === 0) return;

    let remaining = 0;
    if (items.length === MAX_PER_CYCLE) {
      try {
        remaining = await redis.llen(notifyListKey(namespace));
      } catch (err) {
        log("warn", "notify list llen failed:", (err as Error).message);
      }
    }

    for (const raw of items) {
      if (shouldSkipForTelegram(raw)) continue;
      const text = parseNotification(raw);
      bot.sendMessage(targetId, text).catch((err: Error) => {
        log("warn", "notify list sendMessage failed:", err.message);
      });
      if (forwardNotification) {
        forwardNotification(targetId, text);
      }
    }

    if (remaining > 0) {
      bot.sendMessage(targetId, `...and ${remaining} more notifications`).catch((err: Error) => {
        log("warn", "notify list summary sendMessage failed:", err.message);
      });
    }
  };

  setInterval(() => {
    void pollNotifyList();
  }, 5_000);

  sub.on("message", (channel: string, message: string) => {
    const notifyCh = notifyChannel(namespace);
    const incomingCh = chatIncomingChannel(namespace);

    if (channel === notifyCh) {
      if (shouldSkipForTelegram(message)) return;
      const targetId = chatId ?? getActiveChatId?.();
      if (targetId != null) {
        const text = parseNotification(message);
        bot.sendMessage(targetId, text).catch((err: Error) => {
          log("warn", "sendMessage failed:", err.message);
        });
        if (forwardNotification) {
          forwardNotification(targetId, text);
        }
      } else {
        log("warn", "notify: no chatId available, dropping notification");
      }
      return;
    }

    if (channel === incomingCh) {
      let content = message;
      let originalTimestamp: string | undefined;
      try {
        const parsed = JSON.parse(message) as { content?: string; timestamp?: string };
        if (parsed.content) content = parsed.content;
        if (parsed.timestamp) originalTimestamp = parsed.timestamp;
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

        // Log the incoming message — preserve original timestamp from UI if present
        const inMsg: ChatMessage = {
          id: crypto.randomUUID(),
          source: "ui", // 'ui' distinguishes this from telegram/claude messages
          role: "user",
          content,
          // ISO 8601 — matches cc-agent-ui /chat/send format; preserve original if present
          timestamp: originalTimestamp ?? new Date().toISOString(),
          chatId: targetChatId,
        };
        writeChatLog(redis, namespace, inMsg);

        // Check if a meta-agent is running for this namespace; if so, route there instead
        void (async () => {
          let routedToMetaAgent = false;
          try {
            const statusRaw = await redis.get(metaAgentStatusKey(namespace));
            if (statusRaw) {
              const status = JSON.parse(statusRaw) as { status?: string };
              if (status.status === "running") {
                const entry = JSON.stringify({
                  id: crypto.randomUUID(),
                  content,
                  timestamp: new Date().toISOString(),
                });
                // Polled by cc-agent every 3s — up to 3s delivery latency
                await redis.rpush(metaInputKey(namespace), entry);
                log("info", `cca:chat:incoming: routed to meta-agent for namespace ${namespace}`);
                routedToMetaAgent = true;
              }
            }
          } catch (err) {
            log("warn", "meta-agent status check failed, falling back to coordinator:", (err as Error).message);
          }

          if (!routedToMetaAgent && handleUserMessage) {
            handleUserMessage(targetChatId, content);
          }
        })();
      } else {
        log("warn", "cca:chat:incoming: no active chatId to route message to");
      }
    }
  });

  return {
    registerRoutedChatId: (ns: string, cid: number) => {
      routedChatIds.set(ns, cid);
    },
  };
}
