# cc-tg

Claude Code Telegram bot. Chat with Claude Code from Telegram.

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
| `CLAUDE_CODE_TOKEN` | yes* | Claude Code OAuth token |
| `ANTHROPIC_API_KEY` | yes* | Alternative to CLAUDE_CODE_TOKEN |
| `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
| `CWD` | no | Working directory for Claude Code. Defaults to current directory |

*One of CLAUDE_CODE_TOKEN or ANTHROPIC_API_KEY is required.

## How to get your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your ID.

## Bot commands

| Command | Action |
|---|---|
| `/start` | Reset session |
| `/reset` | Reset session |
| `/stop` | Interrupt current Claude task |
| `/status` | Check if session is active |
| Any text | Sent directly to Claude Code |

## How it works

Spawns a `claude` CLI subprocess per chat session using the same stream-JSON protocol as the [ce_ce](https://github.com/ityonemo/ce_ce) Elixir library. Each Telegram chat gets its own isolated Claude Code session. Messages stream back in real time, debounced into Telegram messages.

## Run persistently (systemd)

```ini
[Unit]
Description=cc-tg Claude Code Telegram bot

[Service]
Environment=TELEGRAM_BOT_TOKEN=xxx
Environment=CLAUDE_CODE_TOKEN=yyy
Environment=ALLOWED_USER_IDS=123456789
ExecStart=npx @gonzih/cc-tg
Restart=always

[Install]
WantedBy=multi-user.target
```

## Requirements

- Node.js 18+
- `claude` CLI installed and in PATH (`npm install -g @anthropic-ai/claude-code`)
