# Kobashi

Route Claude Code and OpenAI Codex through your GitHub Copilot subscription.

Kobashi is a local bridge that lets [Claude Code](https://www.anthropic.com/claude-code) and [OpenAI Codex](https://openai.com/index/introducing-gpt-5-3-codex/) use your existing GitHub Copilot subscription instead of separate Anthropic or OpenAI API keys.

## Running the app

Use the [native build commands](#building) to generate `dist/Kobashi.exe` on
Windows or `dist/Kobashi.app` on macOS. Run the Windows executable directly.
On macOS, copy `Kobashi.app` to Applications and launch it there, not from the
synced checkout.
Kobashi itself needs no additional runtime installation.

> **macOS first launch — "unidentified developer" warning**  
> Kobashi isn't signed with an Apple Developer ID ($99/yr — not worth it for a free tool), so macOS Gatekeeper blocks the first launch. Drag `Kobashi.app` to `/Applications`, then run this **once** in Terminal to remove the quarantine flag:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Kobashi.app
> ```
> After that, double-click opens it normally — no warning, no trip through System Settings. (Alternative: right-click the app → **Open** → **Open** in the dialog — works but the `xattr` command is faster and sticks.)
>
> **After connecting:** open a **new terminal window** before running `codex` or `claude` so the injected env vars are picked up.

## How It Works

1. **Double-click** the app — a native Win32 window opens on Windows, or a Cocoa window on macOS
2. **Click Not Connected** — authorize via GitHub device flow; the status turns
   green and reads **Connected**. Click it to disconnect.
3. **Toggle the bridges** — enable Claude Bridge and/or Codex Bridge
4. **Use them normally** — Kobashi auto-configures `~/.claude/settings.json` and `~/.codex/` to route API calls through the local proxy

The Go bridge intercepts API requests on localhost and forwards them to the GitHub Copilot API using your Copilot token. It manages token refresh, config injection, cleanup, and Anthropic↔OpenAI format translation automatically. The application uses only native code and operating-system libraries. GitHub device authorization opens your default browser; token sign-in stays in the native window.

### Startup and window behavior

Open **Settings** from the main window to change these options, both enabled by
default:

- **Start at login** starts Kobashi when you sign in to your computer. Windows
  registers the current executable in your account's startup entries; macOS
  registers the app bundle as a user LaunchAgent. Keep the executable or app at
  its installed location.
- **Close to system tray** keeps Kobashi and its enabled bridges running when
  you close the window. Use **Show Kobashi** from the Windows system tray or macOS
  menu bar to reopen it. Turning this option off makes closing the window quit
  Kobashi and restore client configurations.

Login startup runs in the tray when close to tray is enabled; otherwise it opens
the window. Settings are saved in `~/.kobashi/settings.json` independently of your
GitHub connection and are preserved when you disconnect. The main window has a fixed
400 × 480 logical content area that scales with display DPI, a plain background,
and no decorative footer animation.

To stop Kobashi while close to tray is enabled, select **Quit Kobashi** in Settings
window or **Quit Kobashi** in the tray/menu-bar menu. macOS also supports **Cmd-Q**,
**Kobashi > Quit Kobashi**, and **Dock > Quit**. Quitting stops the bridge process
and runs configuration cleanup; closing to tray does not restart the bridges.
These desktop settings are available in both native applications.
`--no-open` remains a headless launch and does not create a Windows
tray icon or register startup.

## Requirements

- **macOS 13+** (Apple Silicon or Intel) or **Windows 10/11** (x64)
- **GitHub Copilot subscription** (Individual, Business, or Enterprise)
- **Claude Code** or **OpenAI Codex** CLI / VS Code extension

## Features

- One-click GitHub OAuth device flow authentication
- Automatic Copilot token acquisition and refresh
- **Claude Bridge** — exposes an Anthropic-compatible API; remaps Claude Code's model IDs (e.g. `claude-opus-4-7`, `claude-sonnet-4-6[1m]`) to whatever Copilot actually supports; translates streaming + tool-use between Anthropic and OpenAI formats
- **Codex Bridge** — transparent passthrough proxy with an account-aware live OpenAI model picker, online capability checks on Codex startup, and safe 1M context defaults for models that support it
- Auto-injects configs (`~/.claude/settings.json`, `~/.codex/config.toml`) and restores them on disconnect without replacing Codex account login
- Auto-detects system HTTP(S) proxy — routes only Bridge's upstream traffic through it, leaving other apps untouched
- Light/dark mode with system preference detection
- Configurable login startup and close to system tray, both enabled by default
- Compact fixed-size window with a plain background
- Native Win32 and Cocoa clients with no third-party runtime

### Codex login and plugin store

Sign in to Codex with ChatGPT to use its plugin store. This account is separate
from Kobashi's GitHub connection. Kobashi preserves `~/.codex/auth.json` and uses
a non-secret provider-level bearer for inference, so ChatGPT credentials are not
sent to Kobashi or GitHub Copilot. It does not set global OpenAI API credentials.
The provider keeps `requires_openai_auth = true` so Codex can display the saved
ChatGPT account; the explicit provider bearer still controls inference requests.

Kobashi recovers a managed placeholder login from its saved `auth.json.bak`
without replacing a newer login. If no usable backup exists, the app asks you to
sign in to Codex again. User API keys, `CODEX_API_KEY`, and organization login
policies are preserved; the plugin store requires Codex's active account to be
ChatGPT rather than API key auth. An expired or revoked login may also require
sign-in. Fully quit and reopen Codex yourself to load changed configuration.

### Codex model compatibility

Kobashi refreshes the account's Copilot model directory and performs one online
validation round when a Codex client starts. Fully quit Codex and reopen it to
force a fresh directory read and validation, even when the previous capability
cache is unchanged. Closing a window alone may leave the client process running.
Repeated picker reads and normal conversation turns reuse that startup snapshot;
there is no timed remote discovery, inference recheck, or background retry loop.

macOS and Windows use the same discovery, validation, caching, and request-adaptation
code. A read-only local process watcher checks client process IDs and creation
times every five seconds (`ps` on macOS, Win32 process APIs on Windows); these
checks do not contact a model or consume tokens. GUI helpers and child servers are
counted with their parent, and diagnostic queries such as `codex debug models`
never count as a startup. The first bridge request can bootstrap discovery before
the watcher sees the client, without causing a second validation round.

On first setup (or an account switch with no verified cache), Kobashi prepares the
verified directory before injecting the Codex configuration. Open Codex after
this preparation completes. On subsequent launches, the previous verified
snapshot remains available while the new startup check runs; a network timeout
does not revoke an earlier successful ordinary-inference check.

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
must both be supported. Models declaring Ultra or Multi-Agent V2 also require a
real agent-message roundtrip: the API must generate a message and return its
complete original payload when replayed. Until that check succeeds, Kobashi
publishes V1 delegation without Ultra and retains the model's normal API efforts.
A newly added native model or Ultra mode is discovered and verified automatically.
A Copilot model absent from the native catalog can still
appear with its advertised API efforts; Kobashi cannot invent a client mode that
the installed Codex does not declare.

Parameter compatibility is learned from explicit upstream validation responses.
Supported alternatives for reasoning context, effort, summary, and text verbosity
are applied without changing the selected model, conversation, or tools.
If the upstream API explicitly rejects `service_tier`, Kobashi omits that field
and caches the rejection for that model and account; it never substitutes another
service tier. HTTP validation errors can be retried before returning the response.
Streaming failures remain visible and update the rules for subsequent requests,
without replaying an already-started response. Multiple optional-field changes
can be negotiated with at most three compatibility retries,
separate from the existing single authentication retry. Ambiguous errors and
changes to user data, tools, model IDs, or token budgets are never guessed.

Streaming failures preserve the upstream error code and message, including when
Copilot sends those details after an empty `response.failed` event. Failures are
logged in `~/.kobashi/kobashi.log`. Encrypted agent content is forwarded unchanged.
If Copilot cannot decrypt it, Kobashi reports the actual failure rather than
discarding the message or presenting ciphertext as readable conversation text.
An agent decryption failure also invalidates that model's cached Ultra/V2
capability without removing ordinary inference. Explicit Codex feature overrides
can still force V2; Kobashi does not change those overrides.
Use a new V1 conversation without Ultra when this happens. Changing modes does
not remove encrypted messages from an existing conversation's history.

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

Install Go 1.27 or later to build from source. Windows builds need only Go;
macOS builds also need Xcode Command Line Tools.
No third-party Go modules are required.

On Windows, run from PowerShell:

```powershell
go run .\cmd\build -target windows
```

On macOS:

```bash
go run ./cmd/build -target darwin
```

Both commands copy the build sources into a unique local temporary directory
outside the checkout and OneDrive. Compilation, icon generation, and packaging
happen only in that copy, which is removed after success or failure.
The app version comes only from `package.json`, which contains product metadata,
and is embedded in the binaries
and platform metadata without modifying source files. macOS packaging builds
both Apple Silicon and Intel bridge binaries and a universal Cocoa executable.

After a successful build, only `dist/Kobashi.app` (macOS) or `dist/Kobashi.exe`
(Windows) and `dist/SHA256SUMS.txt` are published back to the checkout. The existing
release for the other platform is preserved. `SHA256SUMS.txt` lists the Windows
executable and each file inside the macOS app bundle. The complete bundle is
copied and verified before replacing an existing app; replacement failure
triggers rollback to the previous bundle. No intermediate binaries or dated build
directories are left in `dist`.
If an existing executable is in use, leave it running and use `-output <directory>`
to save the finished package elsewhere. The build never stops a running app.

The build uses the OS temporary directory by default. To use a different local
disk, set `KOBASHI_BUILD_TMPDIR` to a directory outside OneDrive and the checkout.
Cloud-backed temporary paths, including symlinks into OneDrive, are rejected.
Go compiler caches and intermediate files stay in the temporary workspace.
The final app path is printed when the build completes. macOS builds produce
the app bundle directly and require no archive tool or extractor.

## Development checks

Run `go test ./...` for native bridge, compatibility, configuration, transport,
and packaging checks. On Windows with a graphical login session, this also
exercises native controls, fixed DPI-scaled sizing, persisted settings, and
close-to-tray/quit behavior using an isolated home and different loopback ports.
Run `go run ./cmd/kobashi --no-open` for headless development. `--home <directory>` and
`--port-offset <offset>` isolate client configuration and ports;
`--no-startup-registration` leaves OS startup registration unchanged.

Windows native stream/catalog checks use `KOBASHI_TEST_CODEX_EXE` and
`go test .\internal\bridge -run '^TestInstalledCodex(StreamingFailureDetails|CopilotDelegation)$'`.
Live delegation checks also require `KOBASHI_TEST_COPILOT_SESSION` (the existing
session file) and `KOBASHI_TEST_COPILOT_MODEL`. They consume Copilot usage and use
a temporary home; the Codex installation must include `codex-code-mode-host.exe`.

The bridge checks include the compatibility fixtures in
`internal/bridge/testdata/parity.json`. On macOS with Xcode Command Line
Tools and a graphical login session, run `go run ./cmd/build -test-mac` for the native window
lifecycle checks. These compile the real app delegate with an isolated test entry
point and use a disposable child process instead of the bridge; they do not use
your credentials, modify your client configuration, or bind the bridge ports.
The runner selects the Xcode default Swift toolchain.

Native checks first send mouse events through an isolated app event loop to
verify that both bridge cards toggle off and back on when clicked on the switch
or card body. Toggle requests use a fake service without changing client settings.
The lifecycle checks exercise the fixed window size, close-to-tray setting, menu-bar
restore entry, repeated restoration, minimization, and the termination callback.
Actual menu-bar/Dock activation, Cmd-Q/Dock Quit delivery, and live
inference continuity still need a hands-on macOS smoke test. Never stop a running
Kobashi instance from an automated test.

For a safe hands-on check while your real bridge stays running, run
`go run ./cmd/build -test-mac -smoke`. This opens **Kobashi Lifecycle Test (no bridge)** with a
different bundle identifier, a counter, and a disposable child's PID. Close its
window, wait, and select **Show Kobashi** from its menu-bar icon: the counter
should advance and the PID should stay the same. Repeat after minimizing and
hiding. Quit **only the test
app** with Cmd-Q; rerun to check Dock > Quit. The terminal confirms its child has
stopped. This checks native event delivery, not real inference or client-config
cleanup. The temporary test bundle is removed when the test exits.

## License

MIT
