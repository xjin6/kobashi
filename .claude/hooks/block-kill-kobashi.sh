#!/bin/bash
# Blocks any command that would kill the running Kobashi (or Claude Desktop)
# process. Kobashi is the user's live AI connection — killing it ends the
# conversation with no way for them to tell us.
exec python3 "$(dirname "$0")/block-kill-kobashi.py"
