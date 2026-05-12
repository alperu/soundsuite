#!/usr/bin/env bash
# TEST 05/08: Out-of-band model evict
#
# Pre:    model loaded by sidecar (verify via /api/ps)
# Action: from host, force-evict it: POST /api/generate with keep_alive: 0
# Wait:   90s (one reconcile cycle)
# Assert: sidecar's modelLoading flag for the role is cleared
#         a subsequent /api/acquire re-warms cleanly (model reappears in /api/ps)

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 05/08: Out-of-band model evict"
require_sidecar
ensure_ollama_up || { red "Ollama not reachable; cannot run test 05"; exit 2; }

ROLE="$EMBED_ROLE"

CLEANUP_FN='true'
trap_cleanup

# Ensure the role's model is loaded by going through /api/acquire.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/acquire" >/dev/null 2>&1 || true
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true

# Discover the model name from sidecar status (registry).
st=$(status_json)
MODEL_NAME=$(json_get "$st" ".roles.$ROLE.model")
if [ -z "$MODEL_NAME" ] || [ "$MODEL_NAME" = "null" ]; then
  MODEL_NAME="$MODEL"
fi
dim "  role '$ROLE' model = $MODEL_NAME"

# Confirm it's loaded in Ollama.
wait_for "ccurl '$OLLAMA_HOST/api/ps' | grep -q '${MODEL_NAME%%:*}'" 60 \
  "model present in Ollama /api/ps after acquire"

# Out-of-band evict.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL_NAME\",\"keep_alive\":0}" \
  "$OLLAMA_HOST/api/generate" >/dev/null 2>&1 || true

wait_for "! ccurl '$OLLAMA_HOST/api/ps' | grep -q '${MODEL_NAME%%:*}'" 20 \
  "model evicted from /api/ps (out-of-band)"

# Wait for one reconcile cycle. The watchdog clears modelLoading on the next
# reconcile tick (~60s); give 90s for margin.
dim "  waiting 90s for watchdog reconcile to clear modelLoading flag..."
sleep 90

st=$(status_json)
# modelLoading is a Set serialized as an array (or maybe object — try both).
ml=$(json_get "$st" '.modelLoading // empty')
if printf '%s' "$ml" | grep -q "$ROLE"; then
  fail "state.modelLoading still contains '$ROLE' after reconcile"
else
  pass "state.modelLoading no longer contains '$ROLE'"
fi

# Next acquire should re-warm.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/acquire" >/dev/null 2>&1 || true

wait_for "ccurl '$OLLAMA_HOST/api/ps' | grep -q '${MODEL_NAME%%:*}'" 90 \
  "model re-warmed and present in /api/ps after acquire"

ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true

finish_test "05-out-of-band-model-evict"
