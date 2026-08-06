#!/bin/bash
###############################################################################
# svc-run.sh — FOREGROUND entrypoint for the launchd agent
#              (com.soundsuite.dashboard). Do NOT background anything here.
#
# launchd owns this process's lifecycle: it runs it in the foreground, captures
# stdout/stderr to logs/dashboard.log, and (KeepAlive) restarts it if it dies.
# This is what makes SoundSuite survive terminal close, OliveTin reaping its
# action tree, logout, and reboot — the failure modes we diagnosed.
#
# The Next.js app boots the integrated file-watcher, job-queue and MCP server,
# so running `next` IS the whole stack (same as start.sh's dashboard step).
#
# Mode: SS_MODE=dev (default) or SS_MODE=production. Set via the plist.
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Homebrew bins first so node/npm/npx resolve under launchd's minimal PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Load .env so the integrated services get the SAME config the old start.sh gave
# them (DATABASE_URL, MCP_PORT, MCP_AUTH_MODE, MIN_UI_WORKERS, PID_KD, …).
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
  set +a
fi

MODE="${SS_MODE:-dev}"

# Take :3000 cleanly. launchd never runs two of these at once (it waits for the
# previous instance to exit + ThrottleInterval before relaunching), so any pid
# still on :3000 here is a stray from a crash or a manual start — clear it so we
# don't crash-loop on EADDRINUSE.
STRAY="$(lsof -ti tcp:3000 2>/dev/null || true)"
if [ -n "$STRAY" ]; then
  echo "[svc-run] clearing stray listener on :3000 -> $STRAY"
  # shellcheck disable=SC2086
  kill -9 $STRAY 2>/dev/null || true
  sleep 1
fi

# Apply any pending migrations. `migrate deploy` NEVER resets (safe for data);
# non-fatal so a migration hiccup doesn't put us in a restart loop.
echo "[svc-run] $(date '+%Y-%m-%dT%H:%M:%S') starting in $MODE mode"
npx prisma migrate deploy || echo "[svc-run] prisma migrate deploy failed (continuing)"

NEXT="./node_modules/.bin/next"

if [ "$MODE" = "production" ] || [ "$MODE" = "prod" ]; then
  # Prod build only if missing, so KeepAlive restarts don't rebuild every crash.
  [ -d "$PROJECT_ROOT/.next" ] || npm run build
  exec "$NEXT" start
else
  exec "$NEXT" dev
fi
