#!/usr/bin/env bash
# Sound Suite Sidecar — Download & Install (Linux/macOS)
# Usage:
#   ./install.sh                                    # defaults to http://172.16.16.9:3000
#   ./install.sh http://192.168.1.50:3000           # custom server
#   ./install.sh --docker http://192.168.1.50:3000  # install AND start in Docker mode
#   INSTALL_DIR=/opt/sidecar ./install.sh           # custom install path
set -euo pipefail

# Pull --docker (or -d) out of the positional args. When present, the
# installer chains directly into start.sh --docker after the install
# completes so operators get one-line install-and-run.
START_AFTER_DOCKER=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --docker|-d) START_AFTER_DOCKER=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]:-}"

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
echo "  URL: $MANIFEST_URL"
# `-m 15` caps the whole transfer at 15 s so we fail fast on unreachable
# masters instead of curl's default ~5-min timeout (which feels like a hang).
# Show curl's own error text on failure so the operator can tell DNS vs
# connection-refused vs HTTP error at a glance.
CURL_ERR=$(curl -fsS -m 15 --connect-timeout 5 "$MANIFEST_URL" -o "$TMP_DIR/manifest.json" 2>&1) || {
  echo "[ERROR] Could not reach $MANIFEST_URL"
  echo "  curl said: $CURL_ERR"
  echo ""
  echo "  Diagnostics:"
  echo "  - Is the master server running at $SERVER?"
  echo "      (curl -v $SERVER/api/health from this host)"
  echo "  - Is this host on the same network as the master?"
  echo "  - Is a firewall blocking outbound TCP to $SERVER?"
  exit 1
}

# Parse JSON manifest. We deliberately avoid `python3` entirely: on macOS,
# /usr/bin/python3 is a stub that EXISTS in PATH but pops the "Install Xcode
# Command Line Tools" GUI dialog when actually invoked. `command -v python3`
# returns success there, so guarding with it isn't enough. Same trap exists
# for `git`. Use node if present, otherwise sed — neither triggers the
# macOS dialog.
#
# IMPORTANT: the manifest is pretty-printed JSON ("version": "2.2.71" with
# whitespace after the colon). Earlier this used `grep -o '"k":"v"'` with no
# space, which silently failed under `set -eo pipefail` when Node wasn't
# installed and killed the script with no error message. The sed pattern
# below tolerates arbitrary whitespace.
parse_json_field() {
  local field="$1"
  local file="$2"
  local val=""
  if command -v node >/dev/null 2>&1; then
    val=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$file','utf8')).$field)" 2>/dev/null) || val=""
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  fi
  # POSIX sed fallback: capture the string value after `"<field>" : "..."`,
  # tolerating any whitespace around the colon.
  val=$(sed -nE 's/.*"'"$field"'"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$file" | head -1)
  if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  return 1
}

# Wrap assignments in explicit error handling so a parse failure surfaces
# clearly instead of silently exiting under `set -e`.
VERSION=$(parse_json_field version "$TMP_DIR/manifest.json") || {
  echo "[ERROR] Could not parse 'version' from manifest. Manifest content:"
  sed -n '1,20p' "$TMP_DIR/manifest.json"
  exit 1
}
EXPECTED_SHA=$(parse_json_field sha256 "$TMP_DIR/manifest.json") || {
  echo "[ERROR] Could not parse 'sha256' from manifest. Manifest content:"
  sed -n '1,20p' "$TMP_DIR/manifest.json"
  exit 1
}

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

# When --docker was passed, chain straight into start.sh so the operator
# gets a one-line install-and-run experience. exec replaces this process
# so logs/Ctrl-C work as expected.
if [ "$START_AFTER_DOCKER" = "1" ]; then
  echo "[install.sh] --docker passed — chaining into start.sh --docker $SERVER"
  echo "  (cd $INSTALL_DIR && exec ./start.sh --docker $SERVER)"
  echo ""
  cd "$INSTALL_DIR"
  exec ./start.sh --docker "$SERVER"
fi

echo "Start the sidecar:"
echo "  cd $INSTALL_DIR"
echo "  ./start.sh $SERVER          # Node mode (or --docker for container mode)"
echo ""
