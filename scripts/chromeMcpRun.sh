#!/usr/bin/env bash
# debug-ui.sh — Launch Chrome on localhost:3000 with chrome-devtools-mcp wired
# into Claude Code so the assistant can inspect DOM, network, and console
# directly without screenshots.
#
# What this does:
#   1. Registers the chrome-devtools MCP server with Claude Code (idempotent).
#   2. Verifies the Next.js dev server is reachable on :3000 (warns if not).
#   3. Launches Chrome (or Chromium) pointed at http://localhost:3000 with a
#      dedicated user-data-dir + remote debugging port. The MCP server attaches
#      to that Chrome instance so the assistant can drive it.
#
# Usage:
#   ./scripts/debug-ui.sh                # default URL: http://localhost:3000
#   ./scripts/debug-ui.sh /search        # open /search route
#   PORT=3001 ./scripts/debug-ui.sh      # override Next.js port

set -euo pipefail

DEBUG_PORT="${DEBUG_PORT:-9222}"
# By default open the CDP info page of the debug Chrome itself, so you can SEE
# that this is the MCP-enabled Chrome. Override to debug an app instead, e.g.
#   PORT=3000 ./scripts/chromeMcpRun.sh /search
PORT="${PORT:-${DEBUG_PORT}}"
URL_PATH="${1:-/json/version}"
TARGET_URL="http://localhost:${PORT}${URL_PATH}"
USER_DATA_DIR="${HOME}/.cache/claude-debug-chrome"

echo "==> debug-ui.sh"
echo "    target:   ${TARGET_URL}"
echo "    cdp port: ${DEBUG_PORT}"
echo

# ---------------------------------------------------------------------------
# 1. Register chrome-devtools MCP server (idempotent)
# ---------------------------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q "chrome-devtools"; then
    echo "==> chrome-devtools MCP already registered"
  else
    echo "==> Registering chrome-devtools MCP server with Claude Code"
    claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest \
      --browserUrl "http://localhost:${DEBUG_PORT}" || {
      echo "    (failed to register automatically — add manually with:"
      echo "       claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl http://localhost:${DEBUG_PORT})"
    }
  fi
else
  echo "==> 'claude' CLI not found — skipping MCP registration."
  echo "    Install Claude Code and re-run, or add manually:"
  echo "       claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl http://localhost:${DEBUG_PORT}"
fi
echo

# ---------------------------------------------------------------------------
# 2. Check dev server
# ---------------------------------------------------------------------------
if curl -s --max-time 2 -o /dev/null -w "%{http_code}" "http://localhost:${PORT}" | grep -qE "^(2|3)"; then
  echo "==> Next.js dev server is up on :${PORT}"
else
  echo "!!  Next.js dev server not responding on :${PORT}"
  echo "    Start it in another terminal:  npm run dev"
fi
echo

# ---------------------------------------------------------------------------
# 3. Locate Chrome / Chromium
# ---------------------------------------------------------------------------
find_chrome() {
  case "$(uname -s)" in
    Darwin)
      for c in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
        [ -x "$c" ] && { echo "$c"; return 0; }
      done
      ;;
    Linux)
      for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
        command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
      done
      ;;
  esac
  return 1
}

CHROME_BIN="$(find_chrome || true)"
if [ -z "$CHROME_BIN" ]; then
  echo "!!  No Chrome/Chromium/Edge binary found."
  echo "    Install Chrome from https://www.google.com/chrome/ and re-run."
  exit 1
fi
echo "==> Using browser: ${CHROME_BIN}"

# ---------------------------------------------------------------------------
# 4. Check if a debug Chrome is already running on DEBUG_PORT
# ---------------------------------------------------------------------------
if curl -s --max-time 1 -o /dev/null "http://localhost:${DEBUG_PORT}/json/version"; then
  echo "==> Chrome already exposing CDP on :${DEBUG_PORT} — reusing."
  echo "    Open this URL in that window:  ${TARGET_URL}"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Launch Chrome with remote debugging
# ---------------------------------------------------------------------------
mkdir -p "${USER_DATA_DIR}"
echo "==> Launching Chrome with --remote-debugging-port=${DEBUG_PORT}"
echo "    user-data-dir: ${USER_DATA_DIR}"
echo
echo "    Tell Claude:  'use the chrome-devtools mcp to inspect the page'"
echo

exec "${CHROME_BIN}" \
  --remote-debugging-port="${DEBUG_PORT}" \
  --user-data-dir="${USER_DATA_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  "${TARGET_URL}"
