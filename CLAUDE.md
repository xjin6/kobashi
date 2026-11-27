# Kobashi

Local bridge that proxies inference for Codex and Claude Desktop.

## Feature update ledger

Read [FEATURE_UPDATES.md](FEATURE_UPDATES.md) before implementing changes. Every
feature, user-visible fix, compatibility change, UI/layout adjustment, and
packaging/lifecycle update must update that file in the same change. Keep its
current capability baseline and dated history accurate, with source pointers,
actual validation, limits, and TokenX catch-up notes. Distinguish implemented,
built, and released changes. See [AGENTS.md](AGENTS.md) for the shared convention.

## NEVER kill the running Kobashi process

**Kobashi is the user's live connection to the AI they are talking to right now — including this session.** Killing it cuts the conversation mid-flight. There is no "quick restart"; the user is left with a dead client and no way to tell you so.

Do not run any of these, in any form:

- `pkill -f kobashi` / `pkill -f Kobashi.app` / `pkill -f kobashi-arm64`
- `killall Kobashi`
- `kill <pid>` against a kobashi or Kobashi.app process
- `launchctl kickstart -k` on anything kobashi-related

This holds even when it seems obviously necessary — installing a new build, freeing port 18921/18923, "just for a second". It is never worth it. **Ask the user to restart it themselves**, then wait.

The same applies to Claude Desktop (`/Applications/Claude.app`) when it is the surface the user is talking through.

### If a task seems to require a restart

Do the part that doesn't, then stop and hand off:

> The new build is at `dist/Kobashi.zip`. To install it: quit Kobashi from its menu, extract the ZIP with macOS Archive Utility outside the synced checkout, replace `/Applications/Kobashi.app`, and relaunch.

Editing files, building, and verifying logic against a copy are all fine — none of that needs the process down.

## Ports

- `18921` — Codex bridge (`~/.codex/config.toml` → `model_providers.kobashi`)
- `18923` — Claude gateway (`~/.claude/settings.json`, Claude Desktop managed-config)

Both are written by kobashi at startup and restored on exit. A port showing as busy is normal operation, not a stale process to clean up.

## Config injection

`writeCodexConfig()` / `writeClaudeConfig()` inject; `restoreCodexConfig()` / `restoreClaudeConfig()` undo.

`stripInjectedCodexConfig()` exists because the old restore path deleted the user's entire `config.toml` when no `.bak` was present, taking their notify/marketplaces/plugins/mcp_servers config with it. Keep restore surgical — remove only the injected `model_provider` line and `[model_providers.*]` section, never the file.

## Session state

`~/.kobashi/session.json` (holds `github_token` — chmod 600).

Migrated from the legacy `~/.codex/ccb-session.json`, which was wrong twice over: kobashi's own state living in Codex's config dir, under a `ccb-` prefix left from when this was called "Copilot Bridge". `migrateLegacySession()` handles the move; don't reintroduce writes under `~/.codex/`.

## Build

```bash
npm run build:mac     # pkg + swiftc + codesign + ditto → dist/Kobashi.zip
npm run build:win     # Git Bash on Windows → dist/Kobashi.exe
```

Version comes from `package.json` only. Both scripts delegate to `scripts/build-local.js`, which stages the build sources and dependencies in a unique local temporary directory outside OneDrive. Version/date stamping via `/* BUILD_STAMP */` touches only that copy. The source checkout is never stamped. The temporary workspace is removed on success or failure.

Only the finished `Kobashi.zip` / `Kobashi.exe` and `SHA256SUMS.txt` go back into `dist`. Keep all compiler output, `.app` bundles, temporary files, and intermediate binaries outside the synced checkout. `KOBASHI_BUILD_TMPDIR` can select another local scratch directory; it must not be inside OneDrive or the checkout. Do not bypass the staging wrapper. macOS packaging uses the built-in `ditto`; no RAR utility is needed. Validate the extracted ZIP's three executable modes (755), architectures and complete bundle signature before publishing it. RAR extraction through The Unarchiver has been observed stripping execution permissions even when the archive stored them correctly.

Extract installation archives outside the repository: `open -a Kobashi` matches by bundle id and can launch an unpacked build copy instead of the installed app.
