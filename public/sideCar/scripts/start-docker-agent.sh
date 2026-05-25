#!/usr/bin/env bash
# DEPRECATED — kept as a shim that redirects to the canonical install path.
#
# This script previously tried to `docker build -t sound-suite-agent .` from a
# checked-out source tree, but the published tarball ships `Dockerfile.run`
# (not `Dockerfile`), so the build silently produced an empty image. It also
# didn't accept a master URL, didn't auto-detect the host LAN IP (resulting
# in 172.17.0.2 registrations on Mac), and didn't pass through host-Ollama /
# DMR env vars.
#
# The supported one-liner install-and-run path now lives in install.sh, which
# downloads the prebuilt tarball, then chains into start.sh --docker (which
# builds Dockerfile.run, auto-detects EXTERNAL_IP, and on Mac auto-enables
# host-Ollama mode):
#
#   curl -fsSL <master>/sideCar/scripts/install.sh | bash -s -- --docker <master>
#
# Run with --force to skip the redirect and execute this legacy script anyway
# (mostly useful for masters running on machines that can't reach the install
# tarball but already have the sidecar source checked out locally).

set -e

FORCE=0
SERVER=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    http*) SERVER="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$FORCE" != "1" ]; then
  echo "================================================================="
  echo " start-docker-agent.sh is deprecated. Use the install.sh one-liner:"
  echo ""
  if [ -n "$SERVER" ]; then
    echo "   curl -fsSL $SERVER/sideCar/scripts/install.sh | bash -s -- --docker $SERVER"
  else
    echo "   curl -fsSL <master-url>/sideCar/scripts/install.sh | bash -s -- --docker <master-url>"
  fi
  echo ""
  echo " That path: downloads the latest signed tarball, builds Dockerfile.run,"
  echo " auto-detects the host LAN IP (EXTERNAL_IP), and on Mac auto-enables"
  echo " host-Ollama mode. This script could not do any of that."
  echo ""
  echo " If you have a local sidecar source tree and really want the legacy"
  echo " build-from-here behavior, re-run as:  $0 --force [http://master:3000]"
  echo "================================================================="
  exit 1
fi

AGENT_NAME="sound-suite-agent"
AGENT_PORT=8098

# Legacy --force path: build from the parent dir using Dockerfile.run.
DOCKERFILE="$SCRIPT_DIR/../Dockerfile.run"
if [ ! -f "$DOCKERFILE" ]; then
  echo "[ERROR] $DOCKERFILE not found."
  echo "  This script expects to live in <sidecar>/scripts/ next to Dockerfile.run."
  echo "  Use the install.sh one-liner instead — it fetches the tarball that"
  echo "  contains Dockerfile.run."
  exit 1
fi

if docker ps -aq -f name="$AGENT_NAME" 2>/dev/null | grep -q .; then
  echo "Stopping existing $AGENT_NAME container..."
  docker stop "$AGENT_NAME" >/dev/null 2>&1 || true
  docker rm "$AGENT_NAME" >/dev/null 2>&1 || true
fi

echo "Building $AGENT_NAME image from $DOCKERFILE..."
docker build -f "$DOCKERFILE" -t "$AGENT_NAME" "$SCRIPT_DIR/.."

MASTER_ENV=()
if [ -n "$SERVER" ]; then
  MASTER_ENV+=(-e "SOUND_SUITE_MASTER_URL=$SERVER")
fi

echo "Starting $AGENT_NAME on port $AGENT_PORT..."
docker run -d \
  --name "$AGENT_NAME" \
  --restart unless-stopped \
  -p "$AGENT_PORT:$AGENT_PORT" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e AGENT_PORT="$AGENT_PORT" \
  "${MASTER_ENV[@]}" \
  "$AGENT_NAME"

echo ""
echo "GPU Orchestrator Agent started on http://localhost:$AGENT_PORT/"
echo "Logs: docker logs -f $AGENT_NAME"
