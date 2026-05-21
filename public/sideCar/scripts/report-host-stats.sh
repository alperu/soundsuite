#!/usr/bin/env bash
# report-host-stats.sh — macOS host-stats helper for Sound Suite sidecar.
#
# WHY: Docker Desktop on macOS runs the sidecar in a Linux VM; from inside
# that VM we can't read true macOS RAM/pressure (the container's /proc and
# `free` only see VM memory, not host memory). This tiny poller runs on the
# Mac itself, reads sysctl/vm_stat/memory_pressure, and POSTs the result to
# the sidecar's /api/host-stats endpoint every ~10s.
#
# USAGE:
#   ./report-host-stats.sh                                  # defaults: localhost:8098, 10s
#   SIDECAR_URL=http://localhost:8098 INTERVAL=15 ./report-host-stats.sh
#   ./report-host-stats.sh --sidecar http://localhost:8098 --interval 10
#
# DEPENDENCIES: bash, curl, sysctl, vm_stat, memory_pressure — all stock on
# macOS. No Xcode CLT prompts, no Homebrew. No python/git/gcc.
#
# INSTALL: see public/docs/install-sidecar.md (macOS section).

set -u

SIDECAR_URL="${SIDECAR_URL:-http://localhost:8098}"
INTERVAL="${INTERVAL:-10}"
SOURCE_TAG="macos-launchd@1.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --sidecar) SIDECAR_URL="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help)
      sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Verify required tools — guarded so a missing one doesn't trigger the
# Xcode-CLT install dialog. (These are all stock on macOS, but be safe.)
for tool in sysctl vm_stat memory_pressure curl awk; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[report-host-stats] missing required tool: $tool" >&2
    exit 1
  fi
done

# Try to read the GPU name once (cheap; system_profiler is slow so we cache).
GPU_NAME=""
if command -v system_profiler >/dev/null 2>&1; then
  GPU_NAME="$(system_profiler SPDisplaysDataType 2>/dev/null \
    | awk -F': ' '/Chipset Model/ {print $2; exit}' \
    | tr -d '\n' || true)"
fi

sample_and_post() {
  # Total RAM (bytes) → MB
  local total_bytes total_mb
  total_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  total_mb=$((total_bytes / 1048576))

  # Free pages from vm_stat — note: "Pages free" reports pages of 4096 bytes
  # on every Mac (vm_stat's "page size of N bytes" preamble confirms).
  local free_pages free_mb
  free_pages="$(vm_stat 2>/dev/null | awk '/Pages free/ {gsub(/\./, "", $3); print $3; exit}')"
  free_pages="${free_pages:-0}"
  free_mb=$(( free_pages * 4096 / 1048576 ))

  # Memory pressure 0..100 from `memory_pressure`. Format varies by macOS
  # version; grab the first percentage we see. Falls back to 0.
  local pressure
  pressure="$(memory_pressure 2>/dev/null \
    | awk '/percentage|free memory|free percentage/ {
        for (i=1;i<=NF;i++) if ($i ~ /[0-9]+%/) { gsub("%","",$i); print $i; exit }
      }')"
  pressure="${pressure:-0}"
  # `memory_pressure` reports FREE percentage. Convert to pressure (used).
  pressure=$(( 100 - pressure ))
  if [ "$pressure" -lt 0 ]; then pressure=0; fi
  if [ "$pressure" -gt 100 ]; then pressure=100; fi

  local cores
  cores="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 0)"
  local cpu_model
  cpu_model="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"

  local at_ms
  at_ms="$(($(date +%s) * 1000))"

  # Build JSON. Keep keys aligned with the structured HostStats schema in
  # sideCar/src/lib/state.ts so Windows + Mac payloads converge.
  local body
  body=$(cat <<JSON
{
  "at": ${at_ms},
  "source": "${SOURCE_TAG}",
  "agent": "report-host-stats.sh@1.0",
  "os": "darwin",
  "cpu": { "cores": ${cores}, "model": "$(echo "${cpu_model}" | sed 's/"/\\"/g')" },
  "memory": {
    "totalBytes": ${total_bytes},
    "freeBytes": $((free_pages * 4096)),
    "usedBytes": $((total_bytes - free_pages * 4096))
  },
  "hasNvidia": false,
  "mac": {
    "memoryPressurePct": ${pressure},
    "gpuName": "$(echo "${GPU_NAME}" | sed 's/"/\\"/g')"
  },
  "totalMb": ${total_mb},
  "freeMb": ${free_mb},
  "pressurePct": ${pressure},
  "gpuName": "$(echo "${GPU_NAME}" | sed 's/"/\\"/g')"
}
JSON
)

  # 3s timeout — the sidecar is on the same machine; anything slower is broken.
  curl -fsS --max-time 3 \
    -X POST "${SIDECAR_URL}/api/host-stats" \
    -H 'content-type: application/json' \
    --data "${body}" >/dev/null 2>&1 || true
}

if [ "${ONCE:-0}" = "1" ]; then
  sample_and_post
  exit 0
fi

# Loop forever. launchd / systemd restart us on crash; an inner trap keeps
# us going on transient curl/sidecar errors.
while true; do
  sample_and_post
  sleep "${INTERVAL}"
done
