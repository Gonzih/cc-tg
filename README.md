# cc-tg

Claude Code Telegram bot. Chat with Claude Code from Telegram — voice messages, scheduled prompts, and automatic file delivery.

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
| `ANTHROPIC_API_KEY` | yes* | Alternative — API key from console.anthropic.com |
| `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
| `CWD` | no | Working directory for Claude Code. Defaults to current directory |

*One of `CLAUDE_CODE_TOKEN` or `ANTHROPIC_API_KEY` is required.

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
| `/cron every 1h <prompt>` | Schedule a recurring prompt |
| `/cron list` | Show active cron jobs |
| `/cron remove <id>` | Remove a specific cron job |
| `/cron clear` | Remove all cron jobs |
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
When Claude writes a file and mentions it in the response, the bot automatically uploads it to Telegram. Hybrid detection: tracks `Write`/`Edit` tool calls during the session, cross-references with filenames mentioned in the final response.

### Cron jobs
Schedule recurring prompts that fire into your Claude session on a timer:

```
/cron every 1h check whale-watcher logs and summarize any new large trades
/cron every 6h run the market scan and save results to daily-report.md
/cron every 30m ping the API and alert me if anything looks off
```

Cron jobs persist to `<CWD>/.cc-tg/crons.json` and are restored on bot restart. Output is prefixed with `CRON: <prompt>` so you know what triggered it. Files written by cron jobs are uploaded the same way as regular responses.

### Typing indicator
While Claude is working, the bot sends a continuous typing indicator so you know it's active.

### Permissions
Runs Claude Code with `--dangerously-skip-permissions` — no confirmation prompts blocking headless execution.

## How it works

Spawns a `claude` CLI subprocess per chat session using the stream-JSON protocol (same mechanism as the [ce_ce](https://github.com/ityonemo/ce_ce) Elixir library). Prompts pipe in via stdin, streaming JSON responses parse out. Only the final `result` message is forwarded to Telegram — no duplicate streaming chunks.

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
