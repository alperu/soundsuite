# Install GPU Sidecar

The **sidecar** is a small companion service that runs on each GPU host. It exposes a local API on port `{{SIDECAR_PORT}}`, manages your model containers (Ollama / vLLM), and connects back to this master at **`{{MASTER_URL}}`**.

You only need Docker installed on the GPU host. The sidecar self-updates from the master after first launch — version **{{SIDECAR_VERSION}}** is currently published.

---

## Prerequisites

- A machine with an **NVIDIA GPU** + recent drivers
- **Docker** ≥ 24 with the **NVIDIA Container Toolkit** installed (`nvidia-container-toolkit` package)
- Network reachability from the GPU host to **{{MASTER_HOST}}**

To verify the GPU is visible to Docker:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

---

## Linux

```bash
docker run -d \
  --name ss-sidecar \
  --restart unless-stopped \
  --gpus all \
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} \
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} \
  -v ss-sidecar-config:/app/config \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/soundsuite/ss-sidecar:latest
```

---

## macOS

Docker on macOS doesn't expose host GPUs through the standard `--gpus all` flag, so the sidecar is best run **directly on the host** (not in Docker) when you need GPU access. For a CPU-only test deployment:

```bash
docker run -d \
  --name ss-sidecar \
  --restart unless-stopped \
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} \
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} \
  -v ss-sidecar-config:/app/config \
  -v /var/run/docker.sock.raw:/var/run/docker.sock \
  ghcr.io/soundsuite/ss-sidecar:latest
```

For real GPU work on a Mac with Apple Silicon, run Ollama natively (`brew install ollama`) and skip the sidecar — connect the master directly to `http://your-mac-host:11434`.

---

## Windows (PowerShell)

Make sure Docker Desktop has WSL2 backend enabled and GPU passthrough is on (Settings → Resources → WSL Integration + GPU).

```powershell
docker run -d `
  --name ss-sidecar `
  --restart unless-stopped `
  --gpus all `
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} `
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} `
  -v ss-sidecar-config:/app/config `
  -v //var/run/docker.sock:/var/run/docker.sock `
  ghcr.io/soundsuite/ss-sidecar:latest
```

---

## Verify

After ~5 seconds the sidecar should:

1. Read `SOUND_SUITE_MASTER_URL` and connect to **{{MASTER_URL}}** via WebSocket.
2. Appear in **Admin → GPU Fleet** as a new sidecar entry.
3. Receive a `/config` push from master with idle timeouts, minOnline, and registry.

Check it directly:

```bash
curl http://localhost:{{SIDECAR_PORT}}/api/status | jq '{ serverUrl, wsConnected, mode, lastConfigPushAt }'
```

A healthy boot looks like:

```json
{
  "serverUrl": "{{MASTER_URL}}",
  "wsConnected": true,
  "mode": "searching",
  "lastConfigPushAt": 1730649123456
}
```

The web UI is also available at **`http://<gpu-host>:{{SIDECAR_PORT}}`** for direct inspection.

---

## Updates

Updates are pushed from the master. When a new sidecar version lands at `{{SIDECAR_TARBALL_URL}}`, every connected sidecar pulls and applies it on the next heartbeat — no operator action required.

The container's `/app/config/` directory is preserved across updates. Even if the volume is wiped completely, the `SOUND_SUITE_MASTER_URL` env var lets the sidecar reconnect on next boot — master then re-pushes the rest of the config.

---

## Uninstall

```bash
docker stop ss-sidecar && docker rm ss-sidecar
docker volume rm ss-sidecar-config
```

Then remove the sidecar entry from **Admin → GPU Fleet** to stop master from trying to reach it.
