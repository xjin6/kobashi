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
| **macOS** (Apple Silicon + Intel) | **[Kobashi.zip (v2.1.4)](https://github.com/xjin6/kobashi/releases/download/v2.1.4/Kobashi.zip)** | ~36 MB |
| **Windows** | **[kobashi.exe (v2.1.3)](https://github.com/xjin6/kobashi/releases/download/v2.1.3/kobashi.exe)** | ~55 MB |

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

1. **Double-click** the app — a native window opens on macOS; Windows uses a browser app window
2. **Connect with GitHub** — authorize via GitHub device flow
3. **Toggle the bridges** — enable Claude Bridge and/or Codex Bridge
4. **Use them normally** — Kobashi auto-configures `~/.claude/settings.json` and `~/.codex/` to route API calls through the local proxy

The bridge intercepts API requests on localhost and forwards them to the GitHub Copilot API using your Copilot token. It manages token refresh, config injection, cleanup, and Anthropic↔OpenAI format translation automatically.

### macOS window and background behavior

Closing the native app window with the red close button leaves Kobashi and its
enabled bridges running, with its icon in the Dock. Click the Dock icon to restore
the same window and UI state, including after minimizing or hiding the app.
Closing and reopening the window does not restart the bridges.

To stop Kobashi, use **Cmd-Q**, **Kobashi > Quit Kobashi**, or **Dock > Quit**.
Quitting stops the bridge process and runs its existing configuration cleanup.
This does not add login startup or prevent macOS from sleeping. The browser-based
Windows and CLI launch behavior is unchanged.

## Requirements

- **macOS** (Apple Silicon or Intel) or **Windows 10/11**
- **GitHub Copilot subscription** (Individual, Business, or Enterprise)
- **Chrome, Edge, Brave, or Arc** for browser-based launches on Windows or via the CLI (falls back to default browser); the macOS app uses a native WebKit window
- **Claude Code** or **OpenAI Codex** CLI / VS Code extension

## Features

- One-click GitHub OAuth device flow authentication
- Automatic Copilot token acquisition and refresh
- **Claude Bridge** — exposes an Anthropic-compatible API; remaps Claude Code's model IDs (e.g. `claude-opus-4-7`, `claude-sonnet-4-6[1m]`) to whatever Copilot actually supports; translates streaming + tool-use between Anthropic and OpenAI formats
- **Codex Bridge** — transparent passthrough proxy with an account-aware live OpenAI model picker, automatic five-minute refreshes, and safe 1M context defaults for models that support it
- Auto-injects configs (`~/.claude/settings.json`, `~/.codex/auth.json` + `config.toml`) and restores them on disconnect
- Auto-detects system HTTP(S) proxy — routes only Bridge's upstream traffic through it, leaving other apps untouched
- Light/dark mode with system preference detection
- Single portable executable, no installation needed

## Development checks

Run `npm test` for the Node.js regression tests. On macOS with Xcode Command Line
Tools and a graphical login session, run `npm run test:mac` for the native window
lifecycle checks. These compile the real app delegate with an isolated test entry
point and use a disposable child process instead of the bridge; they do not use
your credentials, modify your client configuration, or bind the bridge ports.
The runner selects the Xcode default Swift toolchain.

Native checks exercise close/reopen, repeated restoration, minimization, and the
termination callback. Actual Dock activation, Cmd-Q/Dock Quit delivery, and live
inference continuity still need a hands-on macOS smoke test. Never stop a running
Kobashi instance from an automated test.

For a safe hands-on check while your real bridge stays running, run
`npm run test:mac:smoke`. This opens **Kobashi Lifecycle Test (no bridge)** with a
different bundle identifier, a counter, and a disposable child's PID. Close its
window, wait, and click its Dock icon: the counter should advance and the PID
should stay the same. Repeat after minimizing and hiding. Quit **only the test
app** with Cmd-Q; rerun to check Dock > Quit. The terminal confirms its child has
stopped. This checks native event delivery, not real inference or client-config
cleanup. The temporary test bundle is removed when the test exits.

## License

MIT
