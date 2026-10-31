#!/usr/bin/env bash
# configure-sidecar-masters-netbird.sh
#
# Push the NetBird master URLs to every sidecar in the fleet — ADDITIVELY.
# This script NEVER deletes an existing master. It only adds the NetBird
# masters (or patches their wsPort if drifted), so a sidecar always keeps
# whatever working master it already had. If the NetBird master turns out to
# be unreachable, the sidecar still has its old master and stays connected.
#
#   - Sidecars on 192.168.88.0/24 → http://100.114.170.238:3000, :3848, + LLM spam filter
#   - Sidecars on 10.10.20.0/24    → http://100.114.170.238:3000, :3848, + LLM spam filter
#     (NetBird 100.114.170.238/16 now routes both ways, so all hosts reach it)
#   LLM spam filter (whmEmailSpam worker on BASWS41): $SPAM_MASTER_URL,
#   default http://100.114.83.26:8265. Set SPAM_MASTER_URL= (empty) to skip it.
#   QuickBooks MCP server (qbmcpserver, sidecar API port): $QBMCP_MASTER_URL,
#   default http://qbmcpserver.vpn.bas.co:3005. Set QBMCP_MASTER_URL= to skip.
#   It needs a token: $QBMCP_SIDECAR_TOKEN, or (if empty) the script reads
#   SIDECAR_AUTH_TOKEN from /srv/qbmcp/env/app.env over `ssh root@$QBMCP_SSH`
#   (default 10.10.20.41). The token is never printed.
#
# WebSocket-port mapping (derived from the URL port, not hard-coded per URL):
#   URL port 3000 → wsPort 3002   (Sound Suite)
#   URL port 3848 → wsPort 3003   (Fantom MCP server)
#   URL port 8265 → wsPort 3004   (LLM spam filter)
#   URL port 3005 → wsPort 3005   (QuickBooks MCP server: HTTP and WS share 3005)
#
# For each (sidecar, master-url) pair the script:
#   1. GETs /api/masters on the sidecar to see what's already there.
#   2. If the URL is already registered with the correct wsPort → skip.
#   3. If the URL exists but wsPort differs → PATCH it.
#   4. If the URL is missing → POST to add.
#
# It does NOT remove stale 192.168 masters. To purge masters, use the separate
# ./scripts/configure-sidecar-delete-masters.sh (destructive, opt-in).
#
# Usage:
#   ./scripts/configure-sidecar-masters-netbird.sh [--dry-run] [--fleet-url http://localhost:3000]

set -euo pipefail

FLEET_URL="${FLEET_URL:-http://localhost:3000}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --fleet-url) FLEET_URL="${1:?--fleet-url needs a value}"; shift ;;
    --fleet-url=*) FLEET_URL="${arg#*=}" ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
  esac
done

# Master URLs per subnet. wsPort is derived from URL port below.
SPAM_MASTER_URL="${SPAM_MASTER_URL-http://100.114.83.26:8265}"
MASTERS_88=(
  "http://100.114.170.238:3000"
  "http://100.114.170.238:3848"
)
MASTERS_10=(
  "http://100.114.170.238:3000"
  "http://100.114.170.238:3848"
)
if [[ -n "$SPAM_MASTER_URL" ]]; then
  MASTERS_88+=("$SPAM_MASTER_URL")
  MASTERS_10+=("$SPAM_MASTER_URL")
fi

# QuickBooks MCP server. Its sidecar API requires a bearer token.
QBMCP_MASTER_URL="${QBMCP_MASTER_URL-http://qbmcpserver.vpn.bas.co:3005}"
QBMCP_SSH="${QBMCP_SSH:-10.10.20.41}"
QBMCP_SIDECAR_TOKEN="${QBMCP_SIDECAR_TOKEN:-}"
if [[ -n "$QBMCP_MASTER_URL" ]]; then
  if [[ -z "$QBMCP_SIDECAR_TOKEN" ]]; then
    QBMCP_SIDECAR_TOKEN="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$QBMCP_SSH" \
      'sed -n "s/^SIDECAR_AUTH_TOKEN=//p" /srv/qbmcp/env/app.env' 2>/dev/null || true)"
  fi
  if [[ -z "$QBMCP_SIDECAR_TOKEN" ]]; then
    echo "WARN: no SIDECAR_AUTH_TOKEN for $QBMCP_MASTER_URL (set QBMCP_SIDECAR_TOKEN); skipping that master." >&2
  else
    MASTERS_88+=("$QBMCP_MASTER_URL")
    MASTERS_10+=("$QBMCP_MASTER_URL")
  fi
fi

# Token to send with a master, if it needs one (empty = none).
token_for() {
  if [[ -n "$QBMCP_MASTER_URL" && "$1" == "$QBMCP_MASTER_URL" ]]; then
    printf '%s' "$QBMCP_SIDECAR_TOKEN"
  fi
}

# Map URL port → expected wsPort. Add to this table if more pairs come up.
ws_port_for() {
  local url="$1"
  local port
  port="$(echo "$url" | sed -E 's#.*:([0-9]+).*#\1#')"
  case "$port" in
    3000) echo 3002 ;;
    3848) echo 3003 ;;
    8265) echo 3004 ;;
    3005) echo 3005 ;;
    *)
      # Unknown URL port — fail loudly so the operator notices.
      echo "ERROR: no wsPort mapping for URL port $port (url=$url)" >&2
      return 1
      ;;
  esac
}

command -v jq   >/dev/null || { echo "jq required"; exit 1; }
command -v curl >/dev/null || { echo "curl required"; exit 1; }

echo "Discovering sidecars at $FLEET_URL/api/admin/gpu-fleet ..."
FLEET_JSON="$(curl -s --max-time 5 "$FLEET_URL/api/admin/gpu-fleet")" || {
  echo "ERROR: cannot reach $FLEET_URL/api/admin/gpu-fleet"; exit 1;
}
SIDECARS=$(echo "$FLEET_JSON" | jq -r '.sidecars[] | [.hostname, .url] | @tsv')
if [[ -z "$SIDECARS" ]]; then
  echo "No sidecars in fleet — nothing to configure."; exit 0;
fi

printf '\n%-26s %-32s %-14s %-30s %-7s %s\n' \
  "HOSTNAME" "SIDECAR" "SUBNET" "MASTER URL" "WS" "ACTION"
printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
  "--------" "-------" "------" "----------" "--" "------"

while IFS=$'\t' read -r HOSTNAME SIDECAR_URL; do
  [[ -z "$SIDECAR_URL" ]] && continue

  HOST_IP="$(echo "$SIDECAR_URL" | sed -E 's#https?://([^:/]+).*#\1#')"

  SUBNET=""; MASTERS=()
  case "$HOST_IP" in
    192.168.88.*) SUBNET="192.168.88.x"; MASTERS=("${MASTERS_88[@]}") ;;
    10.10.20.*)   SUBNET="10.10.20.x";   MASTERS=("${MASTERS_10[@]}") ;;
    *)
      printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
        "$HOSTNAME" "$SIDECAR_URL" "(no-match)" "-" "-" "skip ip=$HOST_IP"
      continue
      ;;
  esac

  # Fetch the sidecar's current master list once per host. Never deleted here.
  EXISTING_JSON="$(curl -s --max-time 5 "$SIDECAR_URL/api/masters" || echo '{}')"

  for MASTER_URL in "${MASTERS[@]}"; do
    WS_PORT="$(ws_port_for "$MASTER_URL")" || continue

    # Look up the existing entry (if any) for this serverUrl.
    EXISTING_WS=$(echo "$EXISTING_JSON" \
      | jq -r --arg s "$MASTER_URL" \
        '.masters[]? | select(.serverUrl == $s) | (.wsPort // empty) | tostring' \
      | head -1)

    if [[ -n "$EXISTING_WS" && "$EXISTING_WS" != "null" ]]; then
      if [[ "$EXISTING_WS" == "$WS_PORT" && -z "$(token_for "$MASTER_URL")" ]]; then
        printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
          "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" "exist"
        continue
      fi
      # wsPort drift — patch it
      if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
          "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" \
          "DRY patch (was $EXISTING_WS)"
        continue
      fi
      ENCODED=$(jq -rn --arg s "$MASTER_URL" '$s|@uri')
      RESP=$(curl -s --max-time 6 \
        -X PATCH "$SIDECAR_URL/api/masters/$ENCODED" \
        -H 'Content-Type: application/json' \
        -d "$(jq -n --argjson p "$WS_PORT" --arg t "$(token_for "$MASTER_URL")" \
              '{wsPort: $p} + (if $t != "" then {authToken: $t} else {} end)')" \
        || echo '{"error":"curl-failed"}')
      ERR=$(echo "$RESP" | jq -r '.error // empty')
      if [[ -n "$ERR" ]]; then
        printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
          "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" "ERR $ERR"
      else
        printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
          "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" \
          "patched (was $EXISTING_WS)"
      fi
      continue
    fi

    # New entry — POST to add.
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
        "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" "DRY add"
      continue
    fi
    BODY=$(jq -n --arg s "$MASTER_URL" --argjson p "$WS_PORT" --arg t "$(token_for "$MASTER_URL")" \
      '{serverUrl: $s, wsPort: $p} + (if $t != "" then {authToken: $t} else {} end)')
    RESP=$(curl -s --max-time 6 \
      -X POST "$SIDECAR_URL/api/masters" \
      -H 'Content-Type: application/json' \
      -d "$BODY" || echo '{"error":"curl-failed"}')
    ERR=$(echo "$RESP" | jq -r '.error // empty')
    if [[ -n "$ERR" ]]; then
      printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
        "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" "ERR $ERR"
    else
      printf '%-26s %-32s %-14s %-30s %-7s %s\n' \
        "$HOSTNAME" "$SIDECAR_URL" "$SUBNET" "$MASTER_URL" "$WS_PORT" "added"
    fi
  done
done <<< "$SIDECARS"

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete — no changes pushed. Drop --dry-run to apply."
else
  echo "Done (additive — no masters were deleted). Verify per-sidecar with:"
  echo "  curl -s <sidecar-url>/api/masters | jq '.masters[] | {serverUrl, wsPort, connectionMode, lastHeartbeatAt}'"
  echo "To remove stale masters, use ./scripts/configure-sidecar-delete-masters.sh"
fi
