# Kobashi

Route Claude Code and OpenAI Codex through your GitHub Copilot subscription.

Kobashi is a local bridge that lets [Claude Code](https://www.anthropic.com/claude-code) and [OpenAI Codex](https://openai.com/index/introducing-gpt-5-3-codex/) use your existing GitHub Copilot subscription instead of separate Anthropic or OpenAI API keys.

<p align="center">
  <img src="assets/light.png?v=3" width="380" alt="Kobashi — light mode">
  &nbsp;&nbsp;
  <img src="assets/dark.png?v=2" width="380" alt="Kobashi — dark mode">
</p>

## Download

| Platform | Download | Size |
|----------|----------|------|
| **macOS** (Apple Silicon + Intel) | **[Kobashi.zip](https://github.com/xjin6/kobashi/releases/latest/download/Kobashi.zip)** | ~35 MB |
| **Windows** | **[kobashi.exe](https://github.com/xjin6/kobashi/releases/latest/download/kobashi.exe)** | ~41 MB |

No installation required. No dependencies. Just download and double-click.

> **macOS first launch — "unidentified developer" warning**  
> Kobashi isn't signed with an Apple Developer ID ($99/yr — not worth it for a free tool), so macOS Gatekeeper blocks the first launch. Drag `Kobashi.app` to `/Applications`, then run this **once** in Terminal to remove the quarantine flag:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Kobashi.app
> ```
> After that, double-click opens it normally — no warning, no trip through System Settings. (Alternative: right-click the app → **Open** → **Open** in the dialog — works but the `xattr` command is faster and sticks.)
>
> **After connecting:** open a **new terminal window** before running `codex` or `claude` so the injected env vars are picked up.

## How It Works

1. **Double-click** the app — a small UI window opens in your browser
2. **Connect with GitHub** — authorize via GitHub device flow
3. **Toggle the bridges** — enable Claude Bridge and/or Codex Bridge
4. **Use them normally** — Kobashi auto-configures `~/.claude/settings.json` and `~/.codex/` to route API calls through the local proxy

The bridge intercepts API requests on localhost and forwards them to the GitHub Copilot API using your Copilot token. It manages token refresh, config injection, cleanup, and Anthropic↔OpenAI format translation automatically.

## Requirements

- **macOS** (Apple Silicon or Intel) or **Windows 10/11**
- **GitHub Copilot subscription** (Individual, Business, or Enterprise)
- **Chrome, Edge, Brave, or Arc** for the standalone app window (falls back to default browser)
- **Claude Code** or **OpenAI Codex** CLI / VS Code extension

## Features

- One-click GitHub OAuth device flow authentication
- Automatic Copilot token acquisition and refresh
- **Claude Bridge** — exposes an Anthropic-compatible API; remaps Claude Code's model IDs (e.g. `claude-opus-4-7`, `claude-sonnet-4-6[1m]`) to whatever Copilot actually supports; translates streaming + tool-use between Anthropic and OpenAI formats
- **Codex Bridge** — transparent passthrough proxy for OpenAI's Responses / Chat Completions
- Auto-injects configs (`~/.claude/settings.json`, `~/.codex/auth.json` + `config.toml`) and restores them on disconnect
- Auto-detects system HTTP(S) proxy — routes only Bridge's upstream traffic through it, leaving other apps untouched
- Light/dark mode with system preference detection
- Single portable executable, no installation needed

## License

MIT
