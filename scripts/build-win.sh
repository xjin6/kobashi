#!/bin/bash
set -e
if [ "${KOBASHI_BUILD_STAGED:-}" != "1" ]; then
  exec node "$(dirname "$0")/build-local.js" win
fi
cd "$(dirname "$0")/.."   # always run from repo root

BINARY="Kobashi"
# Single source of truth: package.json. Hard-coding it here as well is what let
# v1.9.2 ship displaying "v1.9.1" — two copies, only one of them bumped.
VERSION="$(node -p "require('./package.json').version")"
RELEASE_DATE="$(date +%Y-%m-%d)"

# Stamp only the disposable source copy. build-local.js removes it on exit.
node -e "
const fs=require('fs');let s=fs.readFileSync('index.js','utf8');
const before=s;
const v=process.argv[1], d=process.argv[2];
s=s.replace('/* BUILD_STAMP */', 'APP_VERSION = '+JSON.stringify(v)+'; APP_DATE = '+JSON.stringify(d)+';');
if (s===before) { console.error('ERROR: BUILD_STAMP marker not found in index.js'); process.exit(1); }
fs.writeFileSync('index.js',s);
" "$VERSION" "$RELEASE_DATE" || exit 1
echo "==> Stamped v${VERSION} (${RELEASE_DATE})"

echo "==> Building Windows binary..."
mkdir -p dist
# This manifest is the staged copy, never the working checkout.
node -e "const fs=require('fs'),p=require('./package.json');p.bin='scripts/windows-entry.js';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
npx @yao-pkg/pkg . --targets node22-win-x64 --output "dist/${BINARY}.exe" --no-bytecode --public

# Set custom icon (extract pkg payload, rcedit, restore payload)
echo "==> Setting icon..."
node scripts/set-icon.js "dist/${BINARY}.exe" assets/kobashi-icon.ico "$VERSION"

# Change PE subsystem from Console (3) to GUI (2) — no black window on launch
echo "==> Setting GUI subsystem (no console window)..."
node -e "const fs=require('fs'),e='dist/${BINARY}.exe',b=fs.readFileSync(e),p=b.readUInt32LE(0x3C);b.writeUInt16LE(2,p+0x5C);fs.writeFileSync(e,b)"

echo "==> Verifying the packaged native-account runtime..."
node scripts/verify-win-package.js "dist/${BINARY}.exe" "$VERSION"

echo ""
echo "==> Built ${BINARY}.exe  ($(du -sh "dist/${BINARY}.exe" | cut -f1))"
