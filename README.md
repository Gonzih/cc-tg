# cc-tg

Claude Code Telegram bot — chat with Claude Code from Telegram. Supports voice messages, images, file uploads, scheduled prompts, and automatic file delivery. v0.2.9.

## Quickstart

**Step 1** — create a Telegram bot via [@BotFather](https://t.me/BotFather), get your token.

**Step 2** — run:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token CLAUDE_CODE_TOKEN=your_claude_token npx @gonzih/cc-tg
```

That's it. Open your bot in Telegram and start chatting.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `CLAUDE_CODE_TOKEN` | yes* | Claude Code OAuth token (starts with `sk-ant-oat`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes* | Alias for `CLAUDE_CODE_TOKEN` |
| `ANTHROPIC_API_KEY` | yes* | Alternative — API key from console.anthropic.com |
| `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
| `CWD` | no | Working directory for Claude Code. Defaults to current directory |

*One of `CLAUDE_CODE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` is required.

## How to get your Claude Code token

Run this once to generate a long-lived OAuth token:

```bash
npx @anthropic-ai/claude-code setup-token
```

It opens a browser, logs you in with your Anthropic account, and prints a token starting with `sk-ant-oat`. Paste that as `CLAUDE_CODE_TOKEN`.

## How to get your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your numeric ID.

## Bot commands

| Command | Action |
|---|---|
| `/start` or `/reset` | Kill current Claude session and start fresh |
| `/stop` | Interrupt the running Claude task |
| `/status` | Check if a session is active |
| `/help` | Show all available commands |
| `/cron every 1h <prompt>` | Schedule a recurring prompt |
| `/cron list` | Show active cron jobs |
| `/cron edit` | Show numbered list with edit instructions |
| `/cron edit <#> every <N><unit> <new prompt>` | Update schedule and prompt for a cron job |
| `/cron edit <#> schedule every <N><unit>` | Update schedule only |
| `/cron edit <#> prompt <new prompt>` | Update prompt only |
| `/cron remove <id>` | Remove a specific cron job by ID |
| `/cron clear` | Remove all cron jobs |
| `/reload_mcp` | Send SIGTERM to the cc-agent MCP server process so it restarts fresh |
| `/mcp_version` | Show the published cc-agent npm version and npx cache contents |
| `/clear_npx_cache` | Wipe `~/.npm/_npx/` and restart the MCP process to pick up latest version |
| `/restart` | Restart the cc-tg bot process in-place (useful for updates without SSH) |
| Any text | Sent directly to Claude Code |
| Voice message | Transcribed via whisper.cpp and sent to Claude |
| Photo | Sent as native image input to Claude (base64 content block) |
| Document / file | Downloaded to `<CWD>/.cc-tg/uploads/`, path passed to Claude as `ATTACHMENTS: [name](path)` |

## Features

### Persistent sessions
Each Telegram chat ID gets its own isolated Claude Code subprocess. Sessions survive between messages — Claude remembers context within a conversation. `/reset` starts a fresh session.

### Voice messages
Send a voice message → automatically transcribed via whisper.cpp → fed into Claude as text. Requires `whisper-cpp` and `ffmpeg` installed on the host.

### Images
Send a photo → downloaded and base64-encoded → sent to Claude as a native image content block via the stream-JSON protocol. Claude sees the full image, no intermediate vision step. Caption (if any) is included as text alongside the image.

### Documents
Send any file as a document → downloaded to `<CWD>/.cc-tg/uploads/<filename>` → Claude receives the path as `ATTACHMENTS: [filename](path)` and can read/process it directly. Works for PDFs, CSVs, code files, etc.

### File delivery
When Claude writes a file and mentions it in the response, the bot automatically uploads it to Telegram. Hybrid detection: tracks `Write`/`Edit`/`NotebookEdit` tool calls during the session, cross-references with filenames mentioned in the final response. Sensitive files (credentials, keys, `.env`, tokens) are silently skipped.

### Cron jobs
Schedule recurring prompts that fire into your Claude session on a timer:

```
/cron every 1h check whale-watcher logs and summarize any new large trades
/cron every 6h run the market scan and save results to daily-report.md
/cron every 30m ping the API and alert me if anything looks off
```

Supported units: `m` (minutes), `h` (hours), `d` (days).

Cron jobs persist to `<CWD>/.cc-tg/crons.json` and are restored on bot restart. Output is prefixed with `CRON: <prompt>` so you know what triggered it. Files written by cron jobs are uploaded the same way as regular responses.

### MCP server management
cc-tg can manage the lifecycle of the [cc-agent](https://github.com/Gonzih/cc-agent) MCP server that Claude Code uses as a tool. `/reload_mcp` sends SIGTERM to the running cc-agent process, causing Claude Code to restart it fresh on the next call. `/mcp_version` reports the currently published npm version alongside npx cache entries, and `/clear_npx_cache` wipes the npx cache so the next invocation pulls the latest published version.

### In-place bot restart
`/restart` respawns the cc-tg process without dropping the Telegram polling session — useful when you've published a new version and want to pick it up without SSH access.

### Typing indicator
While Claude is working, the bot sends a continuous typing indicator so you know it's active.

### Permissions
Runs Claude Code with `--dangerously-skip-permissions` — no confirmation prompts blocking headless execution.

## How it works

Spawns a `claude` CLI subprocess per chat session using the stream-JSON protocol. Prompts pipe in via stdin, streaming JSON responses parse out. Only the final `result` message is forwarded to Telegram — no duplicate streaming chunks. Long responses are split into 4096-character chunks to stay within Telegram's message size limit, and Markdown parse failures automatically fall back to plain text.

## Run persistently

### macOS launchd

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.cc-tg</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>-y</string>
        <string>@gonzih/cc-tg</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>your_token</string>
        <key>CLAUDE_CODE_TOKEN</key>
        <string>your_claude_token</string>
        <key>ALLOWED_USER_IDS</key>
        <string>your_telegram_id</string>
        <key>CWD</key>
        <string>/Users/you/your-project</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/Users/you/your-project</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/cc-tg.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cc-tg.log</string>
</dict>
</plist>
```

Save to `~/Library/LaunchAgents/com.yourname.cc-tg.plist`, then:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.cc-tg.plist
```

### Linux systemd

```ini
[Unit]
Description=cc-tg Claude Code Telegram bot

[Service]
Environment=TELEGRAM_BOT_TOKEN=xxx
Environment=CLAUDE_CODE_TOKEN=yyy
Environment=ALLOWED_USER_IDS=123456789
Environment=CWD=/home/you/your-project
WorkingDirectory=/home/you/your-project
ExecStart=npx -y @gonzih/cc-tg
Restart=always

[Install]
WantedBy=multi-user.target
```

## Requirements

- Node.js 18+
- `claude` CLI: `npm install -g @anthropic-ai/claude-code`
- Voice transcription (optional): `whisper-cpp` + `ffmpeg`
  - macOS: `brew install whisper-cpp ffmpeg && whisper-cpp-download-ggml-model small.en`

## Credits

Built by [@Gonzih](https://github.com/Gonzih)
