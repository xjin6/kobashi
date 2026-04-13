#!/bin/bash
set -e
cd "$(dirname "$0")/.."   # always run from repo root

BINARY="codex-copilot-bridge"
VERSION="1.1.0"

echo "==> Building Windows binary..."
mkdir -p dist
pkg . --targets node20-win-x64 --output "dist/${BINARY}.exe"

echo ""
echo "Done! dist/${BINARY}.exe  ($(du -sh "dist/${BINARY}.exe" | cut -f1))"
