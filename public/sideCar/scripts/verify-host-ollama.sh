#!/usr/bin/env bash
# Sound Suite Sidecar — Host-Ollama Verifier
#
# Proves the host-Ollama path works end-to-end on a Mac (or Linux) with
# Docker + native Ollama. Runs ~10 sequential checks; each prints pass/fail
# with an actionable fix. Exit 0 if every check passes, 1 otherwise.
#
# Usage:
#   ./verify-host-ollama.sh                              # use sidecar's saved master
#   ./verify-host-ollama.sh --master-url http://1.2.3.4:3000
#   ./verify-host-ollama.sh --skip-idle                  # skip the 5-min idle test
#   ./verify-host-ollama.sh --role completion            # default: embedding
#   ./verify-host-ollama.sh --verbose
#
# Constraints (don't break these):
#   - POSIX-bash, no python3/git/gcc/make calls (xcode-select dialog trap on macOS).
#   - JSON parsing via sed -nE tolerating pretty-printed input.
#   - shasum/jq optional; we never depend on them.
set -euo pipefail

# ---------- args ----------
MASTER_URL=""
SKIP_IDLE=0
ROLE="embedding"
VERBOSE=0
SIDECAR_URL="${SIDECAR_URL:-http://localhost:8098}"

while [ $# -gt 0 ]; do
  case "$1" in
    --master-url) MASTER_URL="${2:-}"; shift 2 ;;
    --skip-idle) SKIP_IDLE=1; shift ;;
    --role) ROLE="${2:-embedding}"; shift 2 ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --sidecar-url) SIDECAR_URL="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------- output helpers ----------
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'
  C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YEL=""; C_DIM=""; C_RST=""
fi

TOTAL=10
STEP=0
FAILURES=()   # array of "N|title|fix"
WARNINGS=()

bump() { STEP=$((STEP+1)); }
tag() { printf "[%d/%d]" "$STEP" "$TOTAL"; }
pass() { printf "%s %s✓%s %s\n" "$(tag)" "$C_GREEN" "$C_RST" "$1"; }
fail() {
  printf "%s %s✗%s %s — %s%s%s\n" "$(tag)" "$C_RED" "$C_RST" "$1" "$C_DIM" "$2" "$C_RST"
  FAILURES+=("$STEP|$1|$3")
}
warn() {
  printf "%s %s⚠%s %s — %s%s%s\n" "$(tag)" "$C_YEL" "$C_RST" "$1" "$C_DIM" "$2" "$C_RST"
  WARNINGS+=("$STEP|$1|$2")
}
debug() { [ "$VERBOSE" = "1" ] && printf "    %s%s%s\n" "$C_DIM" "$1" "$C_RST" >&2 || true; }

# ---------- tooling guards ----------
need_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "${C_RED}FATAL${C_RST}: curl not installed."
    echo "  macOS:  preinstalled — if missing, run \`brew install curl\`"
    echo "  Linux:  apt-get install curl  /  yum install curl"
    exit 2
  fi
}
need_curl

HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1

# ---------- JSON parsing (sed-based, jq fallback) ----------
# Extract a string field. Path may be dotted: "agent.version", "hostOllama.lastHealth.ok"
# Falls back to sed -nE for pretty-printed JSON. Last-key wins (good enough for the
# flat-ish sidecar status object; we add scope hints for nested fields by passing
# the parent name).
json_str() {
  local path="$1"; local body="$2"
  if [ "$HAS_JQ" = "1" ]; then
    printf '%s' "$body" | jq -r ".${path} // empty" 2>/dev/null
    return 0
  fi
  # Sed fallback — looks up the leaf key only. For nested fields we accept that
  # a same-named key elsewhere could collide; the sidecar status doesn't have
  # ambiguous duplicates among the keys we read (version, os, enabled, ok, error).
  local leaf="${path##*.}"
  printf '%s' "$body" \
    | tr -d '\n' \
    | sed -nE "s/.*\"${leaf}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" \
    | head -1
}

# Boolean / number leaf (no quotes).
json_raw() {
  local path="$1"; local body="$2"
  if [ "$HAS_JQ" = "1" ]; then
    printf '%s' "$body" | jq -r ".${path} // empty" 2>/dev/null
    return 0
  fi
  local leaf="${path##*.}"
  printf '%s' "$body" \
    | tr -d '\n' \
    | sed -nE "s/.*\"${leaf}\"[[:space:]]*:[[:space:]]*(true|false|-?[0-9]+(\.[0-9]+)?).*/\1/p" \
    | head -1
}

# Grab a sub-object as text, scoped under a parent key (so we can look up nested
# leaves without colliding with other identically named keys). Returns the
# substring of the JSON from "<parent>": { ... } balanced to the closing brace.
json_obj() {
  local parent="$1"; local body="$2"
  printf '%s' "$body" | awk -v P="$parent" '
    BEGIN{ inp=0; depth=0; out="" }
    {
      line=$0
      while (length(line) > 0) {
        if (!inp) {
          k = index(line, "\"" P "\"")
          if (k == 0) { line=""; continue }
          line = substr(line, k)
          b = index(line, "{")
          if (b == 0) { line=""; continue }
          line = substr(line, b)
          inp=1
        }
        if (inp) {
          for (i=1; i<=length(line); i++) {
            c = substr(line, i, 1)
            out = out c
            if (c == "{") depth++
            else if (c == "}") { depth--; if (depth == 0) { print out; exit } }
          }
          line=""
        }
      }
    }
  '
}

# ---------- step 1: sidecar reachable ----------
bump
STATUS=""
HTTP_CODE=$(curl -fsS -m 5 -o /tmp/.verify-status.$$ -w "%{http_code}" "$SIDECAR_URL/api/status" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  STATUS=$(cat /tmp/.verify-status.$$)
  pass "Sidecar reachable (status=200 at $SIDECAR_URL)"
else
  fail "Sidecar reachable" "HTTP $HTTP_CODE at $SIDECAR_URL/api/status" \
    "Is the sidecar container running? Try: docker ps | grep ss-sidecar"
  STATUS=""
fi
rm -f /tmp/.verify-status.$$

# Bail early if we can't talk to the sidecar — every other check depends on it.
if [ -z "$STATUS" ]; then
  STEP=$TOTAL
  echo ""
  echo "${C_RED}Aborting:${C_RST} cannot reach sidecar. Remaining checks skipped."
  echo ""
  echo "Failures:"
  echo "  1. Sidecar reachable — Is the sidecar container running? Try: docker ps | grep ss-sidecar"
  exit 1
fi

# ---------- step 2: sidecar version ----------
bump
AGENT_OBJ=$(json_obj agent "$STATUS")
SIDECAR_VER=$(json_str version "$AGENT_OBJ")
[ -z "$SIDECAR_VER" ] && SIDECAR_VER=$(json_str "agent.version" "$STATUS")

# Determine master URL — prefer flag, else first master from status.
if [ -z "$MASTER_URL" ]; then
  MASTER_URL=$(json_str serverUrl "$STATUS")
fi

LATEST_VER=""
if [ -n "$MASTER_URL" ]; then
  MAN_BODY=$(curl -fsS -m 5 "$MASTER_URL/sideCar/builds/manifest.json" 2>/dev/null || true)
  if [ -n "$MAN_BODY" ]; then
    LATEST_VER=$(json_str version "$MAN_BODY")
  fi
fi

if [ -z "$SIDECAR_VER" ]; then
  fail "Sidecar version" "could not parse agent.version" \
    "Check the sidecar logs: docker logs ss-sidecar --tail 50"
elif [ -z "$LATEST_VER" ]; then
  warn "Sidecar version" "v$SIDECAR_VER (master manifest unreachable — can't compare)" \
    "pass --master-url <URL> to compare versions"
else
  if [ "$SIDECAR_VER" = "$LATEST_VER" ]; then
    pass "Sidecar version (v$SIDECAR_VER matches master manifest)"
  else
    warn "Sidecar version" "v$SIDECAR_VER installed, v$LATEST_VER available from $MASTER_URL" \
      "Restart container to pull the latest build, or re-run install.sh"
  fi
fi

# ---------- step 3: host OS detected ----------
bump
HOST_OBJ=$(json_obj host "$STATUS")
HOST_OS=$(json_str os "$HOST_OBJ")
HOST_OS_CONF=$(json_str osConfidence "$HOST_OBJ")
if [ -z "$HOST_OS" ]; then
  fail "Host OS detected" "host.os missing from status" \
    "Old sidecar build. Upgrade to v2.2.73+."
elif [ "$HOST_OS" = "darwin" ] || [ "$HOST_OS" = "win32" ]; then
  pass "Host OS detected ($HOST_OS, confidence=$HOST_OS_CONF)"
else
  warn "Host OS detected" "$HOST_OS (host-Ollama is intended for darwin/win32; Linux usually uses native containers)" \
    "If on Linux, host-Ollama mode is unusual — verify it's what you want."
fi

# ---------- step 4: host-Ollama mode enabled ----------
bump
HO_OBJ=$(json_obj hostOllama "$STATUS")
HO_ENABLED=$(json_raw enabled "$HO_OBJ")
if [ "$HO_ENABLED" = "true" ]; then
  pass "Host-Ollama mode enabled"
else
  fail "Host-Ollama mode enabled" "hostOllama.enabled=$HO_ENABLED" \
    "Set SS_HOST_OLLAMA=1 and SS_HOST_OLLAMA_ROLES=embedding,completion,ocr in the sidecar env; restart the container."
fi

# ---------- step 5: host-Ollama reachability from inside container ----------
bump
LH_OBJ=$(json_obj lastHealth "$HO_OBJ")
[ -z "$LH_OBJ" ] && LH_OBJ=$(json_obj lastHealth "$STATUS")
LH_OK=$(json_raw ok "$LH_OBJ")
LH_ERR=$(json_str error "$LH_OBJ")
LH_LAT=$(json_raw latencyMs "$LH_OBJ")
if [ "$LH_OK" = "true" ]; then
  pass "Sidecar→host Ollama health probe OK (${LH_LAT:-?}ms)"
else
  case "$LH_ERR" in
    ollama_not_running)
      FIX="Run \`brew services start ollama\` on the host (or \`ollama serve\` in a terminal)." ;;
    dns)
      FIX="host.docker.internal doesn't resolve. On Linux Docker, add \`--add-host host.docker.internal:host-gateway\`. On Docker Desktop, restart Docker." ;;
    network)
      FIX="Set OLLAMA_HOST=0.0.0.0:11434 system-wide, restart Ollama (\`brew services restart ollama\`), then re-test." ;;
    "")
      FIX="lastHealth not yet populated; wait 10s and rerun." ;;
    *)
      FIX="Unrecognized classifier '$LH_ERR'. Check sidecar logs: docker logs ss-sidecar --tail 100" ;;
  esac
  fail "Sidecar→host Ollama health probe" "ok=false error=$LH_ERR" "$FIX"
fi

# ---------- step 6: direct host-side check ----------
bump
HOST_VER_BODY=$(curl -fsS -m 5 http://localhost:11434/api/version 2>/dev/null || true)
if [ -n "$HOST_VER_BODY" ]; then
  OLLAMA_VER=$(json_str version "$HOST_VER_BODY")
  pass "Native Ollama responds on host (version=${OLLAMA_VER:-unknown})"
else
  fail "Native Ollama on host" "curl http://localhost:11434/api/version failed" \
    "Install Ollama: \`brew install ollama\` then \`brew services start ollama\`. Ensure OLLAMA_HOST=0.0.0.0:11434 is set."
fi

# ---------- step 7: trigger a model pull via the sidecar ----------
bump
PULL_OK=0
PULL_ERR=""
if [ "$LH_OK" != "true" ]; then
  warn "Model pull via sidecar" "skipped (host-Ollama not healthy)" "fix step 5 first"
else
  debug "POST $SIDECAR_URL/api/start role=$ROLE"
  START_RESP=$(curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/start" 2>&1 || true)
  debug "start response: $START_RESP"

  # Poll status.tasks for a model-pull or model-load matching this role.
  # 5-minute deadline (300s); poll every 3s.
  DEADLINE=$(( $(date +%s) + 300 ))
  LAST_PROGRESS=""
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    SBODY=$(curl -fsS -m 5 "$SIDECAR_URL/api/status" 2>/dev/null || true)
    # Find pull/load tasks. We can't easily extract structured arrays without
    # jq, so use simple regex over the flattened tasks blob.
    TASKS_BLOB=$(printf '%s' "$SBODY" | tr -d '\n')
    # Pull progress (latest task line)
    PROG=$(printf '%s' "$TASKS_BLOB" \
      | sed -nE 's/.*"type":"model-pull"[^}]*"role":"'"$ROLE"'"[^}]*"progress":([0-9]+).*/\1/p' \
      | tail -1)
    STAT=$(printf '%s' "$TASKS_BLOB" \
      | sed -nE 's/.*"type":"model-(pull|load)"[^}]*"role":"'"$ROLE"'"[^}]*"status":"([a-z]+)".*/\2/p' \
      | tail -1)
    ERR=$(printf '%s' "$TASKS_BLOB" \
      | sed -nE 's/.*"type":"model-(pull|load)"[^}]*"role":"'"$ROLE"'"[^}]*"error":"([^"]+)".*/\2/p' \
      | tail -1)

    if [ -n "$PROG" ] && [ "$PROG" != "$LAST_PROGRESS" ]; then
      debug "pull progress: ${PROG}%"
      LAST_PROGRESS="$PROG"
    fi

    if [ "$STAT" = "completed" ]; then
      PULL_OK=1; break
    fi
    if [ "$STAT" = "failed" ]; then
      PULL_ERR="$ERR"; break
    fi

    # Also accept the case where /api/start returned synchronously with running=true
    # (model already pulled+loaded) and no task is created.
    if [ -z "$STAT" ]; then
      # If host Ollama already has the model loaded for this role, we're done.
      PS_BODY=$(curl -fsS -m 5 http://localhost:11434/api/ps 2>/dev/null || true)
      if printf '%s' "$PS_BODY" | grep -q '"name"'; then
        PULL_OK=1; break
      fi
    fi
    sleep 3
  done

  if [ "$PULL_OK" = "1" ]; then
    pass "Model pull/load via sidecar succeeded (role=$ROLE)"
  else
    fail "Model pull via sidecar" "no completed task within 5 min${PULL_ERR:+: $PULL_ERR}" \
      "Check sidecar logs: docker logs ss-sidecar --tail 200. Verify role mapping in SS_HOST_OLLAMA_ROLES."
  fi
fi

# ---------- step 8: confirm model loaded into VRAM ----------
bump
PS_BODY=$(curl -fsS -m 5 http://localhost:11434/api/ps 2>/dev/null || true)
if [ -z "$PS_BODY" ]; then
  fail "Model loaded into VRAM" "curl http://localhost:11434/api/ps failed" \
    "Same as step 6 — ensure native Ollama is up."
else
  # Look for any model with non-empty name. Then check size_vram.
  HAS_MODEL=0
  printf '%s' "$PS_BODY" | grep -q '"name"' && HAS_MODEL=1
  if [ "$HAS_MODEL" = "0" ]; then
    fail "Model loaded into VRAM" "/api/ps returned no models" \
      "Pull step may have completed but the model wasn't kept loaded. Re-run with --role $ROLE."
  else
    VRAM_LINE=$(printf '%s' "$PS_BODY" | tr -d '\n' \
      | sed -nE 's/.*"size_vram":([0-9]+).*/\1/p' | head -1)
    SIZE_LINE=$(printf '%s' "$PS_BODY" | tr -d '\n' \
      | sed -nE 's/.*"size":([0-9]+).*/\1/p' | head -1)
    NAME=$(printf '%s' "$PS_BODY" | tr -d '\n' \
      | sed -nE 's/.*"name":"([^"]+)".*/\1/p' | head -1)
    if [ -n "$VRAM_LINE" ] && [ "$VRAM_LINE" -gt 0 ] 2>/dev/null; then
      pass "Model loaded into VRAM ($NAME, size_vram=$VRAM_LINE)"
    elif [ -n "$SIZE_LINE" ] && [ "$SIZE_LINE" -gt 0 ] 2>/dev/null; then
      warn "Model loaded into VRAM" "$NAME loaded but size_vram=0 (CPU fallback?)" \
        "Metal may not be active. Check Ollama logs: \`tail -f ~/.ollama/logs/server.log\`"
    else
      warn "Model loaded into VRAM" "could not parse size_vram from /api/ps" \
        "Manual check: curl http://localhost:11434/api/ps | jq"
    fi
  fi
fi

# ---------- step 9: real embedding via master ----------
bump
if [ -z "$MASTER_URL" ]; then
  warn "End-to-end embedding via master" "skipped (no master URL known)" \
    "pass --master-url <URL> to enable"
elif [ "$ROLE" != "embedding" ]; then
  warn "End-to-end embedding via master" "skipped (role=$ROLE, not embedding)" \
    "rerun with --role embedding to test this path"
else
  # The master exposes /api/embeddings (see src/app/api/). POST { texts: [...] }.
  EMB_RESP=$(curl -fsS -m 30 -X POST -H 'content-type: application/json' \
    -d '{"texts":["Sound Suite host-Ollama verification probe."]}' \
    "$MASTER_URL/api/embeddings" 2>&1 || true)
  if printf '%s' "$EMB_RESP" | grep -q '"embedding'; then
    DIM=$(printf '%s' "$EMB_RESP" | tr -d '\n ' \
      | sed -nE 's/.*"embedding"?s?":?\[+([^][]+)\].*/\1/p' | head -1 \
      | tr ',' '\n' | grep -c '.')
    if [ -n "$DIM" ] && [ "$DIM" -ge 768 ] 2>/dev/null; then
      pass "Master returned embedding (dim=$DIM)"
    elif [ -n "$DIM" ] && [ "$DIM" -gt 0 ] 2>/dev/null; then
      warn "Master returned embedding" "dim=$DIM (<768)" \
        "Model may not be qwen3-embedding (4096). Check master's embedding-provider config."
    else
      warn "Master embedding response unparseable" "$(printf '%s' "$EMB_RESP" | head -c 200)" \
        "Manually verify $MASTER_URL/api/embeddings"
    fi
  else
    fail "End-to-end embedding via master" "no embedding field in response" \
      "Master /api/embeddings call failed. Body: $(printf '%s' "$EMB_RESP" | head -c 200)"
  fi
fi

# ---------- step 10: idle eviction ----------
bump
if [ "$SKIP_IDLE" = "1" ]; then
  warn "Idle eviction" "skipped (--skip-idle)" \
    "rerun without --skip-idle to verify keep_alive:0 fires"
else
  # Pull idle timeout from status. rerankIdleTimeoutMin lives under idleTimeouts.
  IDLE_OBJ=$(json_obj idleTimeouts "$STATUS")
  IDLE_MIN=$(json_raw "${ROLE}IdleTimeoutMin" "$IDLE_OBJ")
  [ -z "$IDLE_MIN" ] && IDLE_MIN=$(json_raw rerankIdleTimeoutMin "$IDLE_OBJ")
  [ -z "$IDLE_MIN" ] && IDLE_MIN=4
  WAIT_S=$(( (IDLE_MIN + 1) * 60 ))
  echo "    ${C_DIM}waiting ${WAIT_S}s (idle=${IDLE_MIN}m + 1m) for eviction...${C_RST}"
  # Release any active claim first so the idle timer can run.
  curl -fsS -m 5 -X POST -H 'content-type: application/json' \
    -d "{\"role\":\"$ROLE\"}" "$SIDECAR_URL/api/release" >/dev/null 2>&1 || true

  ELAPSED=0
  while [ "$ELAPSED" -lt "$WAIT_S" ]; do
    sleep 30
    ELAPSED=$((ELAPSED + 30))
    debug "idle wait: ${ELAPSED}s / ${WAIT_S}s"
  done

  PS_AFTER=$(curl -fsS -m 5 http://localhost:11434/api/ps 2>/dev/null || true)
  # Either the model is gone, or its expires_at is in the past.
  if ! printf '%s' "$PS_AFTER" | grep -q '"name"'; then
    pass "Idle eviction confirmed (model no longer in /api/ps)"
  else
    EXPIRES=$(printf '%s' "$PS_AFTER" | tr -d '\n' \
      | sed -nE 's/.*"expires_at":"([^"]+)".*/\1/p' | head -1)
    if [ -n "$EXPIRES" ]; then
      # Compare epoch. macOS BSD date and GNU date both accept ISO 8601 via -d/-j.
      EPOCH_NOW=$(date +%s)
      EPOCH_EXP=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${EXPIRES%%.*}" +%s 2>/dev/null \
                  || date -d "$EXPIRES" +%s 2>/dev/null || echo "")
      if [ -n "$EPOCH_EXP" ] && [ "$EPOCH_EXP" -le "$EPOCH_NOW" ]; then
        pass "Idle eviction confirmed (expires_at=$EXPIRES is in the past)"
      else
        fail "Idle eviction" "model still loaded after ${WAIT_S}s, expires_at=$EXPIRES" \
          "keep_alive:0 not firing. Check sidecar logs for the idle timer."
      fi
    else
      fail "Idle eviction" "model still loaded after ${WAIT_S}s" \
        "Sidecar isn't calling keep_alive:0. Check idleTimeouts in status and sidecar logs."
    fi
  fi
fi

# ---------- summary ----------
echo ""
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "${C_GREEN}All checks passed.${C_RST}"
  if [ "${#WARNINGS[@]}" -gt 0 ]; then
    echo ""
    echo "Warnings (non-fatal):"
    for w in "${WARNINGS[@]}"; do
      n="${w%%|*}"; rest="${w#*|}"
      title="${rest%%|*}"; detail="${rest#*|}"
      printf "  %s. %s — %s\n" "$n" "$title" "$detail"
    done
  fi
  exit 0
else
  echo "${C_RED}Failures (${#FAILURES[@]}):${C_RST}"
  for f in "${FAILURES[@]}"; do
    n="${f%%|*}"; rest="${f#*|}"
    title="${rest%%|*}"; fix="${rest#*|}"
    printf "  %s. %s\n     fix: %s\n" "$n" "$title" "$fix"
  done
  exit 1
fi
