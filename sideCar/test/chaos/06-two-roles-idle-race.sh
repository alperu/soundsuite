#!/usr/bin/env bash
# TEST 06/08: Two roles, same endpoint, idle race
#
# Pre:    embedding and completion roles both on host runtime, both warm
# Action: stop only the embedding role via /api/stop
# Assert: embedding's model gone from /api/ps; completion's model still there
#         with size_vram > 0
#
# Caveat: requires the sidecar to be configured with both roles host-routed.
# Skips with a warning if /api/status shows only one host role.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 06/08: Two roles, same endpoint, idle race"
require_sidecar
ensure_ollama_up || { red "Ollama not reachable; cannot run test 06"; exit 2; }

st=$(status_json)
roles_json=$(json_get "$st" '.hostOllama.roles')
if ! printf '%s' "$roles_json" | grep -q "$EMBED_ROLE" \
  || ! printf '%s' "$roles_json" | grep -q "$COMPLETION_ROLE"; then
  yellow "  hostOllama.roles does not include both '$EMBED_ROLE' and '$COMPLETION_ROLE'"
  yellow "  hostOllama.roles = $roles_json"
  yellow "  Skipping — set SS_HOST_OLLAMA_ROLES=embedding,completion and restart sidecar."
  exit 0
fi

CLEANUP_FN='true'
trap_cleanup

# Warm both roles.
for r in "$EMBED_ROLE" "$COMPLETION_ROLE"; do
  ccurl -X POST -H 'Content-Type: application/json' \
    -d "{\"role\":\"$r\"}" "$SIDECAR_URL/api/acquire" >/dev/null 2>&1 || true
  ccurl -X POST -H 'Content-Type: application/json' \
    -d "{\"role\":\"$r\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true
done

# Discover both models from registry.
st=$(status_json)
EMBED_MODEL=$(json_get "$st" ".roles.$EMBED_ROLE.model")
COMP_MODEL=$(json_get "$st" ".roles.$COMPLETION_ROLE.model")
dim "  embedding model = $EMBED_MODEL"
dim "  completion model = $COMP_MODEL"

# Wait until both appear in /api/ps.
wait_for "ccurl '$OLLAMA_HOST/api/ps' | grep -q '${EMBED_MODEL%%:*}'" 60 \
  "embedding model in /api/ps"
wait_for "ccurl '$OLLAMA_HOST/api/ps' | grep -q '${COMP_MODEL%%:*}'" 60 \
  "completion model in /api/ps"

# Stop only embedding.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$EMBED_ROLE\"}" "$SIDECAR_URL/api/stop" >/dev/null 2>&1 || true

# Within 30s, embedding model gone, completion still present.
wait_for "! ccurl '$OLLAMA_HOST/api/ps' | grep -q '${EMBED_MODEL%%:*}'" 30 \
  "embedding model evicted from /api/ps"

ps_now=$(ccurl "$OLLAMA_HOST/api/ps" || echo '{}')
if printf '%s' "$ps_now" | grep -q "${COMP_MODEL%%:*}"; then
  pass "completion model still present in /api/ps (collateral-damage check)"
else
  fail "completion model also disappeared — eviction collateral damage"
fi

# Check size_vram > 0 on completion entry (best-effort with grep).
size_line=$(printf '%s' "$ps_now" | grep -oE '"size_vram"[[:space:]]*:[[:space:]]*[0-9]+' | head -1)
if [ -n "$size_line" ]; then
  num=$(printf '%s' "$size_line" | grep -oE '[0-9]+' | head -1)
  if [ "${num:-0}" -gt 0 ] 2>/dev/null; then
    pass "completion entry has size_vram=$num (>0)"
  else
    yellow "  size_vram=$num (not >0; may be CPU-only Ollama)"
  fi
fi

finish_test "06-two-roles-idle-race"
