#!/bin/sh
# Builds build/icon.icns from the macOS iconset in ../logo-assets, the single
# source of the app's logo. iconutil needs the @2x suffix, so the iconset is
# copied to a temp dir and renamed there; logo-assets stays untouched.
set -e
cd "$(dirname "$0")/.."
src=../logo-assets/macos/AppIcon.iconset
tmp=$(mktemp -d)/AppIcon.iconset
cp -R "$src" "$tmp"
for f in "$tmp"/*-2x.png; do mv "$f" "$(echo "$f" | sed 's/-2x\.png$/@2x.png/')"; done
mkdir -p build
iconutil -c icns "$tmp" -o build/icon.icns
rm -rf "$(dirname "$tmp")"
echo "icon: build/icon.icns from $src"
