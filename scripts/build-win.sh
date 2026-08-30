#!/bin/bash
set -e
cd "$(dirname "$0")/.."   # always run from repo root

BINARY="kobashi"
# Single source of truth: package.json. Hard-coding it here as well is what let
# v1.9.2 ship displaying "v1.9.1" — two copies, only one of them bumped.
VERSION="$(node -p "require('./package.json').version")"
RELEASE_DATE="$(date +%Y-%m-%d)"

# Scratch space. A bare mktemp writes to the system temp dir, which is not
# writable under a sandboxed shell — same failure the mac script hit. Honour
# TMPDIR so the build works in restricted environments too.
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"

# Stamp version + date into index.js. pkg has no package.json at runtime, so the
# UI footer would otherwise fall back to "0.0.0". Restored on exit (incl. failure)
# so the working tree is never left modified.
STAMP_BAK="$(mktemp "${TMP}/kobashi-stamp.XXXXXX")"
cp index.js "$STAMP_BAK"
restore_stamp() { cp "$STAMP_BAK" index.js; rm -f "$STAMP_BAK"; }
trap restore_stamp EXIT
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
npx @yao-pkg/pkg . --targets node22-win-x64 --output "dist/${BINARY}.exe"

# Set custom icon (extract pkg payload, rcedit, restore payload)
echo "==> Setting icon..."
node scripts/set-icon.js "dist/${BINARY}.exe" assets/kobashi-icon.ico

# Change PE subsystem from Console (3) to GUI (2) — no black window on launch
echo "==> Setting GUI subsystem (no console window)..."
node -e "const fs=require('fs'),e='dist/${BINARY}.exe',b=fs.readFileSync(e),p=b.readUInt32LE(0x3C);b.writeUInt16LE(2,p+0x5C);fs.writeFileSync(e,b)"

echo ""
echo "Done! dist/${BINARY}.exe  ($(du -sh "dist/${BINARY}.exe" | cut -f1))"
