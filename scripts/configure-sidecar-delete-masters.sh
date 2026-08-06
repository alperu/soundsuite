#!/usr/bin/env bash
# configure-sidecar-delete-masters.sh
#
# DESTRUCTIVE. Deletes master URLs from every sidecar in the fleet.
#
# By default it deletes EVERY master on every sidecar — which will disconnect
# the whole fleet until masters are re-added (run configure-sidecar-masters-netbird.sh
# afterwards). Use --match to delete only masters whose serverUrl contains a
# substring, e.g. purge only the stale LAN masters:
#
#   ./scripts/configure-sidecar-delete-masters.sh --match 192.168.88.254
#
# Because this can strand the fleet, it will NOT apply unless you pass --yes
# (or --dry-run to preview). --dry-run shows exactly what would be deleted.
#
# Usage:
#   ./scripts/configure-sidecar-delete-masters.sh --dry-run
#   ./scripts/configure-sidecar-delete-masters.sh --yes                       # delete ALL masters
#   ./scripts/configure-sidecar-delete-masters.sh --yes --match 192.168.88    # delete only matching
#   [--fleet-url http://localhost:3000]

set -euo pipefail

FLEET_URL="${FLEET_URL:-http://localhost:3000}"
DRY_RUN=0
CONFIRM=0
MATCH=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) CONFIRM=1 ;;
    --match) shift; MATCH="$1" ;;
    --match=*) MATCH="${arg#*=}" ;;
    --fleet-url) shift; FLEET_URL="$1" ;;
    --fleet-url=*) FLEET_URL="${arg#*=}" ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
  esac
done

if [[ "$DRY_RUN" -eq 0 && "$CONFIRM" -eq 0 ]]; then
  echo "REFUSING to delete without confirmation." >&2
  echo "This is destructive and can disconnect the whole fleet." >&2
  echo "Re-run with --dry-run to preview, or --yes to apply." >&2
  exit 2
fi

command -v jq   >/dev/null || { echo "jq required"; exit 1; }
command -v curl >/dev/null || { echo "curl required"; exit 1; }

if [[ -n "$MATCH" ]]; then
  echo "Deleting masters matching '*$MATCH*' from sidecars at $FLEET_URL ..."
else
  echo "Deleting ALL masters from every sidecar at $FLEET_URL ..."
fi

FLEET_JSON="$(curl -s --max-time 5 "$FLEET_URL/api/admin/gpu-fleet")" || {
  echo "ERROR: cannot reach $FLEET_URL/api/admin/gpu-fleet"; exit 1;
}
SIDECARS=$(echo "$FLEET_JSON" | jq -r '.sidecars[] | [.hostname, .url] | @tsv')
if [[ -z "$SIDECARS" ]]; then
  echo "No sidecars in fleet — nothing to delete."; exit 0;
fi

printf '\n%-26s %-32s %-34s %s\n' "HOSTNAME" "SIDECAR" "MASTER URL" "ACTION"
printf '%-26s %-32s %-34s %s\n'   "--------" "-------" "----------" "------"

while IFS=$'\t' read -r HOSTNAME SIDECAR_URL; do
  [[ -z "$SIDECAR_URL" ]] && continue

  EXISTING_JSON="$(curl -s --max-time 5 "$SIDECAR_URL/api/masters" || echo '{}')"
  EXISTING_URLS=$(echo "$EXISTING_JSON" | jq -r '.masters[]? | .serverUrl // empty')

  if [[ -z "$EXISTING_URLS" ]]; then
    printf '%-26s %-32s %-34s %s\n' "$HOSTNAME" "$SIDECAR_URL" "-" "none"
    continue
  fi

  while IFS= read -r OLD_URL; do
    [[ -z "$OLD_URL" ]] && continue
    if [[ -n "$MATCH" && "$OLD_URL" != *"$MATCH"* ]]; then
      printf '%-26s %-32s %-34s %s\n' "$HOSTNAME" "$SIDECAR_URL" "$OLD_URL" "keep (no match)"
      continue
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '%-26s %-32s %-34s %s\n' "$HOSTNAME" "$SIDECAR_URL" "$OLD_URL" "DRY delete"
      continue
    fi
    ENCODED_OLD=$(jq -rn --arg s "$OLD_URL" '$s|@uri')
    RESP=$(curl -s --max-time 6 \
      -X DELETE "$SIDECAR_URL/api/masters/$ENCODED_OLD" || echo '{"error":"curl-failed"}')
    ERR=$(echo "$RESP" | jq -r '.error // empty')
    if [[ -n "$ERR" ]]; then
      printf '%-26s %-32s %-34s %s\n' "$HOSTNAME" "$SIDECAR_URL" "$OLD_URL" "ERR $ERR"
    else
      printf '%-26s %-32s %-34s %s\n' "$HOSTNAME" "$SIDECAR_URL" "$OLD_URL" "deleted"
    fi
  done <<< "$EXISTING_URLS"
done <<< "$SIDECARS"

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete — no changes pushed. Add --yes to apply."
else
  echo "Done. If you deleted all masters, re-add them with:"
  echo "  ./scripts/configure-sidecar-masters-netbird.sh"
fi
