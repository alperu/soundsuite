#!/usr/bin/env bash
# TEST 01/08: Ollama down at boot
#
# Pre:    native Ollama stopped
# Action: query /api/status & /api/acquire while Ollama is down
# Assert: hostOllama.lastHealth.error == 'ollama_not_running'
#         /api/acquire returns a clean error envelope (not 500)
# Recover: start Ollama; within one watchdog tick (~20s) lastHealth.ok == true
#
# NOTE: This test does NOT restart the sidecar (we can't, from a script that
# the sidecar may itself be hosting). It simulates "down at boot" by stopping
# Ollama and waiting for the watchdog to pick it up — equivalent observable.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 01/08: Ollama down at boot"
require_sidecar

CLEANUP_FN='start_ollama || true'
trap_cleanup

# Bring Ollama down.
stop_ollama || { yellow "  (stop_ollama returned non-zero — proceeding anyway)"; }

# Give watchdog one tick to classify (PROBE_INTERVAL_MS = 15s).
wait_for_status_path '.hostOllama.lastHealth.error' 'ollama_not_running' 25 \
  "hostOllama.lastHealth.error classified as 'ollama_not_running'"

# /api/acquire for an Ollama role should return a clean error, not 500.
resp_code=$(ccurl -o /tmp/chaos-01-acquire.json -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$EMBED_ROLE\"}" \
  "$SIDECAR_URL/api/acquire" || true)

if [ "$resp_code" = "500" ]; then
  fail "/api/acquire returned 500 (should be a clean error envelope)"
else
  pass "/api/acquire returned HTTP $resp_code (not 500)"
fi

body=$(cat /tmp/chaos-01-acquire.json 2>/dev/null || echo '{}')
err_msg=$(json_get "$body" '.error')
if [ -n "$err_msg" ] && [ "$err_msg" != "null" ]; then
  pass "/api/acquire body has .error field: ${err_msg:0:80}"
else
  yellow "  /api/acquire body without .error: ${body:0:120}"
fi

# Recover.
start_ollama || fail "could not restart Ollama"

wait_for_status_path '.hostOllama.lastHealth.ok' 'true' 30 \
  "watchdog reports lastHealth.ok=true after recovery"

finish_test "01-ollama-down-at-boot"
