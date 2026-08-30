#!/bin/bash
# Blocks any command that would kill the running Kobashi (or Claude Desktop)
# process. Kobashi is the user's live AI connection — killing it ends the
# conversation with no way for them to tell us.
cmd="$(cat | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

if printf '%s' "$cmd" | grep -qiE '(pkill|killall)[^|;&]*(kobashi|Kobashi\.app|Claude\.app)|kill[[:space:]]+(-[A-Za-z0-9]+[[:space:]]+)*[0-9]+.*#?.*kobashi'; then
  cat >&2 <<'MSG'
BLOCKED: this command would kill Kobashi (or Claude Desktop).

Kobashi is the user's live connection to the AI — killing it cuts the
conversation they are having right now, and they cannot tell you so.

Ask the user to quit and relaunch it themselves, then wait. See CLAUDE.md.
MSG
  exit 2
fi
exit 0
