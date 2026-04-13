#!/bin/bash
set -e

APP_NAME="Codex Copilot Bridge"
BUNDLE_ID="com.xjin6.codex-copilot-bridge"
VERSION="1.1.0"
BINARY="codex-copilot-bridge"

echo "==> Building binaries..."
mkdir -p dist
pkg . --targets node20-macos-arm64 --output "dist/${BINARY}-arm64"
pkg . --targets node20-macos-x64   --output "dist/${BINARY}-x64"

echo "==> Generating ICNS icon..."
ICONSET="dist/AppIcon.iconset"
rm -rf "${ICONSET}"
mkdir -p "${ICONSET}"
for size in 16 32 128 256 512; do
  sips -z $size $size codex-color.png --out "${ICONSET}/icon_${size}x${size}.png"       > /dev/null
  sips -z $((size*2)) $((size*2)) codex-color.png --out "${ICONSET}/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "${ICONSET}" -o "dist/AppIcon.icns"
rm -rf "${ICONSET}"

echo "==> Assembling .app bundle..."
APP="dist/${APP_NAME}.app"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS"
mkdir -p "${APP}/Contents/Resources/bin"

# Both arch binaries live in Resources/bin; a launcher shell selects at runtime
cp "dist/${BINARY}-arm64" "${APP}/Contents/Resources/bin/${BINARY}-arm64"
cp "dist/${BINARY}-x64"   "${APP}/Contents/Resources/bin/${BINARY}-x64"
chmod +x "${APP}/Contents/Resources/bin/${BINARY}-arm64"
chmod +x "${APP}/Contents/Resources/bin/${BINARY}-x64"
rm "dist/${BINARY}-arm64" "dist/${BINARY}-x64"

# Shell launcher — detaches the server immediately so macOS doesn't hang waiting
cat > "${APP}/Contents/MacOS/${BINARY}" << 'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")/../Resources/bin" && pwd)"
if [ "$(uname -m)" = "arm64" ]; then
  BINARY_PATH="$DIR/codex-copilot-bridge-arm64"
else
  BINARY_PATH="$DIR/codex-copilot-bridge-x64"
fi
# Run in background so this script exits immediately (avoids macOS "not responding")
nohup "$BINARY_PATH" > /tmp/codex-copilot-bridge.log 2>&1 &
LAUNCHER
chmod +x "${APP}/Contents/MacOS/${BINARY}"

cp "dist/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"

cat > "${APP}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleExecutable</key>
  <string>${BINARY}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo "==> Packaging as zip..."
cd dist
zip -r "${APP_NAME}.zip" "${APP_NAME}.app"
cd ..

echo ""
echo "Done! dist/${APP_NAME}.zip"
echo "      $(du -sh "dist/${APP_NAME}.zip" | cut -f1)  —  universal binary (arm64 + x64)"
