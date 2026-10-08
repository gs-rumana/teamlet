#!/bin/sh
# Renders the preview cards to PNG with headless Chrome.
set -e
cd "$(dirname "$0")"
python3 generate.py
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in cards/*.html; do
  name=$(basename "$f" .html)
  case "$name" in index) h=3700;; overview) h=536;; *) h=516;; esac
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1180,$h --screenshot="cards/$name.png" "file://$PWD/$f" >/dev/null 2>&1
done
ls -la cards/*.png
