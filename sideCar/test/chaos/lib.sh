#!/usr/bin/env bash
# Shared helpers for chaos tests. Source this from each NN-*.sh script.
#
# Environment (with defaults):
#   SIDECAR_URL    http://localhost:8098
#   OLLAMA_HOST    http://localhost:11434
#   MODEL          qwen3-embedding:0.6b
#   EMBED_ROLE     embedding
#   COMPLETION_ROLE completion
#
# Tools required: bash, curl. jq optional; if absent we fall back to sed.

: "${SIDECAR_URL:=http://localhost:8098}"
: "${OLLAMA_HOST:=http://localhost:11434}"
: "${MODEL:=qwen3-embedding:0.6b}"
: "${EMBED_ROLE:=embedding}"
: "${COMPLETION_ROLE:=completion}"

export SIDECAR_URL OLLAMA_HOST MODEL EMBED_ROLE COMPLETION_ROLE

# ---- color output ----------------------------------------------------------

if [ -t 1 ]; then
  _C_RED=$'\033[31m'; _C_GRN=$'\033[32m'; _C_YEL=$'\033[33m'
  _C_BLU=$'\033[34m'; _C_DIM=$'\033[2m'; _C_RST=$'\033[0m'
else
  _C_RED=""; _C_GRN=""; _C_YEL=""; _C_BLU=""; _C_DIM=""; _C_RST=""
fi

green()  { printf "%s%s%s\n" "$_C_GRN" "$*" "$_C_RST"; }
red()    { printf "%s%s%s\n" "$_C_RED" "$*" "$_C_RST"; }
yellow() { printf "%s%s%s\n" "$_C_YEL" "$*" "$_C_RST"; }
blue()   { printf "%s%s%s\n" "$_C_BLU" "$*" "$_C_RST"; }
dim()    { printf "%s%s%s\n" "$_C_DIM" "$*" "$_C_RST"; }

PASS_MARK="✓"
FAIL_MARK="✗"

# Test framework: counts pass/fail within a single test file.
_PASS=0
_FAIL=0

pass() { _PASS=$((_PASS+1)); green "  $PASS_MARK $*"; }
fail() { _FAIL=$((_FAIL+1)); red   "  $FAIL_MARK $*"; }

assert_eq() {
  # assert_eq EXPECTED ACTUAL MESSAGE
  local expected="$1" actual="$2" msg="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$msg (got '$actual')"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_true() {
  # assert_true CONDITION_CMD MESSAGE
  if eval "$1" >/dev/null 2>&1; then
    pass "$2"
  else
    fail "$2"
  fi
}

# Print summary line and exit appropriately. Call at end of each test file.
finish_test() {
  local name="${1:-test}"
  if [ "$_FAIL" -eq 0 ]; then
    green "RESULT: $name — $_PASS checks passed"
    exit 0
  else
    red   "RESULT: $name — $_FAIL FAILED ($_PASS passed)"
    exit 1
  fi
}

# ---- HTTP helpers ----------------------------------------------------------

# curl with sane defaults: silent, short timeout, no proxy.
ccurl() {
  curl -sS --max-time 8 --noproxy '*' "$@"
}

# GET /api/status — print JSON. Caller pipes to jq/sed.
status_json() {
  ccurl "$SIDECAR_URL/api/status" || true
}

# Extract a JSON value at a dotted path. Uses jq if present, else node, else
# crude sed (only handles simple key=string|bool|number at any nesting depth).
json_get() {
  # json_get JSON_STRING DOTTED_PATH
  local data="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$data" | jq -r "$path" 2>/dev/null
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e "
      const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const p = process.argv[1].replace(/^\\./,'').split('.');
      let v = d; for (const k of p) { if (v == null) break; v = v[k]; }
      if (v === undefined || v === null) process.stdout.write('null');
      else if (typeof v === 'object') process.stdout.write(JSON.stringify(v));
      else process.stdout.write(String(v));
    " "$path" <<<"$data" 2>/dev/null
    return
  fi
  # Last-resort fallback: tail key name.
  local key
  key=$(printf '%s' "$path" | awk -F. '{print $NF}')
  printf '%s' "$data" | sed -nE "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"?([^,\"}]+)\"?.*/\1/p" | head -1
}

# Poll a command until it exits 0 or timeout (in seconds) elapses.
# wait_for "test command" TIMEOUT_S MESSAGE
wait_for() {
  local cmd="$1" timeout="$2" msg="$3"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if eval "$cmd" >/dev/null 2>&1; then
      pass "$msg (after ${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed+1))
  done
  fail "$msg (timeout after ${timeout}s)"
  return 1
}

# wait_for_status_path PATH EXPECTED_VALUE TIMEOUT MESSAGE
# Polls /api/status until json_get(path) == expected.
wait_for_status_path() {
  local path="$1" expected="$2" timeout="$3" msg="$4"
  local elapsed=0 actual=""
  while [ "$elapsed" -lt "$timeout" ]; do
    actual=$(json_get "$(status_json)" "$path")
    if [ "$actual" = "$expected" ]; then
      pass "$msg (after ${elapsed}s; $path=$actual)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed+1))
  done
  fail "$msg (timeout after ${timeout}s; last $path=$actual, expected $expected)"
  return 1
}

# ---- Ollama service control ------------------------------------------------

# Detect platform once.
_uname=$(uname -s 2>/dev/null || echo unknown)

ollama_pid_alive() {
  pgrep -f "ollama serve" >/dev/null 2>&1 \
    || pgrep -x "ollama" >/dev/null 2>&1
}

ollama_reachable() {
  ccurl -o /dev/null -w '%{http_code}' "$OLLAMA_HOST/api/tags" 2>/dev/null | grep -q '^200$'
}

start_ollama() {
  case "$_uname" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew services start ollama >/dev/null 2>&1 || true
      fi
      # Also try the GUI app if brew didn't take.
      if ! ollama_pid_alive; then
        if command -v ollama >/dev/null 2>&1; then
          (nohup ollama serve >/tmp/ollama-chaos.log 2>&1 &) || true
        fi
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl start ollama >/dev/null 2>&1 || systemctl --user start ollama >/dev/null 2>&1 || true
      fi
      if ! ollama_pid_alive && command -v ollama >/dev/null 2>&1; then
        (nohup ollama serve >/tmp/ollama-chaos.log 2>&1 &) || true
      fi
      ;;
  esac
  # Wait up to 20s for it to be reachable.
  local i=0
  while [ "$i" -lt 20 ]; do
    ollama_reachable && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

stop_ollama() {
  case "$_uname" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew services stop ollama >/dev/null 2>&1 || true
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl stop ollama >/dev/null 2>&1 || systemctl --user stop ollama >/dev/null 2>&1 || true
      fi
      ;;
  esac
  # Belt and suspenders.
  pkill -f "ollama serve" >/dev/null 2>&1 || true
  pkill -x "ollama" >/dev/null 2>&1 || true
  # Wait for the port to actually close.
  local i=0
  while [ "$i" -lt 10 ]; do
    ollama_reachable || return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

kill_ollama_hard() {
  # SIGKILL — simulates crash.
  pkill -9 -f "ollama serve" >/dev/null 2>&1 || true
  pkill -9 -x "ollama" >/dev/null 2>&1 || true
}

# Ensure Ollama is running before a test; idempotent.
ensure_ollama_up() {
  ollama_reachable && return 0
  start_ollama
}

# ---- Sidecar liveness ------------------------------------------------------

sidecar_reachable() {
  ccurl -o /dev/null -w '%{http_code}' "$SIDECAR_URL/api/status" 2>/dev/null | grep -q '^200$'
}

require_sidecar() {
  if ! sidecar_reachable; then
    red "Sidecar not reachable at $SIDECAR_URL — start it before running this test."
    exit 2
  fi
}

# ---- Misc utilities --------------------------------------------------------

header() {
  blue "=================================================================="
  blue " $*"
  blue "=================================================================="
}

trap_cleanup() {
  # Tests register cleanup via CLEANUP_FN; if set, run on EXIT.
  trap '[ -n "${CLEANUP_FN:-}" ] && eval "$CLEANUP_FN" || true' EXIT
}
