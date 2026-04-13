# Codex Copilot Bridge

Route OpenAI Codex through your GitHub Copilot subscription.

This tool acts as a local proxy that lets [OpenAI Codex](https://openai.com/index/introducing-gpt-5-3-codex/) (the CLI agent and VS Code extension) use your existing GitHub Copilot subscription instead of a separate OpenAI API key.

## Download

| Platform | Download | Size |
|----------|----------|------|
| **macOS** (Apple Silicon + Intel) | **[Codex Copilot Bridge.zip](https://github.com/xjin6/codex-copilot-bridge/releases/latest/download/Codex.Copilot.Bridge.zip)** | ~35 MB |
| **Windows** | **[Codex Copilot Bridge.exe](https://github.com/xjin6/codex-copilot-bridge/releases/latest/download/Codex.Copilot.Bridge.exe)** | ~36 MB |

No installation required. No dependencies. Just download and double-click.

> **macOS note:** First launch may be blocked by Gatekeeper — go to **System Settings → Privacy & Security → Open Anyway**.  
> After connecting, open a **new terminal window** before running `codex`.

## How It Works

1. **Double-click** the app — a small UI window opens in your browser
2. **Connect with GitHub** — authorize via GitHub device flow
3. **Use Codex normally** — the bridge automatically configures `~/.codex/` to route API calls through the local proxy

The bridge intercepts Codex API requests on `localhost:18921` and forwards them to the GitHub Copilot API using your Copilot token. It manages token refresh, config injection, and cleanup automatically.

## Requirements

- **macOS** (Apple Silicon or Intel) or **Windows 10/11**
- **GitHub Copilot subscription** (Individual, Business, or Enterprise)
- **Chrome, Edge, Brave, or Arc** for the standalone app window (falls back to default browser)
- **OpenAI Codex** CLI or VS Code extension installed

## Features

- One-click GitHub OAuth device flow authentication
- Automatic Copilot token acquisition and refresh
- Auto-injects Codex config (`~/.codex/auth.json` and `config.toml`)
- Backs up and restores your original Codex config on disconnect
- Light/dark mode with system preference detection
- Single portable executable, no installation needed

## Ports

| Port  | Purpose          |
|-------|------------------|
| 18921 | Copilot API proxy |
| 18922 | Bridge UI         |

## License

MIT
