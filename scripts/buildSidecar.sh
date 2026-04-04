#!/usr/bin/env bash
# Build the sidecar standalone package and publish to public/sideCar/builds/
# Usage: ./scripts/buildSidecar.sh [major|minor|patch]
#   Default: patch

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$PROJECT_ROOT/sideCar"
OUTPUT_DIR="$PROJECT_ROOT/public/sideCar/builds"

BUMP_TYPE="${1:-patch}"

# --- Version bump ---
cd "$SIDECAR_DIR"
OLD_VERSION=$(node -p "require('./package.json').version")

# Parse semver
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

# Update package.json version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Version: $OLD_VERSION -> $NEW_VERSION"

# --- Build ---
echo "Cleaning stale .next cache..."
rm -rf "$SIDECAR_DIR/.next"

echo "Building sidecar..."
npm run build

# --- Package ---
STANDALONE_DIR="$SIDECAR_DIR/.next/standalone"
STATIC_DIR="$SIDECAR_DIR/.next/static"

if [ ! -d "$STANDALONE_DIR" ]; then
  echo "ERROR: standalone output not found at $STANDALONE_DIR"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Create tarball with standalone + static assets + launcher scripts
TARBALL="$OUTPUT_DIR/sidecar-v${NEW_VERSION}.tar.gz"

# Create a staging directory
STAGE_DIR=$(mktemp -d)
trap "rm -rf $STAGE_DIR" EXIT

mkdir -p "$STAGE_DIR/sidecar"
# Copy all files including dotfiles (.next/)
cp -r "$STANDALONE_DIR/". "$STAGE_DIR/sidecar/"
# Overlay static assets (standalone doesn't include .next/static/)
mkdir -p "$STAGE_DIR/sidecar/.next/static"
if [ -d "$STATIC_DIR" ]; then
  cp -r "$STATIC_DIR/"* "$STAGE_DIR/sidecar/.next/static/"
fi

# Write version file inside the package
echo "$NEW_VERSION" > "$STAGE_DIR/sidecar/VERSION"

# Create cross-platform launcher scripts

# --- start.sh (Linux/macOS) ---
cat > "$STAGE_DIR/sidecar/start.sh" << 'LAUNCHER_SH'
#!/usr/bin/env bash
# Sound Suite Sidecar Launcher (Linux/macOS)
# Usage: ./start.sh [SERVER_URL]
#   ./start.sh http://172.16.16.9:3000
#   SERVER_URL=http://172.16.16.9:3000 ./start.sh
#   PORT=9000 ./start.sh http://172.16.16.9:3000
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8098}"
VER=$(cat "$DIR/VERSION")

# Accept server URL as first argument or env var
if [ -n "${1:-}" ]; then
  export SERVER_URL="$1"
fi

# --- Dependency checks ---
echo "Sound Suite Sidecar v$VER"
echo "========================"

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "[ERROR] Docker is not installed or not in PATH."
  echo "  Install: https://docs.docker.com/get-docker/"
  exit 1
fi
if ! docker info &>/dev/null 2>&1; then
  echo "[ERROR] Docker daemon is not running."
  echo "  Start Docker Desktop or run: sudo systemctl start docker"
  exit 1
fi
echo "[OK] Docker"

# Check Node.js (optional — fallback to Docker mode)
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "[WARN] Node.js $NODE_VER found but v18+ is required."
    echo "  Falling back to Docker mode. Or upgrade: https://nodejs.org"
    USE_DOCKER=1
  else
    echo "[OK] Node.js $NODE_VER"
  fi
else
  echo "[INFO] Node.js not found — running in Docker mode."
  USE_DOCKER=1
fi

# Check GPU (optional)
if command -v nvidia-smi &>/dev/null; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  echo "[OK] GPU: $GPU_NAME"
else
  echo "[INFO] nvidia-smi not found — GPU detection will use Docker probe."
fi

echo "========================"

# --- Launch ---
if [ "${USE_DOCKER:-}" = "1" ]; then
  echo "Starting in Docker mode on port $PORT..."
  [ -n "${SERVER_URL:-}" ] && echo "Connecting to server: $SERVER_URL"

  DOCKER_ARGS="-d --name ss-sidecar --restart unless-stopped"
  # On Linux use host networking for full LAN access; on macOS use port mapping
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
  [ -n "${SERVER_URL:-}" ] && DOCKER_ARGS="$DOCKER_ARGS -e SERVER_URL=$SERVER_URL"

  # Detect host's LAN IP so the sidecar registers with a reachable address
  # (inside Docker, network interfaces show the bridge IP 172.17.x.x which is unreachable)
  if [ "$(uname)" != "Linux" ]; then
    # macOS/other: detect LAN IP from host interfaces
    HOST_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | grep -v '172.17' | head -1 | awk '{print $2}')
    if [ -n "$HOST_IP" ]; then
      DOCKER_ARGS="$DOCKER_ARGS -e EXTERNAL_IP=$HOST_IP"
      echo "  Host IP: $HOST_IP"
    fi
  fi
  # Linux with --network host doesn't need EXTERNAL_IP (host interfaces are visible)

  # Pass real hostname into container (os.hostname() returns container ID inside Docker)
  DOCKER_ARGS="$DOCKER_ARGS -e SIDECAR_HOSTNAME=$(hostname)"

  # Remove old container if exists
  docker rm -f ss-sidecar 2>/dev/null || true

  # Build image from the extracted files
  docker build -t ss-sidecar:v$VER -f "$DIR/Dockerfile.run" "$DIR"
  eval docker run $DOCKER_ARGS ss-sidecar:v$VER

  echo "Sidecar running as Docker container 'ss-sidecar'."
  echo "  Dashboard: http://localhost:$PORT"
  echo "  Logs:      docker logs -f ss-sidecar"
  echo "  Stop:      docker stop ss-sidecar"
else
  echo "Starting on port $PORT..."
  [ -n "${SERVER_URL:-}" ] && echo "Connecting to server: $SERVER_URL"
  export NODE_ENV=production
  export PORT="$PORT"
  export HOSTNAME=0.0.0.0
  export CONFIG_PATH="$DIR/config/config.json"
  exec node "$DIR/server.js"
fi
LAUNCHER_SH
chmod +x "$STAGE_DIR/sidecar/start.sh"

# --- start.bat (Windows) ---
cat > "$STAGE_DIR/sidecar/start.bat" << 'LAUNCHER_BAT'
@echo off
REM Sound Suite Sidecar Launcher (Windows)
REM Usage: start.bat [SERVER_URL]
REM   start.bat http://172.16.16.9:3000
REM   set SERVER_URL=http://172.16.16.9:3000 && start.bat
setlocal enabledelayedexpansion

REM Resolve DIR without trailing backslash (avoids \" escaping issues in paths)
set "DIR=%~dp0"
if "!DIR:~-1!"=="\" set "DIR=!DIR:~0,-1!"

if "%PORT%"=="" set PORT=8098
if not "%~1"=="" set SERVER_URL=%~1
set /p VER=<"!DIR!\VERSION"

echo Sound Suite Sidecar v!VER!

echo ========================

REM --- Check Docker ---
where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH.
    echo   Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/
    pause
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker daemon is not running.
    echo   Start Docker Desktop and try again.
    pause
    exit /b 1
)
echo [OK] Docker

REM --- Check Node.js ---
set USE_DOCKER=0
where node >nul 2>&1
if errorlevel 1 (
    echo [INFO] Node.js not found -- running in Docker mode.
    set USE_DOCKER=1
) else (
    for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_VER=%%a
    set "NODE_VER=!NODE_VER:v=!"
    if !NODE_VER! LSS 18 (
        echo [WARN] Node.js too old. v18+ required. Falling back to Docker mode.
        set USE_DOCKER=1
    ) else (
        for /f %%a in ('node -v') do echo [OK] Node.js %%a
    )
)

REM --- Check GPU (optional) ---
where nvidia-smi >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%g in ('nvidia-smi --query-gpu^=name --format^=csv^,noheader 2^>nul') do echo [OK] GPU: %%g
) else (
    echo [INFO] nvidia-smi not found -- GPU detection will use Docker probe.
)

echo ========================

REM --- Launch ---
if !USE_DOCKER!==1 (
    echo Starting in Docker mode on port %PORT%...
    if defined SERVER_URL echo Connecting to server: %SERVER_URL%

    docker rm -f ss-sidecar >nul 2>&1

    REM Build image from extracted files
    echo Building Docker image ss-sidecar:v%VER% ...
    docker build -t ss-sidecar:v%VER% -f "!DIR!\Dockerfile.run" "!DIR!"
    if errorlevel 1 (
        echo [ERROR] Docker build failed.
        pause
        exit /b 1
    )

    set "DOCKER_CMD=docker run -d --name ss-sidecar --restart unless-stopped"
    set "DOCKER_CMD=!DOCKER_CMD! -p %PORT%:8098"
    set "DOCKER_CMD=!DOCKER_CMD! --add-host=host.docker.internal:host-gateway"
    REM Mount Docker socket - works on Docker Desktop WSL2 backend, translates to VM socket
    set "DOCKER_CMD=!DOCKER_CMD! -v /var/run/docker.sock:/var/run/docker.sock"
    set "DOCKER_CMD=!DOCKER_CMD! -v ss-sidecar-config:/app/config"
    set "DOCKER_CMD=!DOCKER_CMD! -e NODE_ENV=production"
    set "DOCKER_CMD=!DOCKER_CMD! -e CONFIG_PATH=/app/config/config.json"
    if defined SERVER_URL set "DOCKER_CMD=!DOCKER_CMD! -e SERVER_URL=%SERVER_URL%"

    REM Detect host LAN IP so sidecar registers with a reachable address
    REM Inside Docker, interfaces show 172.17.x.x which the server cannot reach
    set "HOST_IP="
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4" ^| findstr /v "172.17"') do (
        if not defined HOST_IP set "HOST_IP=%%a"
    )
    REM Trim leading space
    if defined HOST_IP for /f "tokens=*" %%a in ("!HOST_IP!") do set "HOST_IP=%%a"
    if defined HOST_IP (
        echo   Host IP: !HOST_IP!
        set "DOCKER_CMD=!DOCKER_CMD! -e EXTERNAL_IP=!HOST_IP!"
    )

    REM Pass Windows computer name into container for display
    if defined COMPUTERNAME set "DOCKER_CMD=!DOCKER_CMD! -e SIDECAR_HOSTNAME=!COMPUTERNAME!"

    !DOCKER_CMD! ss-sidecar:v%VER%
    if errorlevel 1 (
        echo [ERROR] Docker run failed.
        pause
        exit /b 1
    )

    echo.
    echo Sidecar running as Docker container 'ss-sidecar'.
    echo   Dashboard: http://localhost:%PORT%
    echo   Logs:      docker logs -f ss-sidecar
    echo   Stop:      docker stop ss-sidecar
    echo.
    echo NOTE: Docker socket is mounted from the host. If Docker operations fail,
    echo   the sidecar will auto-detect and try TCP fallback automatically.
) else (
    echo Starting on port %PORT%...
    if defined SERVER_URL echo Connecting to server: %SERVER_URL%
    set NODE_ENV=production
    set PORT=%PORT%
    set HOSTNAME=0.0.0.0
    node "!DIR!\server.js"
)
endlocal
LAUNCHER_BAT

# --- Dockerfile.run (lightweight runtime container from pre-built standalone) ---
# This is a runtime-only image — the app is already compiled.
# Next.js standalone output includes all required node_modules (ws, sharp, etc.)
# so no npm install is needed.
cat > "$STAGE_DIR/sidecar/Dockerfile.run" << 'DOCKERFILE_RUN'
FROM node:22-alpine
WORKDIR /app

# Copy the entire pre-built standalone app
# node_modules/ contains only traced production deps (ws, sharp, next, react, etc.)
COPY package.json server.js VERSION ./
COPY node_modules ./node_modules
COPY .next ./.next

ENV NODE_ENV=production
ENV PORT=8098
ENV HOSTNAME=0.0.0.0
EXPOSE 8098
CMD ["node", "server.js"]
DOCKERFILE_RUN

# Copy install scripts into the package
cp "$SIDECAR_DIR/scripts/install.sh" "$STAGE_DIR/sidecar/install.sh"
cp "$SIDECAR_DIR/scripts/install.bat" "$STAGE_DIR/sidecar/install.bat"
chmod +x "$STAGE_DIR/sidecar/install.sh"

# Build the tarball
cd "$STAGE_DIR"
tar czf "$TARBALL" --exclude='sidecar/config' sidecar/

# Compute checksum
if command -v shasum &>/dev/null; then
  CHECKSUM=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
elif command -v sha256sum &>/dev/null; then
  CHECKSUM=$(sha256sum "$TARBALL" | awk '{print $1}')
else
  CHECKSUM="unavailable"
fi

# Get file size
SIZE=$(wc -c < "$TARBALL" | tr -d ' ')

# --- Write manifest ---
cat > "$OUTPUT_DIR/manifest.json" << MANIFEST
{
  "version": "$NEW_VERSION",
  "filename": "sidecar-v${NEW_VERSION}.tar.gz",
  "sha256": "$CHECKSUM",
  "size": $SIZE,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nodeVersion": "$(node -v)",
  "platform": "universal"
}
MANIFEST

# Also keep a copy as "latest" for simple download
cp "$TARBALL" "$OUTPUT_DIR/sidecar-latest.tar.gz"

echo ""
echo "=== Build Complete ==="
echo "  Version:  $NEW_VERSION"
echo "  Package:  $TARBALL"
echo "  Size:     $(echo "scale=1; $SIZE / 1048576" | bc 2>/dev/null || echo "$SIZE bytes")"
echo "  SHA-256:  $CHECKSUM"
echo "  Manifest: $OUTPUT_DIR/manifest.json"
echo ""
echo "Sidecars will auto-update on next heartbeat."
