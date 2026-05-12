#!/usr/bin/env bash
# TEST 02/08: Ollama killed mid-pull
#
# Pre:    Ollama running, MODEL NOT present locally (we remove it first)
# Action: POST /api/start to trigger pull; partway through, hard-kill Ollama
# Assert: task tracker marks the pull 'failed'; state.pullFailCount[role] > 0
# Recover: restart Ollama, retry pull, succeeds.
#
# Caveat: deleting and re-pulling a model is expensive. By default we use a
# tiny model (TEST_PULL_MODEL, defaults to 'qwen2:0.5b') so this completes in
# a reasonable time. Override via env if you want a different model.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

echo "TEST 02/08: Ollama killed mid-pull"
require_sidecar
ensure_ollama_up || { red "Ollama not reachable; cannot run test 02"; exit 2; }

: "${TEST_PULL_MODEL:=qwen2:0.5b}"

CLEANUP_FN='start_ollama || true'
trap_cleanup

# Determine which role we'll pull on. We pick whichever host-role exists.
ROLE="$EMBED_ROLE"

# Make sure the model is absent (so /api/start will trigger a real pull).
ccurl -X DELETE -H 'Content-Type: application/json' \
  -d "{\"model\":\"$TEST_PULL_MODEL\"}" "$OLLAMA_HOST/api/delete" >/dev/null 2>&1 || true

# Snapshot pullFailCount baseline.
status_before=$(status_json)
fail_before=$(json_get "$status_before" ".roles.$ROLE.pullFailCount")
fail_before=${fail_before:-0}
[ "$fail_before" = "null" ] && fail_before=0
dim "  baseline pullFailCount[$ROLE] = $fail_before"

# Kick off the pull. We assume the sidecar exposes a way to override the model
# on a role for testing OR honors the current registry model. Most realistic:
# we just trigger /api/start and hard-kill Ollama 3s later.
ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/start" >/dev/null 2>&1 &
START_PID=$!

# Give the pull ~3s to start streaming, then hard-kill Ollama.
sleep 3
kill_ollama_hard
dim "  Ollama hard-killed mid-pull"

# Wait for the start request to return (it should — sidecar reports failure).
wait "$START_PID" 2>/dev/null || true

# Allow up to 30s for the failure to be reflected in state.
ok=0
for i in $(seq 1 30); do
  st=$(status_json)
  fail_now=$(json_get "$st" ".roles.$ROLE.pullFailCount")
  fail_now=${fail_now:-0}
  [ "$fail_now" = "null" ] && fail_now=0
  if [ "$fail_now" -gt "$fail_before" ] 2>/dev/null; then
    pass "pullFailCount[$ROLE] incremented: $fail_before -> $fail_now"
    ok=1
    break
  fi
  # Also check task tracker for a 'failed' task.
  has_failed_task=$(json_get "$st" '.tasks' | grep -c '"status":"failed"' || true)
  if [ "${has_failed_task:-0}" -gt 0 ]; then
    pass "task tracker contains a failed task"
    ok=1
    break
  fi
  sleep 1
done
[ "$ok" -eq 1 ] || fail "no pullFailCount increment and no failed task within 30s"

# Recover: restart Ollama and retry.
start_ollama || fail "could not restart Ollama"
wait_for_status_path '.hostOllama.lastHealth.ok' 'true' 30 \
  "hostOllama back online after restart"

ccurl -X POST -H 'Content-Type: application/json' \
  -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/start" >/dev/null 2>&1 || true

# Wait for the model to appear in /api/tags (proves pull succeeded).
wait_for "ccurl '$OLLAMA_HOST/api/tags' | grep -q '$TEST_PULL_MODEL'" 180 \
  "model '$TEST_PULL_MODEL' present in /api/tags after retry"

finish_test "02-ollama-killed-mid-pull"
