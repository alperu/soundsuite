#!/usr/bin/env bash
# Chaos test runner for host-Ollama failure modes.
#
# Usage:
#   bash sideCar/test/chaos/run.sh                # run all
#   bash sideCar/test/chaos/run.sh 03 05          # run only 03 and 05
#   bash sideCar/test/chaos/run.sh --list         # list tests without running
#
# Prerequisites: native Ollama installed, sidecar running with
# SS_HOST_OLLAMA=1 SS_HOST_OLLAMA_ROLES=embedding,completion.
# See README.md for full setup.

set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh"

ALL_TESTS=(
  "01-ollama-down-at-boot.sh"
  "02-ollama-killed-mid-pull.sh"
  "03-ollama-killed-mid-embed.sh"
  "04-out-of-band-model-load.sh"
  "05-out-of-band-model-evict.sh"
  "06-two-roles-idle-race.sh"
  "07-flag-flip-disable.sh"
  "08-host-docker-internal-failure.sh"
)

if [ "${1:-}" = "--list" ]; then
  for t in "${ALL_TESTS[@]}"; do
    printf "  %s\n" "$t"
  done
  exit 0
fi

# Build the run set: args are zero-padded indexes (e.g. "03"); empty = all.
SELECTED=()
if [ "$#" -eq 0 ]; then
  SELECTED=("${ALL_TESTS[@]}")
else
  for arg in "$@"; do
    matched=""
    for t in "${ALL_TESTS[@]}"; do
      case "$t" in
        "$arg"-*) matched="$t"; break ;;
      esac
    done
    if [ -z "$matched" ]; then
      red "No test matches '$arg'"
      exit 2
    fi
    SELECTED+=("$matched")
  done
fi

header "Chaos harness — host-Ollama failure modes"
dim "  sidecar: $SIDECAR_URL"
dim "  ollama:  $OLLAMA_HOST"
dim "  model:   $MODEL"
dim "  tests:   ${#SELECTED[@]} of ${#ALL_TESTS[@]}"

start_total=$(date +%s)
n_pass=0
n_fail=0
FAILED_NAMES=()

for t in "${SELECTED[@]}"; do
  script="$HERE/$t"
  if [ ! -f "$script" ]; then
    red "Missing script: $script"
    n_fail=$((n_fail+1))
    FAILED_NAMES+=("$t (missing)")
    continue
  fi
  echo
  blue "------ $t ------"
  if bash "$script"; then
    n_pass=$((n_pass+1))
  else
    n_fail=$((n_fail+1))
    FAILED_NAMES+=("$t")
  fi
done

end_total=$(date +%s)
elapsed=$((end_total - start_total))

echo
header "Summary"
green "  passed:  $n_pass"
if [ "$n_fail" -eq 0 ]; then
  green "  failed:  $n_fail"
else
  red   "  failed:  $n_fail"
  for f in "${FAILED_NAMES[@]}"; do red "    - $f"; done
fi
dim   "  elapsed: ${elapsed}s"

[ "$n_fail" -eq 0 ] || exit 1
exit 0
