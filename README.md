# Kobashi

Route Claude Code and OpenAI Codex through your GitHub Copilot subscription.

Kobashi **2.3.0** is available for macOS and Windows.
Local macOS builds now produce `dist/Kobashi.zip`, with execution permissions
and the assembled bundle signature checked again after extraction.
Windows builds verify the packaged native-account runtime and asset hashes,
and record their source snapshot in `output/last-windows-build.json`.

Kobashi is a local bridge that lets [Claude Code](https://www.anthropic.com/claude-code) and [OpenAI Codex](https://openai.com/index/introducing-gpt-5-3-codex/) use your existing GitHub Copilot subscription instead of separate Anthropic or OpenAI API keys.

<p align="center">
  <img src="assets/light.png?v=3" width="380" alt="Kobashi — light mode">
  &nbsp;&nbsp;
  <img src="assets/dark.png?v=2" width="380" alt="Kobashi — dark mode">
</p>

## Download

| Platform | Download | Size |
|----------|----------|------|
| **macOS** (Apple Silicon + Intel) | **[Kobashi.zip (v2.3.0)](https://github.com/xjin6/kobashi/releases/download/v2.3.0/Kobashi.zip)** | ~36 MB |
| **Windows x64** | **[Kobashi.exe (v2.3.0)](https://github.com/xjin6/kobashi/releases/download/v2.3.0/Kobashi.exe)** | ~56 MB |

On macOS, extract `Kobashi.zip` with macOS Archive Utility, then move
`Kobashi.app` to Applications. The troubleshooting note below applies to older
RAR releases. On Windows,
download and run `Kobashi.exe` directly. Kobashi itself needs no additional runtime
installation.

> **macOS first launch — developer verification**
> Local builds have an ad-hoc integrity signature, not an Apple Developer ID or
> notarization. If macOS asks you to approve the developer, review the source of
> the download and use **System Settings → Privacy & Security → Open Anyway**
> for this app. This is separate from missing executable permissions. The build
> and repair scripts do not remove quarantine or disable Gatekeeper.
>
> **After connecting:** open a **new terminal window** before running `codex` or `claude` so the injected env vars are picked up.

### “The application Kobashi can't be opened” after RAR extraction

On one affected Mac, The Unarchiver extracted the wrapper and both embedded
runtimes as `644` (not executable), although the RAR stored them as `755`.
The same machine could run the earlier ZIP release. This failure occurs before
Kobashi's bridge code starts. Use the current ZIP with macOS Archive Utility.
For an existing trusted extraction, restore execution permission on only these
three files, substituting the app's actual path:

```sh
chmod 755 /Applications/Kobashi.app/Contents/MacOS/kobashi \
  /Applications/Kobashi.app/Contents/Resources/bin/kobashi-arm64 \
  /Applications/Kobashi.app/Contents/Resources/bin/kobashi-x64
```

This fixes execution permissions, not developer approval. It does not modify
program contents, credentials, history, or system security settings.

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

### Native ChatGPT login and Remote

Kobashi preserves native ChatGPT account/workspace authentication by default,
including on a new computer. Model requests continue through the local Kobashi
endpoint to Copilot. Enable the bridge and click the existing Codex icon; no
per-computer preference file or additional launcher is needed. If that computer
has never signed in to ChatGPT, sign in through the official desktop once using
its user's own account.

The `kobashi` provider uses `requires_openai_auth = true` and no provider
`env_key`. On upgrade, an exact legacy `PROXY_MANAGED` placeholder in `auth.json`
is replaced with its native ChatGPT backup when available, or removed so the
official login can proceed. The backup remains available for recovery. Existing
native credentials, unrelated authentication files, and OS keychain settings
are preserved. A missing live auth file is never repopulated from an old backup.
Kobashi does not sign in for the user, grant Remote entitlement, or purchase a subscription.
The gateway builds its own Copilot request headers; it does not forward incoming
ChatGPT credentials to Copilot.

Exiting Kobashi or disabling its Codex bridge restores the **previous provider
configuration**, preserving other settings edited while the bridge was running.
It leaves the ChatGPT login and conversation history intact. The next startup
uses native account mode again. Existing open chats
may require a desktop restart to adopt the restored provider. The previous
provider's access and billing rules apply after restoration.

The official ChatGPT desktop owns Remote and its backend. Keep that app running
for phone access; the earlier independent shared-daemon/Python-adapter setup is
unnecessary in this mode. For an intentional legacy API-key setup, the optional
`~/.kobashi/codex-native-auth.json` can contain `{"enabled": false}`. An explicit
opt-out is preserved across upgrades; removing that file restores the default.
Change modes while client tasks are idle and the client is closed.

The `Kobashi` label in ChatGPT's account menu is the provider display name from
configuration. ChatGPT renders it using its own default menu layout. Kobashi
does not inject or modify that menu.

### Open Codex from the existing icon (macOS and Windows)

With Kobashi connected and its Codex bridge enabled, click the existing Codex
icon to open the official ChatGPT/Codex desktop. The icon occupies the same
32 × 32 tile; no row or menu is added. The bridge switch remains independent.

On macOS, each click reads the current manual HTTP/HTTPS/SOCKS proxy settings and
passes matching upper- and lowercase environment variables through
`open --env` to that application only. Native launches also clear inherited
`OPENAI_API_KEY` and `OPENAI_BASE_URL` for that application so legacy bridge
values do not affect the new launch. Loopback requests stay direct. It does
not set global proxy variables, install a CLI shim, change the official app
bundle, start a shared daemon, or switch the inference provider.

If the desktop is already running, the click brings it forward. Its existing
environment cannot be changed in place; quit it yourself and click the icon
again when new proxy settings need to take effect. You can close the desktop
normally and reopen it through this same icon later. Consecutive clicks share
one pending launch, and the action never closes or restarts a running app.

On Windows, the icon opens the registered Microsoft Store Codex desktop or an
installed Codex desktop executable. Store launches use the Windows application
identity and its normal environment, just like the Start menu. Standalone
installations receive Kobashi's configured Codex home for that launch. Existing
windows are activated, including minimized windows; the CLI on PATH is never
used as a desktop launcher. Windows helpers run without a console window.

An absent desktop, malformed/PAC-only macOS proxy configuration, or old
shared backend produces a short tooltip on the icon instead of a new panel.
The local API accepts only a same-origin, loopback `POST /api/codex/open` with
an empty JSON object; no executable path or command comes from the request.

## Features

- One-click GitHub OAuth device flow authentication
- Automatic Copilot token acquisition and refresh
- **Claude Bridge** — exposes an Anthropic-compatible API; remaps Claude Code's model IDs (e.g. `claude-opus-4-7`, `claude-sonnet-4-6[1m]`) to whatever Copilot actually supports; translates streaming + tool-use between Anthropic and OpenAI formats
- **Claude Code WebSearch** uses Copilot's hosted web search and returns its source links to the native tool. If the selected model needs a search helper, Kobashi sends just the search query and its constraints to an eligible Responses model on the same account. The main conversation continues on the selected model. These searches use your Copilot subscription.
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

## Building

Run `npm run build:mac` on macOS or `npm run build:win` in Git Bash on Windows.
Both commands copy the build sources and installed dependencies into a unique
local temporary directory outside the checkout and OneDrive. Version stamping,
compilation, icon generation, and packaging happen only in that copy. The copy
is removed after success or failure; source files in the checkout are not stamped.

After a successful build, only `dist/Kobashi.zip` (macOS) or `dist/Kobashi.exe`
(Windows) and `dist/SHA256SUMS.txt` are published back to the checkout. The existing
package for the other platform is preserved. Failed builds leave the previous
release files in place. No unpacked `.app`, intermediate binaries, or dated build
directories are copied into `dist`.

The build uses the OS temporary directory by default. To use a different local
disk, set `KOBASHI_BUILD_TMPDIR` to a directory outside OneDrive and the checkout.
Cloud-backed temporary paths, including symlinks into OneDrive, are rejected.
Local npm/pkg download caches are reused; cloud-backed cache overrides are
redirected into the temporary workspace. The final package path is printed when
the build completes. macOS packaging uses built-in `ditto` to create a ZIP and
extracts it into a disposable directory before publication. That check verifies
the wrapper and both runtimes retain 755 permissions, the wrapper includes both
CPU architectures, and the completed bundle's ad-hoc signature remains valid.
No RAR utility is required. Open the ZIP with macOS Archive Utility.

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
