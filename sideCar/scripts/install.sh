#!/usr/bin/env bash
# Sound Suite Sidecar — Download & Install (Linux/macOS)
# Usage:
#   ./install.sh                          # defaults to http://172.16.16.9:3000
#   ./install.sh http://192.168.1.50:3000 # custom server
#   INSTALL_DIR=/opt/sidecar ./install.sh # custom install path
set -euo pipefail

SERVER="${1:-http://172.16.16.9:3000}"
# Default install dir: <cwd>/sidecar — keeps the user on the drive/folder they
# invoked the installer from. Override with: INSTALL_DIR=/opt/sidecar ./install.sh
INSTALL_DIR="${INSTALL_DIR:-$PWD/sidecar}"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "================================"
echo " Sound Suite Sidecar Installer"
echo "================================"
echo "  Server:  $SERVER"
echo "  Install: $INSTALL_DIR"
echo ""

# --- Download manifest ---
echo "[1/4] Fetching version info..."
MANIFEST_URL="$SERVER/sideCar/builds/manifest.json"
if ! curl -sf "$MANIFEST_URL" -o "$TMP_DIR/manifest.json"; then
  echo "[ERROR] Could not reach $MANIFEST_URL"
  echo "  Make sure the server is running and has a published sidecar build."
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('$TMP_DIR/manifest.json'))['version'])" 2>/dev/null \
  || node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP_DIR/manifest.json','utf8')).version)" 2>/dev/null \
  || grep -o '"version":"[^"]*"' "$TMP_DIR/manifest.json" | head -1 | cut -d'"' -f4)

EXPECTED_SHA=$(python3 -c "import json; print(json.load(open('$TMP_DIR/manifest.json'))['sha256'])" 2>/dev/null \
  || node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP_DIR/manifest.json','utf8')).sha256)" 2>/dev/null \
  || grep -o '"sha256":"[^"]*"' "$TMP_DIR/manifest.json" | head -1 | cut -d'"' -f4)

echo "  Latest version: v$VERSION"

# --- Check existing install ---
if [ -f "$INSTALL_DIR/VERSION" ]; then
  CURRENT=$(cat "$INSTALL_DIR/VERSION")
  if [ "$CURRENT" = "$VERSION" ]; then
    echo "[OK] Already running v$VERSION — nothing to do."
    echo "  Start with: $INSTALL_DIR/start.sh $SERVER"
    exit 0
  fi
  echo "  Upgrading: v$CURRENT -> v$VERSION"
fi

# --- Download tarball ---
echo "[2/4] Downloading sidecar-latest.tar.gz..."
TARBALL_URL="$SERVER/sideCar/builds/sidecar-latest.tar.gz"
curl -f --progress-bar "$TARBALL_URL" -o "$TMP_DIR/sidecar-latest.tar.gz"

# --- Verify checksum ---
echo "[3/4] Verifying checksum..."
if command -v shasum &>/dev/null; then
  ACTUAL_SHA=$(shasum -a 256 "$TMP_DIR/sidecar-latest.tar.gz" | awk '{print $1}')
elif command -v sha256sum &>/dev/null; then
  ACTUAL_SHA=$(sha256sum "$TMP_DIR/sidecar-latest.tar.gz" | awk '{print $1}')
else
  echo "  [WARN] No sha256 tool found — skipping verification."
  ACTUAL_SHA="$EXPECTED_SHA"
fi

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[ERROR] Checksum mismatch!"
  echo "  Expected: $EXPECTED_SHA"
  echo "  Got:      $ACTUAL_SHA"
  exit 1
fi
echo "  SHA-256 OK"

# --- Extract ---
echo "[4/4] Installing to $INSTALL_DIR..."

# Stop running sidecar if found
if command -v docker &>/dev/null && docker ps -q -f name=ss-sidecar 2>/dev/null | grep -q .; then
  echo "  Stopping running sidecar container..."
  docker stop ss-sidecar 2>/dev/null || true
  docker rm ss-sidecar 2>/dev/null || true
fi

# Back up existing config
if [ -f "$INSTALL_DIR/config/config.json" ]; then
  cp "$INSTALL_DIR/config/config.json" "$TMP_DIR/config.json.bak"
fi

# Extract (tarball contains sidecar/ directory)
tar xzf "$TMP_DIR/sidecar-latest.tar.gz" -C "$TMP_DIR"

# Replace install directory
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR.old"
[ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] && mv "$INSTALL_DIR" "$INSTALL_DIR.old"
mkdir -p "$INSTALL_DIR"
cp -r "$TMP_DIR/sidecar/." "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/start.sh"

# Restore config
if [ -f "$TMP_DIR/config.json.bak" ]; then
  mkdir -p "$INSTALL_DIR/config"
  cp "$TMP_DIR/config.json.bak" "$INSTALL_DIR/config/config.json"
  echo "  Config restored."
fi

# Clean up old backup
rm -rf "$INSTALL_DIR.old"

echo ""
echo "================================"
echo " Installed v$VERSION"
echo "================================"
echo ""
echo "Start the sidecar:"
echo "  cd $INSTALL_DIR"
echo "  ./start.sh $SERVER"
echo ""
