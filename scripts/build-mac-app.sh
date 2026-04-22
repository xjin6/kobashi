#!/bin/bash
set -e
cd "$(dirname "$0")/.."   # always run from repo root

APP_NAME="Kobashi"
BUNDLE_ID="com.xjin6.kobashi"
VERSION="1.5.1"
BINARY="kobashi"

echo "==> Building Node.js binaries..."
mkdir -p dist
pkg . --targets node20-macos-arm64 --output "dist/${BINARY}-node-arm64"
pkg . --targets node20-macos-x64   --output "dist/${BINARY}-node-x64"

echo "==> Compiling Swift wrapper..."
swiftc -framework Cocoa -framework WebKit \
  -target arm64-apple-macos11 \
  macos/main.swift -o "dist/${BINARY}-swift-arm64"
swiftc -framework Cocoa -framework WebKit \
  -target x86_64-apple-macos10.15 \
  macos/main.swift -o "dist/${BINARY}-swift-x64"

echo "==> Creating universal Swift wrapper with lipo..."
lipo -create "dist/${BINARY}-swift-arm64" "dist/${BINARY}-swift-x64" \
     -output "dist/${BINARY}-swift"
rm "dist/${BINARY}-swift-arm64" "dist/${BINARY}-swift-x64"

echo "==> Generating ICNS icon..."
# Follow Apple's Dock icon template: 1024x1024 canvas with ~100px transparent
# padding on every side, so the white squircle itself is 824x824 (matches the
# visual size of Edge / Teams / VS Code). Corner radius ~185 on the squircle.
python3 - <<'PY'
from PIL import Image, ImageDraw
SRC = "assets/kobashi-icon.png"
OUT = "/tmp/kobashi-padded.png"
CANVAS   = 1024
SQUIRCLE = 824          # white rounded-square size (Apple grid)
RADIUS   = 185          # matches Apple's continuous-corner squircle
ART      = 660          # artwork fits inside squircle with inner breathing room
X_NUDGE  = -24          # shift artwork slightly left for optical centering
pad = (CANVAS - SQUIRCLE) // 2
canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
bg = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
ImageDraw.Draw(bg).rounded_rectangle(
    [(pad, pad), (pad + SQUIRCLE - 1, pad + SQUIRCLE - 1)],
    RADIUS, fill=(255, 255, 255, 255),
)
canvas.alpha_composite(bg)
src = Image.open(SRC).convert("RGBA")
src.thumbnail((ART, ART), Image.LANCZOS)
x = (CANVAS - src.width)  // 2 + X_NUDGE
y = (CANVAS - src.height) // 2
canvas.alpha_composite(src, (x, y))
canvas.save(OUT)
PY
ICON_SRC="/tmp/kobashi-padded.png"
ICONSET="dist/AppIcon.iconset"
rm -rf "${ICONSET}"
mkdir -p "${ICONSET}"
for size in 16 32 128 256 512; do
  sips -z $size $size "${ICON_SRC}" \
    --out "${ICONSET}/icon_${size}x${size}.png"           > /dev/null
  sips -z $((size*2)) $((size*2)) "${ICON_SRC}" \
    --out "${ICONSET}/icon_${size}x${size}@2x.png"        > /dev/null
done
rm -f /tmp/kobashi-padded.png
iconutil -c icns "${ICONSET}" -o "dist/AppIcon.icns"
rm -rf "${ICONSET}"

echo "==> Assembling .app bundle..."
APP="dist/${APP_NAME}.app"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS"
mkdir -p "${APP}/Contents/Resources/bin"

cp "dist/${BINARY}-swift" "${APP}/Contents/MacOS/${BINARY}"
chmod +x "${APP}/Contents/MacOS/${BINARY}"
rm "dist/${BINARY}-swift"

cp "dist/${BINARY}-node-arm64" "${APP}/Contents/Resources/bin/${BINARY}-arm64"
cp "dist/${BINARY}-node-x64"   "${APP}/Contents/Resources/bin/${BINARY}-x64"
chmod +x "${APP}/Contents/Resources/bin/${BINARY}-arm64"
chmod +x "${APP}/Contents/Resources/bin/${BINARY}-x64"
rm "dist/${BINARY}-node-arm64" "dist/${BINARY}-node-x64"

cp "dist/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"
rm "dist/AppIcon.icns"

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
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo "==> Packaging as zip..."
cd dist
zip -r "${APP_NAME}.zip" "${APP_NAME}.app"
cd ..

echo ""
echo "Done! dist/${APP_NAME}.zip  ($(du -sh "dist/${APP_NAME}.zip" | cut -f1))"
