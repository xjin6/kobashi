# Kobashi

Local bridge that proxies inference for Codex and Claude Desktop.

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

> The new build is at `dist/Kobashi.app`. To install it: quit Kobashi from its menu, then run `ditto dist/Kobashi.app /Applications/Kobashi.app` and relaunch.

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
npm run build:mac     # pkg + swiftc + bundle → dist/Kobashi.zip
```

Version comes from `package.json` only — `build-mac-app.sh` stamps it into `index.js` via the `/* BUILD_STAMP */` marker and restores the file on exit. Don't hard-code the version anywhere else.

Delete `dist/Kobashi.app` after installing: `open -a Kobashi` matches by bundle id and will happily launch the build-directory copy instead of the installed one.
