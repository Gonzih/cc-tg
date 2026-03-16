/**
 * Claude Code subprocess wrapper.
 * Mirrors ce_ce's mechanism: spawn `claude` CLI with stream-json I/O,
 * pipe prompts in, parse streaming JSON messages out.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

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
  /** CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY value */
  token?: string;
}

export declare interface ClaudeProcess {
  on(event: "message", listener: (msg: ClaudeMessage) => void): this;
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
      "--continue",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--print",
      "--verbose",
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.token) {
      // Try as OAuth token first; Claude Code accepts both env vars
      env.CLAUDE_CODE_OAUTH_TOKEN = opts.token;
    }

    this.proc = spawn("claude", args, {
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
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const msg = this.parseMessage(raw);
        if (msg) this.emit("message", msg);
      } catch {
        // Non-JSON line (startup noise etc.) — ignore
      }
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
