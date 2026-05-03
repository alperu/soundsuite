# Install GPU Sidecar

The **sidecar** is a small companion service that runs on each GPU host. It manages your model containers (Ollama / vLLM), exposes a local API on port `{{SIDECAR_PORT}}`, and connects back to this master at **`{{MASTER_URL}}`**.

There are two ways to install it:

1. **Native install** (recommended) — downloads the sidecar tarball, extracts it, runs it with Node. Self-updates on every master rebuild.
2. **Docker install** — runs the sidecar inside a Docker container. Useful when you don't want Node on the host.

The native install is the same script the auto-updater uses; the published version is **v{{SIDECAR_VERSION}}**.

---

## Native install

### Linux / macOS — one-liner

```bash
curl -fsSL {{MASTER_URL}}/sideCar/scripts/install.sh -o install.sh && chmod +x install.sh && ./install.sh {{MASTER_URL}}
```

This downloads `install.sh`, fetches the tarball at `{{SIDECAR_TARBALL_URL}}`, verifies its SHA-256 against the manifest, and installs to `~/sidecar`.

After install, start the sidecar:

```bash
cd ~/sidecar
./start.sh {{MASTER_URL}}
```

The sidecar opens its admin UI on **`http://localhost:{{SIDECAR_PORT}}`** and connects back to **{{MASTER_URL}}** via WebSocket.

### Windows — one-liner (PowerShell)

```powershell
Invoke-WebRequest -Uri {{MASTER_URL}}/sideCar/scripts/install.bat -OutFile install.bat; .\install.bat {{MASTER_URL}}
```

After install:

```powershell
cd $env:USERPROFILE\sidecar
.\start.bat {{MASTER_URL}}
```

### What the installer does

1. Fetches `{{MASTER_URL}}/sideCar/builds/manifest.json` to learn the latest version + SHA-256.
2. If `~/sidecar/VERSION` already matches, nothing to do.
3. Otherwise downloads `sidecar-v{{SIDECAR_VERSION}}.tar.gz`, verifies the checksum, stops any running sidecar container, extracts to `~/sidecar` (or `$INSTALL_DIR`), preserves `~/sidecar/config/` across upgrades.

Custom install path:

```bash
INSTALL_DIR=/opt/sidecar ./install.sh {{MASTER_URL}}
```

---

## Docker install

If you prefer running the sidecar in a container:

### Linux

```bash
curl -fsSL {{MASTER_URL}}/sideCar/scripts/start-docker-agent.sh -o start-docker-agent.sh && chmod +x start-docker-agent.sh && ./start-docker-agent.sh
```

The script builds a `sound-suite-agent` image from a checked-out sidecar source tree and runs it with `--restart unless-stopped`, mounting `/var/run/docker.sock` so the sidecar can manage GPU containers.

### Windows (PowerShell)

```powershell
Invoke-WebRequest -Uri {{MASTER_URL}}/sideCar/scripts/start-docker-agent.bat -OutFile start-docker-agent.bat; .\start-docker-agent.bat
```

### Manual `docker run` with env-var bootstrap

If you want to roll your own (no script):

```bash
docker run -d \
  --name ss-sidecar \
  --restart unless-stopped \
  --gpus all \
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} \
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} \
  -v ss-sidecar-config:/app/config \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ss-sidecar:latest
```

The `SOUND_SUITE_MASTER_URL` env var is the safety net — even if `/app/config/` is wiped between runs, the sidecar reads this on boot and reconnects to **{{MASTER_URL}}** automatically. Master then pushes the rest of the config back over the WebSocket.

---

## Prerequisites

- A machine with an **NVIDIA GPU** + recent drivers (CPU-only is supported but unrealistic for production).
- **Docker** ≥ 24 with the **NVIDIA Container Toolkit** if you want GPU passthrough into the model containers (Ollama / vLLM).
- For the **native install**: **Node.js** ≥ 22 on the host (the sidecar's Next.js runtime).
- Network reachability from the GPU host to **{{MASTER_HOST}}**. Pick the right IP from the dropdown in the left rail if `{{MASTER_URL}}` doesn't match what the GPU host can reach.

Verify Docker can see the GPU:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

---

## Verify the install

After ~5 seconds the sidecar should:

1. Read its server URL (from `~/sidecar/config/sidecar.config.json` or `SOUND_SUITE_MASTER_URL`) → **{{MASTER_URL}}**.
2. Open a WebSocket back to master.
3. Appear in **Admin → GPU Fleet** as a new sidecar entry.
4. Receive a `/config` push from master with idle timeouts, minOnline policy, and the model registry.

Check it directly from the GPU host:

```bash
curl http://localhost:{{SIDECAR_PORT}}/api/status | jq '{ serverUrl, wsConnected, mode, lastConfigPushAt }'
```

Healthy boot looks like:

```json
{
  "serverUrl": "{{MASTER_URL}}",
  "wsConnected": true,
  "mode": "searching",
  "lastConfigPushAt": 1730649123456
}
```

The sidecar's own admin UI is also at **`http://<gpu-host>:{{SIDECAR_PORT}}`** for direct inspection.

---

## Updates

Updates are pushed from the master. When a new sidecar version is published at **{{SIDECAR_TARBALL_URL}}**, every connected sidecar pulls and applies it on the next heartbeat — no operator action required.

The container's `/app/config/` directory (or `~/sidecar/config/` for native installs) is preserved across updates. Even if the volume is wiped completely, the `SOUND_SUITE_MASTER_URL` env var or the saved `serverUrl` in `sidecar.config.json` lets the sidecar reconnect on next boot.

To re-run the installer manually (e.g. for a major version bump):

```bash
~/sidecar/install.sh {{MASTER_URL}}
```

---

## Uninstall

### Native install

```bash
docker stop ss-sidecar && docker rm ss-sidecar 2>/dev/null
rm -rf ~/sidecar
```

### Docker install

```bash
docker stop ss-sidecar && docker rm ss-sidecar
docker volume rm ss-sidecar-config
```

Then remove the sidecar entry from **Admin → GPU Fleet** to stop master from trying to reach it.
