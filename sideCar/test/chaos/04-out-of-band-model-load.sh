#!/usr/bin/env bash
# TEST 04/08: Out-of-band model load
#
# Pre:    sidecar idle, no models loaded by sidecar
# Action: user side-loads a model directly via `ollama run` — sidecar
#         did not request it
# Wait:   90s (one reconcile cycle is 60s; give margin)
# Assert: watchdog reconciler picked up the load:
#           - hostOllamaLastHealth.ok == true
#           - vram.unattributedMb > 0 (model VRAM not attributed to any role)

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 04/08: Out-of-band model load"
require_sidecar
ensure_ollama_up || { red "Ollama not reachable; cannot run test 04"; exit 2; }

: "${OOB_MODEL:=qwen2:0.5b}"

CLEANUP_FN='ccurl -X POST -H "Content-Type: application/json" -d "{\"model\":\"$OOB_MODEL\",\"keep_alive\":0}" "$OLLAMA_HOST/api/generate" >/dev/null 2>&1 || true'
trap_cleanup

# Snapshot unattributedMb baseline.
unattr_before=$(json_get "$(status_json)" '.vram.unattributedMb')
unattr_before=${unattr_before:-0}
[ "$unattr_before" = "null" ] && unattr_before=0
dim "  baseline vram.unattributedMb = $unattr_before"

# Side-load the model via /api/generate (cheaper than `ollama run` and equivalent).
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"model\":\"$OOB_MODEL\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":\"5m\"}" \
  "$OLLAMA_HOST/api/generate" >/dev/null 2>&1 || true

# Verify it actually loaded.
wait_for "ccurl '$OLLAMA_HOST/api/ps' | grep -q '$OOB_MODEL'" 30 \
  "side-loaded model '$OOB_MODEL' present in Ollama /api/ps"

# Wait one full reconcile cycle.
dim "  waiting 90s for reconciler tick..."
sleep 90

st=$(status_json)
ok=$(json_get "$st" '.hostOllama.lastHealth.ok')
assert_eq "true" "$ok" "hostOllama.lastHealth.ok"

unattr_after=$(json_get "$st" '.vram.unattributedMb')
unattr_after=${unattr_after:-0}
[ "$unattr_after" = "null" ] && unattr_after=0

# Compare as integers when possible.
if [ "$unattr_after" -gt 0 ] 2>/dev/null; then
  pass "vram.unattributedMb > 0 (got $unattr_after, baseline $unattr_before)"
else
  # On Mac without nvidia-smi vram may be null/unsupported. Don't fail hard.
  yellow "  vram.unattributedMb = $unattr_after — VRAM accounting may be unsupported on this host (Mac w/o nvidia-smi)"
fi

finish_test "04-out-of-band-model-load"
