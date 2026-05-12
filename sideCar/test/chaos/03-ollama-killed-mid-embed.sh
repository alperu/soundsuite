#!/usr/bin/env bash
# TEST 03/08: Ollama killed mid-embed
#
# Pre:    Ollama running, MODEL loaded, sidecar idle
# Action: issue an embed request with a long input; mid-flight pkill -9 ollama
# Assert: caller gets an HTTP error (not silent hang)
#         state.perRole[role].activeRequests returns to 0 within 5s
#         (the finally{} invariant from the recent leak fix)
# Recover: restart Ollama
#
# The embed call goes direct to Ollama (the sidecar doesn't proxy inference),
# so the activeRequests counter only moves if the master/test harness goes
# through the acquire/release lifecycle. We simulate that by:
#   1) /api/acquire (increments activeRequests)
#   2) start an embed in the background
#   3) kill Ollama
#   4) /api/release (must decrement back to 0)
# This exercises the same code path the master does.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 03/08: Ollama killed mid-embed"
require_sidecar
ensure_ollama_up || { red "Ollama not reachable; cannot run test 03"; exit 2; }

CLEANUP_FN='start_ollama || true; ccurl -X POST -H "Content-Type: application/json" -d "{\"role\":\"$EMBED_ROLE\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true'
trap_cleanup

ROLE="$EMBED_ROLE"

# Pre-warm: ensure MODEL is loaded.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"warm\"}" \
  "$OLLAMA_HOST/api/embeddings" >/dev/null 2>&1 || true

# Acquire to increment counter.
acq=$(ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/acquire")
dim "  acquire response: ${acq:0:120}"

# Snapshot activeRequests after acquire.
ar_before=$(json_get "$(status_json)" ".roles.$ROLE.activeRequests")
ar_before=${ar_before:-0}
dim "  activeRequests after acquire = $ar_before"

# Build a long input so the embed takes at least a few seconds.
LONG_INPUT=$(printf 'The quick brown fox jumps over the lazy dog. %.0s' $(seq 1 500))

# Issue embed in background.
(ccurl --max-time 60 -X POST -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"$LONG_INPUT\"}" \
  "$OLLAMA_HOST/api/embeddings" >/tmp/chaos-03-embed.out 2>&1) &
EMBED_PID=$!

sleep 2
kill_ollama_hard
dim "  Ollama hard-killed mid-embed"

# Wait for the embed call to die (it must — should not hang silently).
wait_for "! kill -0 $EMBED_PID 2>/dev/null" 30 \
  "embed call returned (did not hang silently)"

# Release the role — exercises the finally{} that must decrement.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true

# Within 5s, activeRequests must be back to 0.
ok=0
for i in 1 2 3 4 5; do
  ar=$(json_get "$(status_json)" ".roles.$ROLE.activeRequests")
  ar=${ar:-0}
  [ "$ar" = "0" ] && { ok=1; break; }
  sleep 1
done
if [ "$ok" -eq 1 ]; then
  pass "activeRequests[$ROLE] returned to 0 within 5s"
else
  fail "activeRequests[$ROLE] stuck at '$ar' after 5s"
fi

# Recover.
start_ollama || fail "could not restart Ollama"
wait_for_status_path '.hostOllama.lastHealth.ok' 'true' 30 \
  "hostOllama back online after recovery"

finish_test "03-ollama-killed-mid-embed"
