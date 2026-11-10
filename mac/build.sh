#!/bin/sh
# Builds build/Chytai.app (Apple Silicon and Intel in one) and build/Chytai.dmg. macOS with the Xcode command line
# tools (xcode-select --install); no Xcode project, no npm. Ad-hoc signature until there is a Developer ID.
set -eu
cd "$(dirname "$0")"
rm -rf build
app=build/Chytai.app/Contents
mkdir -p "$app/MacOS" "$app/Resources" build/icon.iconset build/dmg
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos12.0" -o "build/Chytai-$arch" Chytai.swift
done
lipo -create -output "$app/MacOS/Chytai" build/Chytai-arm64 build/Chytai-x86_64
cp Info.plist "$app/Info.plist"
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) icon.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o "$app/Resources/icon.icns"
codesign --force --sign - build/Chytai.app
cp -R build/Chytai.app build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -volname Chytai -srcfolder build/dmg -fs HFS+ -format UDZO -ov build/Chytai.dmg >/dev/null
ls -la build/Chytai.dmg
