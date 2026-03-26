# cc-tg

[![npm version](https://img.shields.io/npm/v/@gonzih/cc-tg)](https://www.npmjs.com/package/@gonzih/cc-tg)

Claude Code Telegram bot. Chat with Claude Code from Telegram — text, voice, images, files, scheduled prompts, and bot management commands.

Built by [@Gonzih](https://github.com/Gonzih).

## Quickstart

**Step 1** — create a Telegram bot via [@BotFather](https://t.me/BotFather), get your token.

**Step 2** — run:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token CLAUDE_CODE_TOKEN=your_claude_token npx @gonzih/cc-tg
```

Open your bot in Telegram and start chatting.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `CLAUDE_CODE_TOKEN` | yes* | Claude Code OAuth token (starts with `sk-ant-oat`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes* | Alias for `CLAUDE_CODE_TOKEN` |
| `CLAUDE_CODE_OAUTH_TOKENS` | no | Comma-separated OAuth tokens for rotation — e.g. `token1,token2,token3`. When one account hits its usage limit, automatically switches to the next token instead of sleeping. |
| `ANTHROPIC_API_KEY` | yes* | Alternative — API key from console.anthropic.com |
| `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
| `CWD` | no | Working directory for Claude Code. Defaults to current directory |
| `THREAD_CWD_MAP` | no | JSON mapping of forum topic names or IDs to CWD paths (see [Multi-topic sessions](#multi-topic-sessions)) |

*One of `CLAUDE_CODE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` required.

## Get your Claude Code token

```bash
npx @anthropic-ai/claude-code setup-token
```

Opens a browser, logs in with your Anthropic account, prints a token starting with `sk-ant-oat`.

## Get your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID.

## Bot commands

| Command | Action |
|---------|--------|
| `/start` or `/reset` | Kill current Claude session and start fresh |
| `/stop` | Interrupt the running Claude task |
| `/status` | Check if a session is active |
| `/cost` | Show session token usage and cost |
| `/help` | Show all available commands |
| `/cron every 1h <prompt>` | Schedule a recurring prompt |
| `/cron list` | Show active cron jobs (numbered) |
| `/cron edit <#> [schedule/prompt] <value>` | Edit a cron job in place |
| `/cron remove <id>` | Remove a specific cron job |
| `/cron clear` | Remove all cron jobs |
| `/reload_mcp` | Restart the cc-agent MCP server process |
| `/mcp_status` | Check MCP server connection status |
| `/mcp_version` | Show latest published cc-agent npm version and current cache |
| `/clear_npx_cache` | Clear npx cache and reload cc-agent (upgrades to latest version) |
| `/get_file <path>` | Send a file from the server to this chat |
| `/restart` | Self-restart the cc-tg bot process (no SSH needed) |
| Any text | Sent directly to Claude Code |
| Voice message | Transcribed via whisper.cpp and sent to Claude |
| Photo | Sent as native image input to Claude |
| Document / file | Downloaded to `<CWD>/.cc-tg/uploads/`, path passed to Claude |

## Features

### Persistent sessions
Each Telegram chat ID gets its own isolated Claude Code subprocess. Sessions survive between messages — Claude remembers context. `/reset` starts fresh.

### Voice messages
Send a voice message → transcribed via whisper.cpp → fed to Claude as text. Requires `whisper-cpp` and `ffmpeg` on the host.

### Images
Send a photo → base64-encoded → sent to Claude as a native image content block. Claude sees the full image. Caption included as text.

### Documents
Send any file → downloaded to `<CWD>/.cc-tg/uploads/<filename>` → Claude receives the path as `ATTACHMENTS: [filename](path)` and can read/process it directly. Works for PDFs, CSVs, code files, etc.

### File delivery
When Claude writes a file and mentions it in the response, the bot automatically uploads it to Telegram. Tracks `Write`/`Edit` tool calls during the session, cross-references with filenames in the final response.

### Cost tracking
`/cost` shows total input/output tokens and estimated USD cost for the current session.

### Cron jobs
Schedule recurring prompts on a timer:

```
/cron every 1h check logs and summarize new alerts
/cron every 6h run market scan and save to daily-report.md
/cron every 30m ping the API and alert if anything looks off
```

Edit without removing and re-adding:
```
/cron edit 1 every 2h updated task description
/cron edit 1 schedule every 4h
/cron edit 1 prompt new task text only
```

Cron jobs persist to `<CWD>/.cc-tg/crons.json` and restore on restart. Output is prefixed with `CRON: <prompt>`. Files written by cron jobs are uploaded automatically.

### MCP management commands
Manage the cc-agent MCP server from Telegram without SSH:

- `/reload_mcp` — sends SIGTERM to the cc-agent process; Claude Code auto-restarts it on next tool call. Useful after updating cc-agent config.
- `/mcp_status` — runs `claude mcp list` and shows the current connection status of all MCP servers.
- `/mcp_version` — shows the latest `@gonzih/cc-agent` version on npm and what's in your local npx cache.
- `/clear_npx_cache` — deletes `~/.npm/_npx/` and kills cc-agent, forcing a fresh download of the latest version on next use.

### Self-restart
`/restart` — spawns a detached child process with the same Node binary and args, sends you a confirmation message, then exits. The new process inherits all environment variables. No SSH required to restart the bot after updates.

### Multi-topic sessions

When you use cc-tg in a **Telegram group with Topics enabled** (a "Forum" group), each topic gets its own **isolated Claude Code session**. One bot token, one daemon, unlimited isolated project contexts.

**How it works:**
- Session key = `chatId:threadId` for forum topics
- Session key = `chatId:main` for direct messages and non-topic groups (backward compatible)
- Commands like `/reset`, `/stop`, `/status` are scoped to the current topic

**Setup:**
1. Create a Telegram group → Settings → Topics → Enable
2. Create topics for each project (e.g. "Simorgh", "LeWM", "EcoClaw")
3. Each topic now has its own isolated Claude context

**Optional: route topics to different working directories**

Set `THREAD_CWD_MAP` to a JSON string mapping topic names (or thread IDs) to absolute paths:

```bash
THREAD_CWD_MAP='{"Simorgh":"/Users/you/simorgh-app","LeWM":"/Users/you/le-wm","EcoClaw":"/Users/you/ecoclaw"}'
```

When cc-tg creates a new session for a topic, it looks up the topic name in this map and starts Claude in the corresponding directory. If no match is found, falls back to `CWD`.

You can also map by numeric thread ID:
```bash
THREAD_CWD_MAP='{"12345":"/Users/you/project-a","67890":"/Users/you/project-b"}'
```

If `THREAD_CWD_MAP` is not set, all topics share the same CWD — context isolation still works, just without directory routing.

### Typing indicator
While Claude is working, the bot sends a continuous typing indicator. Works for both regular messages and cron job execution.

### Bot command menu
All commands are registered with Telegram's `/` menu via `setMyCommands` on startup — no need to remember commands.

## Architecture

cc-tg is a thin Telegram adapter over Claude Code:

1. **Bot layer** (`src/bot.ts`) — handles Telegram updates, routes commands, manages per-chat Claude subprocesses.
2. **Claude runner** (`src/claude.ts`) — spawns `claude` CLI as a subprocess per chat, streams output back, tracks token costs.
3. **Cron manager** (`src/cron.ts`) — persistent cron scheduler that fires prompts at configured intervals and delivers results to Telegram.
4. **Voice handler** (`src/voice.ts`) — downloads Telegram voice messages, converts via ffmpeg, transcribes with whisper.cpp.

cc-tg works with the [cc-agent](https://github.com/Gonzih/cc-agent) MCP server to enable Claude Code subagent spawning. When cc-agent is configured as an MCP server in your Claude Code setup, `/reload_mcp` and `/mcp_status` let you manage it remotely without SSH.

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
        <!-- Optional: comma-separated OAuth tokens for automatic rotation on usage limit -->
        <!-- <key>CLAUDE_CODE_OAUTH_TOKENS</key> -->
        <!-- <string>token1,token2,token3</string> -->
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

## Related

- [cc-agent](https://github.com/Gonzih/cc-agent) — MCP server for spawning Claude Code subagents by [@Gonzih](https://github.com/Gonzih)
