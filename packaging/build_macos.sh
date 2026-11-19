#!/usr/bin/env bash
# Build the standalone macOS app.
#
#   packaging/build_macos.sh
#
# Produces packaging/dist/russian-pyramid/ and packaging/dist/Russian Pyramid.app
# Run packaging/package_macos.sh to make a distribution disk image.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV="${BUILD_VENV:-$ROOT/packaging/.venv}"

if [ ! -x "$VENV/bin/python" ]; then
  uv venv --python 3.12 "$VENV"
fi

uv pip install --python "$VENV/bin/python" -e ".[dev]" pyinstaller

"$VENV/bin/python" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "$ROOT/packaging/dist" \
  --workpath "$ROOT/packaging/build" \
  "$ROOT/packaging/russian_pyramid.spec"

APP="packaging/dist/Russian Pyramid.app"
if [ ! -d "$APP" ]; then
  echo "bundle missing: $APP" >&2
  exit 1
fi
codesign --verify --deep --strict "$APP"

echo
echo "built: $APP"
du -sh "$APP"
