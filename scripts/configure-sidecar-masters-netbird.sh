#!/usr/bin/env bash
# configure-sidecar-masters-netbird.sh
#
# Push the NetBird master URLs to every sidecar in the fleet — ADDITIVELY.
# This script NEVER deletes an existing master. It only adds the NetBird
# masters (or patches their wsPort if drifted), so a sidecar always keeps
# whatever working master it already had. If the NetBird master turns out to
# be unreachable, the sidecar still has its old master and stays connected.
#
#   Masters (HTTPS through Caddy on 443, Let's Encrypt certs, NetBird names):
#   - Sound Suite on basws42: $SOUNDSUITE_B42_MASTER_URL, default https://soundsuite.vpn.bas.co
#   - Fantom MCP on basws42:  $FANTOM_MASTER_URL, default https://fantom.vpn.bas.co
#     Set either to empty to skip it.
#   Both subnets (192.168.88.0/24 and 10.10.20.0/24) get the same list.
#   The old http:// masters (http://100.114.170.238:3000/:3848,
#   http://soundsuite.vpn.bas.co:3000, http://qbmcpserver.vpn.bas.co:3005) are no
#   longer pushed, but stay on the sidecars until you remove them with
#   ./scripts/configure-sidecar-delete-masters.sh.
#   LLM spam filter (whmEmailSpam worker on BASWS41): $SPAM_MASTER_URL,
#   default http://100.114.83.26:8265. Set SPAM_MASTER_URL= (empty) to skip it.
#   QuickBooks MCP server (qbmcpserver, sidecar API port): $QBMCP_MASTER_URL,
#   default https://qbmcpserver.vpn.bas.co. Set QBMCP_MASTER_URL= to skip.
#   It needs a token: $QBMCP_SIDECAR_TOKEN, or (if empty) the script reads
#   SIDECAR_AUTH_TOKEN from /srv/qbmcp/env/app.env over `ssh root@$QBMCP_SSH`
#   (default 10.10.20.41). The token is never printed.
#
# WebSocket port. The sidecar always dials plain ws://<url-host>:<wsPort>/sidecar
# (no wss), so the WS does NOT go through Caddy on 443. An https:// URL with no
# port therefore gets its wsPort from a table keyed by HOST:
#   soundsuite.vpn.bas.co  → wsPort 3002   (Sound Suite relay)
#   fantom.vpn.bas.co      → wsPort 3003   (Fantom MCP server)
#   qbmcpserver.vpn.bas.co → wsPort 3005   (QuickBooks MCP server)
# Other URLs fall back to the URL port:
#   3000 → 3002, 3848 → 3003, 8265 → 3004 (LLM spam filter), 3005 → 3005
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
#   ./scripts/configure-sidecar-masters-netbird.sh [--dry-run] [--fleet-url https://soundsuite.vpn.bas.co]

set -euo pipefail

FLEET_URL="${FLEET_URL:-https://soundsuite.vpn.bas.co}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --fleet-url) FLEET_URL="${1:?--fleet-url needs a value}"; shift ;;
    --fleet-url=*) FLEET_URL="${arg#*=}" ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
  esac
done

# Master URLs per subnet. wsPort is derived from URL port below.
SPAM_MASTER_URL="${SPAM_MASTER_URL-http://100.114.83.26:8265}"
MASTERS_88=()
MASTERS_10=()
if [[ -n "$SPAM_MASTER_URL" ]]; then
  MASTERS_88+=("$SPAM_MASTER_URL")
  MASTERS_10+=("$SPAM_MASTER_URL")
fi

# App masters by IP (no DNS needed). Office sidecars (10.10.20.x) use the LAN
# addresses; NetBird and 192.168.88.x sidecars use the NetBird addresses.
#   Sound Suite  basws42  LAN 10.10.20.192:3000  NetBird 100.114.98.143:3000  WS 3002
#   Fantom       basws42  LAN 10.10.20.192:3848  NetBird 100.114.67.188:3848  WS 3003
#   QuickBooks   qbhub    LAN 10.10.20.41:3005   NetBird 100.114.86.52:3005   WS 3005
# Override a list with SOUNDSUITE_LAN_URL= etc.; set it empty to skip.
SOUNDSUITE_LAN_URL="${SOUNDSUITE_LAN_URL-http://10.10.20.192:3000}"
SOUNDSUITE_NB_URL="${SOUNDSUITE_NB_URL-http://100.114.98.143:3000}"
FANTOM_LAN_URL="${FANTOM_LAN_URL-http://10.10.20.192:3848}"
FANTOM_NB_URL="${FANTOM_NB_URL-http://100.114.67.188:3848}"
QBMCP_LAN_URL="${QBMCP_LAN_URL-http://10.10.20.41:3005}"
QBMCP_NB_URL="${QBMCP_NB_URL-http://100.114.86.52:3005}"
# sidecarmaster on basws42. HTTP fallback is port 3010 (NetBird IP or LAN). WS relay:
# 3002 on the NetBird IP; LAN sidecars use host port 3012 (host 3002 is Sound Suite's).
#   sidecarmaster basws42  LAN 10.10.20.192:3010 (WS 3012)  NetBird 100.114.28.154:3010 (WS 3002)
SIDECARMASTER_LAN_URL="${SIDECARMASTER_LAN_URL-http://10.10.20.192:3010}"
SIDECARMASTER_NB_URL="${SIDECARMASTER_NB_URL-http://100.114.28.154:3010}"
MASTERS_NB=("${MASTERS_88[@]}")

add_master() { # add_master <list-name> <url>
  [[ -n "$2" ]] || return 0
  eval "$1+=(\"\$2\")"
}
add_master MASTERS_10 "$SOUNDSUITE_LAN_URL"; add_master MASTERS_10 "$FANTOM_LAN_URL"
add_master MASTERS_NB "$SOUNDSUITE_NB_URL";  add_master MASTERS_NB "$FANTOM_NB_URL"
add_master MASTERS_88 "$SOUNDSUITE_NB_URL";  add_master MASTERS_88 "$FANTOM_NB_URL"
add_master MASTERS_10 "$SIDECARMASTER_LAN_URL"
add_master MASTERS_NB "$SIDECARMASTER_NB_URL"; add_master MASTERS_88 "$SIDECARMASTER_NB_URL"

# QuickBooks MCP server. Its sidecar API requires a bearer token.
QBMCP_SSH="${QBMCP_SSH:-10.10.20.41}"
QBMCP_SIDECAR_TOKEN="${QBMCP_SIDECAR_TOKEN:-}"
if [[ -n "$QBMCP_LAN_URL$QBMCP_NB_URL" ]]; then
  if [[ -z "$QBMCP_SIDECAR_TOKEN" ]]; then
    QBMCP_SIDECAR_TOKEN="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$QBMCP_SSH" \
      'sed -n "s/^SIDECAR_AUTH_TOKEN=//p" /srv/qbmcp/env/app.env' 2>/dev/null || true)"
  fi
  if [[ -z "$QBMCP_SIDECAR_TOKEN" ]]; then
    echo "WARN: no SIDECAR_AUTH_TOKEN for QuickBooks (set QBMCP_SIDECAR_TOKEN); skipping that master." >&2
  else
    add_master MASTERS_10 "$QBMCP_LAN_URL"
    add_master MASTERS_NB "$QBMCP_NB_URL"
    add_master MASTERS_88 "$QBMCP_NB_URL"
  fi
fi

# Token to send with a master, if it needs one (empty = none).
token_for() {
  if [[ ( -n "$QBMCP_LAN_URL" && "$1" == "$QBMCP_LAN_URL" ) || ( -n "$QBMCP_NB_URL" && "$1" == "$QBMCP_NB_URL" ) || "$1" == *qbmcpserver* ]]; then
    printf '%s' "$QBMCP_SIDECAR_TOKEN"
  fi
}

# Map master URL → expected wsPort: by host first (https URLs carry no port),
# then by URL port. Add to these tables if more masters come up.
ws_port_for() {
  local url="$1"
  local host port
  host="$(echo "$url" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')"
  case "$host" in
    soundsuite.vpn.bas.co)  echo 3002; return 0 ;;
    fantom.vpn.bas.co)      echo 3003; return 0 ;;
    qbmcpserver.vpn.bas.co) echo 3005; return 0 ;;
  esac
  port="$(echo "$url" | sed -nE 's#^[a-z]+://[^/]*:([0-9]+).*#\1#p')"
  # Same URL port, different wsPort per address (sidecarmaster).
  case "$host:$port" in
    10.10.20.192:3010)   echo 3012; return 0 ;;
    100.114.28.154:3010) echo 3002; return 0 ;;
  esac
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
# Known sidecars, added even when the fleet does not list them (a sidecar that
# cannot reach the master never registers there). Space-separated name=url.
KNOWN_SIDECARS="${KNOWN_SIDECARS-BASWS34=http://10.10.20.6:8098 BASWS41=http://basws41.vpn.bas.co:8098 BASWS35=http://10.10.20.134:8098 Alpers-Mac-mini.local=http://100.114.220.200:8098 mcpserver.local=http://100.114.192.119:8098}"
for kv in $KNOWN_SIDECARS; do
  k_name="${kv%%=*}"; k_url="${kv#*=}"
  printf '%s\n' "$SIDECARS" | grep -qF "$k_url" || SIDECARS="${SIDECARS:+$SIDECARS$'\n'}${k_name}"$'\t'"${k_url}"
done
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
    *.vpn.bas.co) SUBNET="netbird";      MASTERS=("${MASTERS_NB[@]}") ;;
    192.168.88.*) SUBNET="192.168.88.x"; MASTERS=("${MASTERS_88[@]}") ;;
    10.10.20.*)   SUBNET="10.10.20.x";   MASTERS=("${MASTERS_10[@]}") ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
                  SUBNET="netbird";      MASTERS=("${MASTERS_NB[@]}") ;;
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
