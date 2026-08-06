#!/bin/bash
###############################################################################
# svc-ctl.sh — control the SoundSuite dashboard as a launchd user agent.
#
# Why launchd: the dashboard used to be a backgrounded child of whatever shell
# (or OliveTin action) launched it, so it died on SIGHUP when that parent went
# away — terminal close, `Restart` action timeout-SIGKILL, logout. Under launchd
# the server's lifecycle is owned by launchd (KeepAlive = auto-restart on crash,
# RunAtLoad = start at login), completely decoupled from OliveTin and terminals.
#
# OliveTin's Start/Stop/Restart buttons call this script. Each launchctl verb
# returns in well under a second, so OliveTin never holds a long-running action
# open — nothing to reap, nothing to kill.
#
# Usage:
#   svc-ctl.sh install     # write plist + load + start (idempotent)
#   svc-ctl.sh start       # start (load if needed)
#   svc-ctl.sh stop        # stop AND unload (KeepAlive won't fight it)
#   svc-ctl.sh restart     # kill & restart in place
#   svc-ctl.sh status      # launchd state + health probe
#   svc-ctl.sh uninstall   # stop + remove plist
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LABEL="com.soundsuite.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"
SS_MODE="${SS_MODE:-dev}"

NODE_BIN_DIR="$(dirname "$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)")"

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_ROOT/logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/svc-run.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>SS_MODE</key>
        <string>$SS_MODE</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$PROJECT_ROOT/logs/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_ROOT/logs/dashboard.log</string>
</dict>
</plist>
EOF
  echo "wrote $PLIST"
}

case "${1:-}" in
  install)
    write_plist
    launchctl bootout "$SERVICE" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl enable "$SERVICE" 2>/dev/null || true
    launchctl kickstart -k "$SERVICE"
    echo "installed & started $LABEL (SS_MODE=$SS_MODE)"
    ;;
  start)
    [ -f "$PLIST" ] || write_plist
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
    launchctl kickstart "$SERVICE"
    echo "started $LABEL"
    ;;
  stop)
    # bootout unloads the job so KeepAlive won't immediately restart it.
    launchctl bootout "$SERVICE" 2>/dev/null || launchctl kill SIGTERM "$SERVICE" 2>/dev/null || true
    echo "stopped $LABEL"
    ;;
  restart)
    [ -f "$PLIST" ] || write_plist
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
    launchctl kickstart -k "$SERVICE"
    echo "restarted $LABEL"
    ;;
  status)
    if launchctl print "$SERVICE" >/dev/null 2>&1; then
      launchctl print "$SERVICE" 2>/dev/null \
        | grep -E "state =|pid =|last exit code|runs =" | sed 's/^[[:space:]]*/  /'
    else
      echo "  not loaded ($SERVICE)"
    fi
    # /api/health aggregates fleet+service state and can legitimately take ~5s;
    # give it a generous budget so a slow-but-alive server isn't misreported.
    curl -s --max-time 15 -o /dev/null -w "  health: %{http_code} (%{time_total}s)\n" \
      http://localhost:3000/api/health 2>/dev/null || echo "  health: unreachable/timeout"
    ;;
  uninstall)
    launchctl bootout "$SERVICE" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled $LABEL"
    ;;
  *)
    echo "usage: svc-ctl.sh {install|start|stop|restart|status|uninstall}" >&2
    exit 2
    ;;
esac
