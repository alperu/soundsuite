#!/usr/bin/env bash
# Sound Suite Sidecar Launcher (Linux/macOS) — standalone download
# Usage: ./start.sh [MASTER_URL]
#   ./start.sh http://172.16.16.9:3000
#   SOUND_SUITE_MASTER_URL=http://172.16.16.9:3000 ./start.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8098}"
VER="$( [ -f "$DIR/VERSION" ] && cat "$DIR/VERSION" || echo unknown )"

# Master URL: positional arg > SOUND_SUITE_MASTER_URL > legacy SERVER_URL
if [ -n "${1:-}" ]; then
  export SOUND_SUITE_MASTER_URL="$1"
  export SERVER_URL="$1"
fi
if [ -z "${SOUND_SUITE_MASTER_URL:-}" ] && [ -n "${SERVER_URL:-}" ]; then
  export SOUND_SUITE_MASTER_URL="$SERVER_URL"
fi
if [ -z "${SERVER_URL:-}" ] && [ -n "${SOUND_SUITE_MASTER_URL:-}" ]; then
  export SERVER_URL="$SOUND_SUITE_MASTER_URL"
fi

echo "Sound Suite Sidecar v$VER"
echo "========================"
[ -n "${SOUND_SUITE_MASTER_URL:-}" ] && echo "Master URL: $SOUND_SUITE_MASTER_URL" || echo "[WARN] No master URL set. Run: ./start.sh http://master:3000"

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "[ERROR] Docker is not installed or not in PATH."
  exit 1
fi
if ! docker info &>/dev/null; then
  echo "[ERROR] Docker daemon is not running."
  exit 1
fi
echo "[OK] Docker"

# Node check
USE_DOCKER=0
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "[WARN] Node.js $NODE_VER too old (need 18+) — falling back to Docker mode."
    USE_DOCKER=1
  else
    echo "[OK] Node.js $NODE_VER"
  fi
else
  echo "[INFO] Node.js not found — running in Docker mode."
  USE_DOCKER=1
fi
echo "========================"

# Stop any pre-existing ss-sidecar container
docker rm -f ss-sidecar 2>/dev/null || true

if [ "$USE_DOCKER" = "1" ]; then
  echo "Starting in Docker mode on port $PORT..."
  if [ ! -f "$DIR/Dockerfile.run" ]; then
    echo "[ERROR] Dockerfile.run not found in $DIR. Re-run install.sh or use Node mode."
    exit 1
  fi
  # macOS shim trap: /usr/bin/git is an Xcode-CLT stub that pops the
  # "Install developer tools" dialog when invoked. Docker Desktop's BuildKit
  # runs `git rev-parse` during `docker build` to add provenance labels.
  # Force the legacy builder (no git probe) and disable attestations.
  export DOCKER_BUILDKIT=0
  export BUILDX_NO_DEFAULT_ATTESTATIONS=1
  DOCKER_ARGS="-d --name ss-sidecar --restart unless-stopped"
  if [ "$(uname)" = "Linux" ]; then
    DOCKER_ARGS="$DOCKER_ARGS --network host"
  else
    DOCKER_ARGS="$DOCKER_ARGS -p $PORT:8098"
  fi
  DOCKER_ARGS="$DOCKER_ARGS --add-host=host.docker.internal:host-gateway"
  DOCKER_ARGS="$DOCKER_ARGS -v /var/run/docker.sock:/var/run/docker.sock"
  DOCKER_ARGS="$DOCKER_ARGS -v ss-sidecar-config:/app/config"
  DOCKER_ARGS="$DOCKER_ARGS -e NODE_ENV=production"
  DOCKER_ARGS="$DOCKER_ARGS -e CONFIG_PATH=/app/config/config.json"
  [ -n "${SOUND_SUITE_MASTER_URL:-}" ] && DOCKER_ARGS="$DOCKER_ARGS -e SOUND_SUITE_MASTER_URL=$SOUND_SUITE_MASTER_URL"
  [ -n "${SERVER_URL:-}" ] && DOCKER_ARGS="$DOCKER_ARGS -e SERVER_URL=$SERVER_URL"
  DOCKER_ARGS="$DOCKER_ARGS -e SIDECAR_HOSTNAME=$(hostname)"

  docker build -t "ss-sidecar:v$VER" -f "$DIR/Dockerfile.run" "$DIR"
  echo "Launching: docker run $DOCKER_ARGS ss-sidecar:v$VER"
  eval docker run $DOCKER_ARGS "ss-sidecar:v$VER"
  echo "Sidecar running. Dashboard: http://localhost:$PORT"
else
  echo "Starting on port $PORT..."
  [ -n "${SOUND_SUITE_MASTER_URL:-}" ] && echo "Connecting to master: $SOUND_SUITE_MASTER_URL"
  export NODE_ENV=production
  export PORT="$PORT"
  export HOSTNAME=0.0.0.0
  export CONFIG_PATH="$DIR/config/config.json"
  exec node "$DIR/server.js"
fi
