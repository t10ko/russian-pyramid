#!/usr/bin/env bash
# Create a drag-to-Applications disk image from the app built by build_macos.sh.
set -euo pipefail

dist="$(cd "$(dirname "$0")/dist" && pwd)"
app="$dist/Russian Pyramid.app"
arch="$(lipo -archs "$app/Contents/MacOS/Russian Pyramid")"
dmg="$dist/russian-pyramid-$arch.dmg"

codesign --verify --deep --strict "$app"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
ditto "$app" "$staging/Russian Pyramid.app"
ln -s /Applications "$staging/Applications"
hdiutil create -quiet -fs HFS+ -volname "Russian Pyramid" \
  -srcfolder "$staging" -format UDZO -ov "$dmg"
hdiutil verify -quiet "$dmg"
printf 'Created %s\n' "$dmg"
