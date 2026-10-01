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
| **macOS** (Apple Silicon + Intel) | **[Kobashi.zip (v2.1.6)](https://github.com/xjin6/kobashi/releases/download/v2.1.6/Kobashi.zip)** | ~36 MB |
| **Windows** | **[Kobashi.exe (v2.1.6)](https://github.com/xjin6/kobashi/releases/download/v2.1.6/Kobashi.exe)** | ~55 MB |

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
- **Codex Bridge** — transparent passthrough proxy with an account-aware live OpenAI model picker, online capability checks on Codex startup, and safe 1M context defaults for models that support it
- Auto-injects configs (`~/.claude/settings.json`, `~/.codex/auth.json` + `config.toml`) and restores them on disconnect
- Auto-detects system HTTP(S) proxy — routes only Bridge's upstream traffic through it, leaving other apps untouched
- Light/dark mode with system preference detection
- Single portable executable, no installation needed

### Codex model compatibility

Kobashi refreshes the account's Copilot model directory and performs one online
validation round when a Codex client starts. Fully quit Codex and reopen it to
force a fresh directory read and validation, even when the previous capability
cache is unchanged. Closing a window alone may leave the client process running.
Repeated picker reads and normal conversation turns reuse that startup snapshot;
there is no timed remote discovery, inference recheck, or background retry loop.

macOS and Windows use the same discovery, validation, caching, and request-adaptation
code. A read-only local process watcher checks client process IDs and creation
times every five seconds (`ps` on macOS, hidden PowerShell/CIM on Windows); these
checks do not contact a model or consume tokens. GUI helpers and child servers are
counted with their parent, and diagnostic queries such as `codex debug models`
never count as a startup. The first bridge request can bootstrap discovery before
the watcher sees the client, without causing a second validation round.

On first setup (or an account switch with no verified cache), Kobashi prepares the
verified directory before injecting the Codex configuration. Open Codex after
this preparation completes. On subsequent launches, the previous verified
snapshot remains available while the new startup check runs; a network timeout
does not revoke an earlier successful check.

The native Codex app server reads `model_catalog_json` at process startup. It does
not reload its picker when that file or `config.toml` is rewritten. Therefore,
new models, removed models, and new effort options found by a startup round are
saved for the **next full Codex launch**; `/v1/models` reflects them as checks
finish. If Codex was already open during first setup, fully quit and reopen it
after preparation. Kobashi never restarts the client or interrupts a live turn.

New models are checked with a small, real streaming tool-call request
before being published to the directory or `/v1/models`. HTTP 200 alone is
insufficient: the check must finish successfully with a valid tool call. There is
no model-name allowlist, compatibility exception list, or silent model substitution.

The same refresh reads the installed Codex client's native catalog. Ultra is a
client delegation mode: its exact native model metadata and underlying API effort
must both be supported. A newly added native model or Ultra mode is discovered and
verified automatically. A Copilot model absent from the native catalog can still
appear with its advertised API efforts; Kobashi cannot invent a client mode that
the installed Codex does not declare.

Parameter compatibility is learned from explicit upstream validation responses.
Supported alternatives for reasoning context, effort, summary, and text verbosity
are applied without changing the selected model, conversation, or tools. Multiple
optional-field changes can be negotiated with at most three compatibility retries,
separate from the existing single authentication retry. Ambiguous errors and
changes to user data, tools, model IDs, or token budgets are never guessed.

Verified capabilities and learned parameter rules are cached privately in
`~/.kobashi/codex-model-capabilities.json`, scoped to the account and a fingerprint
of upstream and native capabilities. A client restart explicitly revalidates all
discovered models and can remove old learned limitations when a provider adds
support. The running session keeps its verified list without a time-based expiry.
Real model-access failures still remove a model from the published directory and
`/v1/models` immediately (the already-open native picker updates on its next launch).
Real request validation errors still teach compatible parameters.

Each startup round uses at most two concurrent checks, a 45-second timeout per
request, and a 1,024-token output limit. These are real API requests and consume
some usage, including bounded parameter-negotiation retries. A transient failure
does not schedule further checks in the background; restart Codex to retry.
Exiting the clients stops queued validation work. Account changes and newer
startups invalidate late results from older rounds.

## Development checks

Run `npm test` for the Node.js regression tests. To check native picker startup
and caching against an installed CLI without inference, set `KOBASHI_TEST_CODEX`
to its absolute executable path and run `node --test test/codex-native-picker.test.js`.
This uses a temporary Codex home and a loopback-only provider; it never touches
the running client. On macOS with Xcode Command Line
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
