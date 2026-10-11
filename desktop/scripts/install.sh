#!/bin/sh
# Copies the packaged app to ~/Applications and puts a link on the Desktop.
# Run through `npm run install-app`, which packages first.
set -e
cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').productName")
src=$(ls -d dist/mac*/"$name".app | head -1)
dest="$HOME/Applications/$name.app"

# Quit a running copy so it can be replaced.
osascript -e 'tell application id "local.finance.dashboard" to quit' 2>/dev/null || true
sleep 1

mkdir -p "$HOME/Applications"
rm -rf "$dest"
cp -R "$src" "$dest"
# Ad-hoc signature: Apple Silicon refuses to run unsigned code at all.
codesign --force --deep --sign - "$dest" >/dev/null 2>&1

ln -sfn "$dest" "$HOME/Desktop/$name.app"
echo "installed: $dest"
echo "desktop:   $HOME/Desktop/$name.app"
