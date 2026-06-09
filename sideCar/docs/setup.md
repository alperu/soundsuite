# Sidecar Setup Guide

## Prerequisites

- **Docker** installed and running — this is the only hard requirement
- Network access to the Sound Suite server (172.16.16.9)
- Node.js 18+ is optional — if not found, the sidecar runs inside a Docker container automatically

## First: Build on the Server

Before any sidecar can download, create a build on the server machine:

```bash
# On the server (172.16.16.9)
cd /path/to/court-lens-mcp
./scripts/buildSidecar.sh
```

## Installation

### Windows (PowerShell)

```powershell
# Download the latest build
Invoke-WebRequest -Uri "http://172.16.16.9:3000/api/admin/gpu/sidecars/download" -OutFile "sidecar-latest.tar.gz"

# Extract
tar xzf sidecar-latest.tar.gz
cd sidecar
```

### Linux / macOS

```bash
curl -o sidecar-latest.tar.gz http://172.16.16.9:3000/api/admin/gpu/sidecars/download
tar xzf sidecar-latest.tar.gz
cd sidecar
```

## Starting the Sidecar

The launcher scripts (`start.bat` / `start.sh`) automatically check dependencies and choose how to run:

```
Sound Suite Sidecar v2.1.0
========================
[OK] Docker
[INFO] Node.js not found - running in Docker mode.
[OK] GPU: NVIDIA GeForce RTX 3090
========================
Starting in Docker mode on port 8098...
```

- **Node.js found (v18+):** runs directly with `node server.js`
- **Node.js missing or too old:** builds a lightweight Docker image from `node:22-alpine` and runs the sidecar inside it — no Node.js install needed

### Windows

```powershell
# Pass server IP as argument
.\start.bat http://172.16.16.9:3000

# Or set as environment variable
$env:SERVER_URL = "http://172.16.16.9:3000"
.\start.bat

# Custom port
$env:PORT = "9000"
.\start.bat http://172.16.16.9:3000
```

### Linux / macOS

```bash
./start.sh http://172.16.16.9:3000

# Or with env vars
SERVER_URL=http://172.16.16.9:3000 PORT=9000 ./start.sh
```

### Subsequent launches

The server URL is saved to `config.json` after the first connection. Just run without arguments:

```powershell
.\start.bat        # Windows
```
```bash
./start.sh         # Linux/macOS
```

### Docker mode details

When running in Docker mode, the launcher:

1. Builds a minimal image (`ss-sidecar:v{VERSION}`) from `Dockerfile.run` included in the package
2. Runs the container with:
   - Port mapping (`-p 8098:8098`)
   - Docker socket mounted (so it can manage GPU containers)
   - Persistent config volume (`ss-sidecar-config`)
   - Auto-restart (`--restart unless-stopped`)
3. The container is named `ss-sidecar`

Useful commands:
```powershell
docker logs -f ss-sidecar     # View logs
docker stop ss-sidecar        # Stop
docker start ss-sidecar       # Restart
docker rm -f ss-sidecar       # Remove (start.bat will recreate)
```

### Other ways to set the server IP

**Dashboard UI:**
1. Start the sidecar: `.\start.bat`
2. Open `http://localhost:8098` in a browser
3. Enter `http://172.16.16.9:3000` in the connection form

**API call (PowerShell):**
```powershell
Invoke-RestMethod -Uri "http://localhost:8098/api/ws-connect" `
  -Method POST -ContentType "application/json" `
  -Body '{"serverUrl": "http://172.16.16.9:3000"}'
```

**API call (Linux/macOS):**
```bash
curl -X POST http://localhost:8098/api/ws-connect \
  -H "Content-Type: application/json" \
  -d '{"serverUrl": "http://172.16.16.9:3000"}'
```

**Config file:**

Create `config.json` (set `CONFIG_PATH` to its location):

```json
{
  "serverUrl": "http://172.16.16.9:3000",
  "mode": "searching"
}
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_URL` | *(none)* | Sound Suite server URL |
| `PORT` | `8098` | Port the sidecar listens on |
| `CONFIG_PATH` | `/app/config.json` | Path to persistent config file |
| `DOCKER_HOST` | *(auto-detect)* | Docker socket path override |

## Dependency Check Summary

| Dependency | Required | Notes |
|------------|----------|-------|
| Docker | Yes | Must be installed and running |
| Node.js 18+ | No | Falls back to Docker mode if missing |
| NVIDIA GPU | No | Detected automatically; uses Docker probe |
| nvidia-smi | No | Optional; informational only |

## How It Works (Gossip Protocol)

The sidecar uses a **pull model** — it initiates all connections to the server. The server never needs to reach the sidecar directly. This means sidecars work behind NAT, firewalls, Docker, or on different subnets.

1. **On startup**: sidecar auto-provisions Docker containers (pull images + create, but doesn't start)
2. **WebSocket**: connects outbound to server port 3002 — server sends commands DOWN this tunnel
3. **Heartbeat**: every 5s, sends full status (containers, GPU, VRAM, mode, requests) to server
4. **Commands**: server queues commands; sidecar receives them via WS or polls via HTTP fallback
5. **VRAM check**: before starting a container, checks available GPU memory against requirements

The admin UI shows live sidecar status from cached heartbeat data — no outbound connections needed.

## Auto-Updates

The sidecar checks for updates automatically:

- **On connect** — logs if an update is available
- **Every 5 minutes** — downloads and applies automatically
- **Manual trigger** — send `{"action": "update"}` via WebSocket

To publish a new version:
```bash
# On the server
./scripts/buildSidecar.sh
# All connected sidecars update within 5 minutes
```

## Files in the Package

```
sidecar/
  server.js          # Next.js standalone server
  package.json       # Package metadata
  VERSION            # Version string (e.g. "2.1.0")
  node_modules/      # Minimal runtime dependencies
  .next/             # Compiled app (routes, static assets)
  start.sh           # Linux/macOS launcher (with dependency checks)
  start.bat          # Windows launcher (with dependency checks)
  Dockerfile.run     # Lightweight runtime image (node:22-alpine)
```

## Troubleshooting

### Download returns 404
Run `./scripts/buildSidecar.sh` on the server first to create a build.

### PowerShell `curl` doesn't work
PowerShell aliases `curl` to `Invoke-WebRequest`. Use the proper syntax:
```powershell
Invoke-WebRequest -Uri "http://172.16.16.9:3000/api/admin/gpu/sidecars/download" -OutFile "sidecar-latest.tar.gz"
```
Or use `curl.exe` (the real curl bundled with Windows 10+):
```powershell
curl.exe -o sidecar-latest.tar.gz http://172.16.16.9:3000/api/admin/gpu/sidecars/download
```

### 'node' is not recognized (Windows)
This is expected if Node.js isn't installed. The launcher detects this and runs in Docker mode automatically. No action needed.

### Sidecar can't reach the server
```powershell
# Windows — test connectivity
Test-NetConnection -ComputerName 172.16.16.9 -Port 3000
Test-NetConnection -ComputerName 172.16.16.9 -Port 3002
```
Both port 3000 (HTTP) and 3002 (WebSocket) must be accessible.

### Docker commands fail
- **Windows:** Ensure Docker Desktop is running
- **Linux:** Check socket permissions: `ls -la /var/run/docker.sock`

### Port 8098 won't bind / `localhost:8098` unreachable (Windows)
**Symptom** — one of:
- Starting the container errors with
  `(HTTP code 500) ... ports are not available: exposing port TCP 0.0.0.0:8098 ... bind: An attempt was made to access a socket in a way forbidden by its access permissions` (Windows error `WSAEACCES`/`10013`).
- The container shows as `Up` in `docker ps`, but its **PORTS** column reads a bare `8098/tcp` instead of `0.0.0.0:8098->8098/tcp` — i.e. it's running **unpublished**, so `http://localhost:8098/` connects to nothing.

**Cause** — Windows reserves dynamic TCP port ranges for Hyper-V / WSL2 NAT (`winnat`). If `8098` falls inside one of those ranges, Docker can't publish it to the host. After the failed bind the container may end up running without the port mapping (and `docker start` cannot add one back — the container must be **recreated** once the port is free).

**Check whether 8098 is reserved** (Administrator cmd/PowerShell):
```cmd
netsh interface ipv4 show excludedportrange protocol=tcp
```
If a listed start–end range contains `8098`, that's the cause.

**Fix** (Administrator cmd/PowerShell):
```cmd
:: 1. Free 8098 and pin it out of the dynamic pool (survives reboots)
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=8098 numberofports=1
net start winnat

:: 2. Recreate the sidecar WITH the publish (docker start can't re-add a mapping)
docker rm -f ss-sidecar
::    then re-run your original `docker run … -p 8098:8098 …` (or: docker compose up -d --force-recreate)

:: 3. Verify — PORTS must now read 0.0.0.0:8098->8098/tcp
docker ps
curl.exe http://localhost:8098/api/masters
```

**If it keeps getting grabbed after a reboot**, move the whole dynamic range above 8098, then do a true restart (not shutdown+power-on — Windows *Fast Startup* re-reserves the ports):
```cmd
netsh int ipv4 set dynamic tcp start=49152 num=16384
netsh int ipv4 set dynamicport tcp start=49152 num=16384
shutdown /r /t 0
```

If `docker ps -a` shows **no** `ss-sidecar` container at all, it was never created on this host — run the original `docker run …` command from setup rather than `docker start`.

### GPU not detected
- Run `nvidia-smi` to verify drivers are installed
- Ensure NVIDIA Container Toolkit is installed for Docker GPU access
