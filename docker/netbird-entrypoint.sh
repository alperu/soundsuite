#!/usr/bin/env bash
# NetBird sidecar for Sound Suite (soundsuite-netbird). Mount read-only and use as the entrypoint of
# netbirdio/netbird:latest (see deploy/basws42/docker-compose.yml).
#
# Settings > NetBird (/dashboard/config/#netbird) writes $CTL/config.json:
#   { "setupKey", "hostname", "managementUrl", "wireguardPort", "externalIpMap", "enabled",
#     "https": {...}, "updatedAt" }   (https is read by docker/caddy-entrypoint.sh)
# This script:
#   - starts the NetBird daemon (`netbird service run`), as the image does;
#   - waits for config.json with enabled=true and a setupKey, then runs
#     `netbird up --setup-key-file ... --management-url ... --hostname ...
#      --wireguard-port ... --external-ip-map ...` (port 0 = NetBird picks a
#      free port; externalIpMap, else env NB_EXTERNAL_IP_MAP, is the public IP
#      peers should use, e.g. 99.92.186.153; empty clears it);
#   - writes `netbird status --json` to $CTL/status.json every 10 s;
#   - on a new updatedAt: `netbird down`, then up again with the new values;
#   - on enabled=false: `netbird down`;
#   - exits when the app container's network goes away (the app was
#     restarted), so Docker restarts this container in the new network (DNS).
# The setup key is never printed. NetBird state stays in /var/lib/netbird
# (a volume), so the peer survives restarts.
set -uo pipefail

CTL="${NETBIRD_CTL_DIR:-/netbird-ctl}"
CFG="$CTL/config.json"
STATUS="$CTL/status.json"
NB="${NETBIRD_BIN:-/usr/local/bin/netbird}"
INTERVAL="${NETBIRD_STATUS_INTERVAL:-10}"
export NB_LOG_FILE="${NB_LOG_FILE:-console}"

log() { printf '%s netbird-ctl: %s\n' "$(date -Isec)" "$*" >&2; }

# Read one top-level string, number or bool field from the pretty JSON the
# server writes (2-space indent; nested "https" fields have 4 and never match).
field() {
  sed -n "s/^  \"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\}[[:space:]]*,\{0,1\}[[:space:]]*\$/\1/p" "$CFG" 2>/dev/null | head -n 1
}

# externalIpMap may hold commas ("IP/IP,IP/eth0"), which field() does not allow.
# Only IPs, interface names, "/", "," are kept; anything else makes it empty.
ipmap_field() {
  local v
  v="$(sed -n 's/^  "externalIpMap"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$CFG" 2>/dev/null | head -n 1)"
  [ -z "$v" ] && v="${NB_EXTERNAL_IP_MAP:-}"
  case "$v" in *[!0-9A-Za-z./,_-]*) v="" ;; esac
  printf '%s' "$v"
}

# The shared network namespace, as seen at start. When the app container is
# restarted it gets a new namespace; this one is then dead (no DNS, no route).
netns_id() { readlink /proc/1/ns/net 2>/dev/null; cat /sys/class/net/eth0/ifindex 2>/dev/null; }
NETNS_ID="$(netns_id)"
net_alive() { [ -e /sys/class/net/eth0 ] && [ "$(netns_id)" = "$NETNS_ID" ]; }

daemon_pid=""
on_exit() {
  log "stopping"
  "$NB" down >/dev/null 2>&1 || true
  [ -n "$daemon_pid" ] && kill -TERM "$daemon_pid" 2>/dev/null && wait "$daemon_pid" 2>/dev/null
  exit "${1:-0}"
}
trap 'on_exit 0' TERM INT

mkdir -p "$CTL" /var/lib/netbird
"$NB" service run &
daemon_pid=$!
for _ in $(seq 1 30); do
  "$NB" status --check live >/dev/null 2>&1 && break
  sleep 1
done
log "daemon started; waiting for $CFG"

applied=""   # updatedAt of the config now in force
is_up=0

bring_up() {
  local key host url port ipmap keyfile
  key="$(field setupKey)"; host="$(field hostname)"; url="$(field managementUrl)"; port="$(field wireguardPort)"; ipmap="$(ipmap_field)"
  [ -z "$host" ] && host="soundsuite"
  [ -z "$url" ] && url="https://vpn.bas.co:443"
  case "$port" in ''|*[!0-9]*) port=0 ;; esac
  keyfile="$(mktemp /tmp/nbkey.XXXXXX)"
  chmod 600 "$keyfile"
  printf '%s' "$key" > "$keyfile"
  log "netbird up (hostname=$host, management=$url, wireguard-port=$port, external-ip-map=${ipmap:-none})"
  if "$NB" up --setup-key-file "$keyfile" --management-url "$url" --hostname "$host" --wireguard-port "$port" --external-ip-map "$ipmap" >/dev/null 2>&1; then
    is_up=1; log "connected"
  else
    is_up=0; log "netbird up failed; will retry"
  fi
  rm -f "$keyfile"
}

bring_down() {
  log "netbird down"
  "$NB" down >/dev/null 2>&1 || true
  is_up=0
}

while true; do
  if ! net_alive; then
    log "app network is gone (app restarted); exiting so Docker restarts this container"
    on_exit 1
  fi
  if [ -f "$CFG" ]; then
    enabled="$(field enabled)"; updated="$(field updatedAt)"; key="$(field setupKey)"
    if [ "$enabled" = "true" ] && [ -n "$key" ]; then
      if [ "$updated" != "$applied" ]; then
        # Always down first: at start the daemon reconnects from its saved
        # profile, and `up` on a live connection ignores new flags
        # (--wireguard-port, --external-ip-map).
        bring_down
        bring_up
        [ "$is_up" = 1 ] && applied="$updated"
      fi
    else
      if [ "$is_up" = 1 ] || [ -n "$applied" ]; then bring_down; fi
      applied=""
    fi
  fi
  if "$NB" status --json > "$STATUS.tmp" 2>/dev/null; then mv -f "$STATUS.tmp" "$STATUS"; else rm -f "$STATUS.tmp"; fi
  sleep "$INTERVAL" & wait $!
done
