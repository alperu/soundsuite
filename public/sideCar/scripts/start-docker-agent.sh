#!/usr/bin/env bash
# Build and run the Sound Suite GPU Orchestrator Agent.
# This container manages multiple GPU Docker containers (embedding, completion,
# OCR, reranker) via Docker socket.
# Run this on the same machine as Docker (Windows WSL2 or Linux GPU machine).
#
# The Next.js server (Mac) talks to this agent on port 8098 instead of
# connecting to the Docker daemon directly. No Docker TCP exposure needed.

set -e

AGENT_NAME="sound-suite-agent"
AGENT_PORT=8098
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Stop existing agent if running
if docker ps -q -f name="$AGENT_NAME" 2>/dev/null | grep -q .; then
    echo "Stopping existing $AGENT_NAME container..."
    docker stop "$AGENT_NAME" >/dev/null 2>&1 || true
    docker rm "$AGENT_NAME" >/dev/null 2>&1 || true
fi

# Build the agent image from the sideCar directory (parent of scripts/)
echo "Building $AGENT_NAME image..."
docker build -t "$AGENT_NAME" "$SCRIPT_DIR/.."

# Run the sidecar
echo "Starting $AGENT_NAME on port $AGENT_PORT..."
# Compose labels put the agent in the same Docker Desktop group as the
# containers it creates (sideCar/src/lib/compose-labels.ts).
COMPOSE_PROJECT="${SS_COMPOSE_PROJECT:-sidecar}"
# Letters are listed, not a-z: in a UTF-8 locale bash 3.2 lets [a-z] match capitals.
case "$COMPOSE_PROJECT" in
  *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*|[!abcdefghijklmnopqrstuvwxyz0123456789]*)
    echo "[WARN] SS_COMPOSE_PROJECT='$COMPOSE_PROJECT' is not a valid compose project name; using 'sidecar'."
    COMPOSE_PROJECT=sidecar ;;
esac
docker run -d \
  --name "$AGENT_NAME" \
  --restart unless-stopped \
  --label "com.docker.compose.project=$COMPOSE_PROJECT" \
  --label com.docker.compose.service=sidecar \
  --label com.docker.compose.oneoff=False \
  --label com.docker.compose.container-number=1 \
  -e SS_COMPOSE_PROJECT="$COMPOSE_PROJECT" \
  -p "$AGENT_PORT:$AGENT_PORT" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e AGENT_PORT="$AGENT_PORT" \
  "$AGENT_NAME"

echo ""
echo "GPU Orchestrator Agent started successfully."
echo ""
echo "Endpoints:"
echo "  Web UI:     http://localhost:$AGENT_PORT/"
echo "  Health:     http://localhost:$AGENT_PORT/health"
echo "  Status:     http://localhost:$AGENT_PORT/status"
echo "  GPU Info:   http://localhost:$AGENT_PORT/gpu"
echo "  Containers: http://localhost:$AGENT_PORT/containers"
echo "  Acquire:    POST http://localhost:$AGENT_PORT/acquire   {role}"
echo "  Release:    POST http://localhost:$AGENT_PORT/release   {role}"
echo "  Start:      POST http://localhost:$AGENT_PORT/start     {role}"
echo "  Stop:       POST http://localhost:$AGENT_PORT/stop      {role}"
echo "  Mode:       POST http://localhost:$AGENT_PORT/mode      {mode}"
echo "  Provision:  POST http://localhost:$AGENT_PORT/provision"
echo "  Config:     POST http://localhost:$AGENT_PORT/config"
echo ""
echo "Logs: docker logs -f $AGENT_NAME"
