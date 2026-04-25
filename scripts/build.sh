#!/usr/bin/env bash
# Build the cert-keeper release zip.
#
#   scripts/build.sh              # writes dist/cert-keeper-<version>.zip
#   scripts/build.sh --version vX # override version (otherwise read from manifest.json)
#
# The zip contains the unpacked browser extension at the top level (so users
# can extract → "Load unpacked" without an extra subdirectory step) plus the
# Python server and CLI under server/ and cli/.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
fi

OUT_DIR="dist"
STAGE="$OUT_DIR/cert-keeper"
ZIP_PATH="$OUT_DIR/cert-keeper-${VERSION}.zip"

rm -rf "$OUT_DIR"
mkdir -p "$STAGE"

# Browser extension files
EXT_FILES=(
  manifest.json
  background.js
  config.js
  popup.html popup.js
  recorder.html recorder.js recorder.css
  interceptor.js interceptor_bridge.js
  icons
)
for f in "${EXT_FILES[@]}"; do
  cp -R "$f" "$STAGE/"
done

# Server + CLI bundle
mkdir -p "$STAGE/server" "$STAGE/cli"
cp server/__init__.py server/auth.py server/cookie_server.py \
   server/install_native_host.py server/native_host.py server/storage.py \
   "$STAGE/server/"
cp cli/cert-keeper "$STAGE/cli/"
chmod +x "$STAGE/cli/cert-keeper"

cp README.md "$STAGE/"

(cd "$OUT_DIR" && zip -qr "$(basename "$ZIP_PATH")" cert-keeper)
echo "wrote $ZIP_PATH"
