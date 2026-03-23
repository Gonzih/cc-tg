/**
 * Claude Code subprocess wrapper.
 * Mirrors ce_ce's mechanism: spawn `claude` CLI with stream-json I/O,
 * pipe prompts in, parse streaming JSON messages out.
 */

import { spawn, ChildProcessWithoutNullStreams, execFileSync } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";

export type MessageType = "system" | "assistant" | "user" | "result";

export interface ClaudeMessage {
  type: MessageType;
  session_id?: string;
  uuid?: string;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ClaudeOptions {
  cwd?: string;
  systemPrompt?: string;
  /** OAuth token (sk-ant-oat01-...) or API key (sk-ant-api03-...) */
  token?: string;
}

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export declare interface ClaudeProcess {
  on(event: "message", listener: (msg: ClaudeMessage) => void): this;
  on(event: "usage", listener: (usage: UsageEvent) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "stderr", listener: (data: string) => void): this;
}

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private _exited = false;

  constructor(opts: ClaudeOptions = {}) {
    super();

    const args = [
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.token) {
      // API keys start with sk-ant-api — set ANTHROPIC_API_KEY only
      // Everything else (OAuth sk-ant-oat, setup-token format with #, etc.)
      // goes into CLAUDE_CODE_OAUTH_TOKEN
      // Mixing them causes "Invalid API key" errors
      if (opts.token.startsWith("sk-ant-api")) {
        env.ANTHROPIC_API_KEY = opts.token;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        env.CLAUDE_CODE_OAUTH_TOKEN = opts.token;
        delete env.ANTHROPIC_API_KEY;
      }
    }

    // Resolve claude binary — check common install locations if not in PATH
    const claudeBin = resolveClaude(env.PATH);

    this.proc = spawn(claudeBin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    });

    this.proc.on("exit", (code) => {
      this._exited = true;
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  sendPrompt(text: string): void {
    if (this._exited) throw new Error("Claude process has exited");
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    this.proc.stdin.write(payload + "\n");
  }

  /**
   * Send an image (with optional text caption) to Claude via stream-json content blocks.
   * mediaType: image/jpeg | image/png | image/gif | image/webp
   */
  sendImage(base64Data: string, mediaType: string, caption?: string): void {
    if (this._exited) throw new Error("Claude process has exited");
    const content: unknown[] = [];
    if (caption) {
      content.push({ type: "text", text: caption });
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64Data,
      },
    });
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    this.proc.stdin.write(payload + "\n");
  }

  kill(): void {
    this.proc.kill();
  }

  get exited(): boolean {
    return this._exited;
  }

  private drainBuffer(): void {
    const lines = this.buffer.split("\n");
    // Last element may be incomplete — keep it
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Non-JSON line (startup noise etc.) — ignore
        continue;
      }

      // Emit usage events from Anthropic API stream events passed through by Claude CLI
      if (raw.type === "message_start") {
        const usage = ((raw.message as Record<string, unknown> | undefined)?.usage) as Record<string, number> | undefined;
        if (usage) {
          this.emit("usage", {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: 0, // output_tokens at message_start is always 0
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          } satisfies UsageEvent);
        }
      } else if (raw.type === "message_delta") {
        const usage = raw.usage as Record<string, number> | undefined;
        if (usage?.output_tokens) {
          this.emit("usage", {
            inputTokens: 0,
            outputTokens: usage.output_tokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          } satisfies UsageEvent);
        }
      }

      const msg = this.parseMessage(raw);
      if (msg) this.emit("message", msg);
    }
  }

  private parseMessage(raw: Record<string, unknown>): ClaudeMessage | null {
    const type = raw.type as MessageType | undefined;
    if (!type) return null;

    return {
      type,
      session_id: raw.session_id as string | undefined,
      uuid: raw.uuid as string | undefined,
      payload: raw,
      raw,
    };
  }
}

/**
 * Extract the text content from an assistant message payload.
 * Handles both simple string content and content-block arrays.
 */
export function extractText(msg: ClaudeMessage): string {
  const message = msg.payload.message as Record<string, unknown> | undefined;
  if (!message) {
    // result message type
    if (msg.type === "result") {
      return (msg.payload.result as string) ?? "";
    }
    return "";
  }

  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("");
  }
  return "";
}

/**
 * Resolve the claude CLI binary path.
 * Checks PATH entries + common npm global install locations.
 */
function resolveClaude(pathEnv?: string): string {
  // Try PATH entries first
  const dirs = (pathEnv ?? process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    const candidate = `${dir}/claude`;
    if (existsSync(candidate)) return candidate;
  }

  // Common fallback locations
  const fallbacks = [
    `${process.env.HOME}/.npm-global/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }

  // Last resort — let the OS resolve it (will throw ENOENT if missing)
  return "claude";
}
