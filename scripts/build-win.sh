#!/bin/bash
set -e
cd "$(dirname "$0")/.."   # always run from repo root

BINARY="kobashi"
VERSION="1.5.0"

echo "==> Building Windows binary..."
mkdir -p dist
npx @yao-pkg/pkg . --targets node18-win-x64 --output "dist/${BINARY}.exe"

# Set custom icon (extract pkg payload, rcedit, restore payload)
echo "==> Setting icon..."
node scripts/set-icon.js "dist/${BINARY}.exe" assets/kobashi-icon.ico

# Change PE subsystem from Console (3) to GUI (2) — no black window on launch
echo "==> Setting GUI subsystem (no console window)..."
node -e "const fs=require('fs'),e='dist/${BINARY}.exe',b=fs.readFileSync(e),p=b.readUInt32LE(0x3C);b.writeUInt16LE(2,p+0x5C);fs.writeFileSync(e,b)"

echo ""
echo "Done! dist/${BINARY}.exe  ($(du -sh "dist/${BINARY}.exe" | cut -f1))"
