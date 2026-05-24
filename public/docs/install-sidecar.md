# Install GPU Sidecar

The **sidecar** is a small companion service that runs on each GPU host. It manages your model containers (Ollama / vLLM), exposes a local API on port `{{SIDECAR_PORT}}`, and connects back to this master at **`{{MASTER_URL}}`**.

There are two ways to install it:

1. **Native install** (recommended) — downloads the sidecar tarball, extracts it, runs it with Node. Self-updates on every master rebuild.
2. **Docker install** — runs the sidecar inside a Docker container. Useful when you don't want Node on the host.

The native install is the same script the auto-updater uses; the published version is **v{{SIDECAR_VERSION}}**.

### Download scripts directly

[install.sh]({{MASTER_URL}}/sideCar/scripts/install.sh) [install.bat]({{MASTER_URL}}/sideCar/scripts/install.bat) [start.sh]({{MASTER_URL}}/sideCar/scripts/start.sh) [start.bat]({{MASTER_URL}}/sideCar/scripts/start.bat) [start-docker-agent.sh]({{MASTER_URL}}/sideCar/scripts/start-docker-agent.sh) [start-docker-agent.bat]({{MASTER_URL}}/sideCar/scripts/start-docker-agent.bat)

---

## Native install

### Linux / macOS — one-liner

```bash
curl -fsSL {{MASTER_URL}}/sideCar/scripts/install.sh -o install.sh && chmod +x install.sh && ./install.sh {{MASTER_URL}}
```

This downloads `install.sh`, fetches the tarball at `{{SIDECAR_TARBALL_URL}}`, verifies its SHA-256 against the manifest, and installs to `~/sidecar`.

After install, start the sidecar (it installs to `./sidecar` relative to where you ran the installer):

```bash
cd ./sidecar
./start.sh {{MASTER_URL}}
```

The sidecar opens its admin UI on **`http://localhost:{{SIDECAR_PORT}}`** and connects back to **{{MASTER_URL}}** via WebSocket.

### macOS in Docker mode (with host-Ollama)

On a Mac you usually want the sidecar inside Docker but the actual models served by **native Ollama** on the host — that's the only path that gets Metal GPU acceleration. The launcher supports this with one flag plus an auto-default.

```bash
# 1. One-time: install native Ollama (this is what unlocks the Metal GPU)
brew install ollama
brew services start ollama
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
brew services restart ollama
curl -s http://localhost:11434/api/version    # sanity check

# 2. Optional but recommended: pre-pull the models so first-call doesn't wait
ollama pull qwen3-embedding:0.6b
ollama pull qwen3.5:9b
ollama pull richardyoung/olmocr2:7b-q8

# 3. Refresh the launcher so it knows --docker (older copies don't)
cd ./sidecar
curl -fsSL {{MASTER_URL}}/sideCar/scripts/start.sh -o start.sh
chmod +x start.sh

# 4. Start in Docker mode — auto-sets SS_HOST_OLLAMA on Mac
./start.sh --docker {{MASTER_URL}}
```

What `--docker` does that bare `./start.sh` doesn't:
1. Forces the Docker container path even when Node ≥18 is installed (otherwise the launcher prefers Node and runs the sidecar as a Node process, not in Docker).
2. On macOS, when `SS_HOST_OLLAMA` isn't set explicitly, the launcher auto-defaults `SS_HOST_OLLAMA=1`, `SS_HOST_OLLAMA_ROLES=embedding,completion,ocr`, `HOST_OS=darwin` so the gossip planner doesn't trim the registry to "utility roles only" on first connect.

Override the defaults from the parent shell if needed:

```bash
SS_HOST_OLLAMA_ROLES=embedding,completion \
SS_HOST_OLLAMA_BUDGET_MB=16384 \
./start.sh --docker {{MASTER_URL}}
```

To explicitly disable host-Ollama mode (you'll want this on Linux/Windows where Docker has GPU passthrough): `SS_HOST_OLLAMA=0 ./start.sh --docker {{MASTER_URL}}`.

See the **"macOS host with native Ollama"** section below for full env-var reference, verification, troubleshooting, and the optional host-stats helper.

### Windows — one-liner (PowerShell)

```powershell
Invoke-WebRequest -Uri {{MASTER_URL}}/sideCar/scripts/install.bat -OutFile install.bat; .\install.bat {{MASTER_URL}}
```

After install (the installer drops `sidecar\` into your current directory):

```powershell
cd .\sidecar
.\start.bat {{MASTER_URL}}
```

### What the installer does

1. Fetches `{{MASTER_URL}}/sideCar/builds/manifest.json` to learn the latest version + SHA-256.
2. If `./sidecar/VERSION` already matches, nothing to do.
3. Otherwise downloads `sidecar-v{{SIDECAR_VERSION}}.tar.gz`, verifies the checksum, stops any running sidecar container, extracts to `./sidecar` (or `$INSTALL_DIR`), preserves `./sidecar/config/` across upgrades.

Default install dir is `<current dir>/sidecar` so you stay on the drive you ran the installer from. Custom install path:

```bash
# Linux / macOS
INSTALL_DIR=/opt/sidecar ./install.sh {{MASTER_URL}}
```

```powershell
# Windows
$env:INSTALL_DIR="D:\sidecar"; .\install.bat {{MASTER_URL}}
```

### Refresh just the launcher (start.bat / start.sh)

If you've already installed the sidecar but the launcher is broken or out of date, you can pull just the latest launcher without re-running the full installer:

```powershell
# Windows — drop the new start.bat into your existing install
cd .\sidecar
Invoke-WebRequest -Uri {{MASTER_URL}}/sideCar/scripts/start.bat -OutFile start.bat
.\start.bat {{MASTER_URL}}
```

```bash
# Linux / macOS
cd ./sidecar
curl -fsSL {{MASTER_URL}}/sideCar/scripts/start.sh -o start.sh && chmod +x start.sh
./start.sh {{MASTER_URL}}
```

The launcher reads `SOUND_SUITE_MASTER_URL` from its first argument or env var and passes it to the sidecar process.

---

## Docker install

If you prefer running the sidecar in a container:

### macOS — one-liner

```bash
curl -fsSL {{MASTER_URL}}/sideCar/scripts/install.sh -o install.sh && chmod +x install.sh && ./install.sh {{MASTER_URL}} && cd sidecar && ./start.sh --docker {{MASTER_URL}}
```

This installs the sidecar tarball, then launches `start.sh --docker` which builds `ss-sidecar:v{{SIDECAR_VERSION}}` from `Dockerfile.run` and runs it. The `--docker` flag forces the container path (Node mode would win otherwise on any Mac with Node ≥18 installed) and on macOS auto-defaults `SS_HOST_OLLAMA=1` + roles for embedding/completion/ocr so the gossip planner doesn't trim the registry. Install native Ollama first (see the **macOS host with native Ollama** section below) so those roles actually have a Metal-backed engine to serve them.

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

## macOS host with native Ollama (host-Ollama mode)

Docker Desktop on macOS has **no GPU passthrough** — anything running inside a container on a Mac is CPU-only and 10–30× slower than native Metal. The fix: run **Ollama natively on the Mac** (which uses Metal) and let the sidecar — running in Docker on that same Mac — orchestrate it via `host.docker.internal:11434`.

This unlocks an M-series Mac (e.g. M4 with 24 GB unified memory) as a fleet node for **embedding**, **completion**, and **OCR** roles. Reranker stays on a CUDA host (vLLM is CUDA-only).

### 1. Install Ollama natively on the Mac

```bash
brew install ollama
brew services start ollama

# Allow connections from Docker Desktop containers (host.docker.internal):
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
brew services restart ollama

# Verify the daemon is reachable on all interfaces:
curl -s http://localhost:11434/api/version
```

If you don't use Homebrew, download from [ollama.com/download/mac](https://ollama.com/download/mac) and set `OLLAMA_HOST=0.0.0.0:11434` in the Ollama app's settings (or via `launchctl setenv`).

### 2. Pre-pull the models you'll use

The sidecar can pull models on demand, but pulling them once up-front avoids the first-call wait:

```bash
ollama pull qwen3-embedding:0.6b   # or :4b for higher recall
ollama pull qwen3.5:9b             # completion (optional)
ollama pull richardyoung/olmocr2:7b-q8   # OCR (optional)
```

Models land in `~/.ollama/models` on the Mac's disk — not inside the sidecar container.

### 3. Verify from inside Docker Desktop

Pop into any container on the Mac and confirm Ollama is reachable:

```bash
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:latest \
  curl -s http://host.docker.internal:11434/api/tags
```

You should get a JSON list of installed models. If you see `connection refused`, re-check `OLLAMA_HOST` is set system-wide and the service is running.

### 4. Run the sidecar in host-Ollama mode

```bash
docker run -d --name ss-sidecar \
  --restart unless-stopped \
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} \
  -e SS_HOST_OLLAMA=1 \
  -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
  -e SS_HOST_OLLAMA_BUDGET_MB=16384 \
  -e HOST_OS=darwin \
  -v ss-sidecar-config:/app/config \
  ss-sidecar:latest
```

**Env vars specific to host-Ollama mode:**

| Var | Purpose |
|---|---|
| `SS_HOST_OLLAMA=1` | Turn on host-Ollama mode. Without this, the sidecar manages Docker containers normally. |
| `SS_HOST_OLLAMA_ROLES` | Comma-separated roles to route to the native Ollama (e.g. `embedding,completion,ocr`). Reranker is vLLM-only and must stay on a CUDA host. |
| `SS_HOST_OLLAMA_HOST` | Default `host.docker.internal`. Override only if you have a non-standard setup. |
| `SS_HOST_OLLAMA_BUDGET_MB` | Operator-declared VRAM budget for the host endpoint. On a 24 GB M4 leaving ~8 GB for macOS, set to `16384`. `0` = unknown (planner falls back to per-role declared budgets). |
| `HOST_OS=darwin` | Optional. The sidecar auto-detects Apple Silicon (aarch64) but the hint removes ambiguity for Intel Macs. |

### 5. Verify host-Ollama mode

```bash
curl http://localhost:{{SIDECAR_PORT}}/api/status | jq '{
  hostOllama, host
}'
```

Healthy output on a Mac:

```json
{
  "hostOllama": {
    "enabled": true,
    "host": "host.docker.internal",
    "roles": ["embedding", "completion", "ocr"],
    "budgetMb": 16384,
    "lastHealth": { "ok": true, "latencyMs": 12 }
  },
  "host": {
    "os": "darwin",
    "osConfidence": "env",
    "dockerDesktop": true
  }
}
```

The sidecar's GPU section will show `vramSource: "host-declared"` (because there's no `nvidia-smi` to query) and each host-runtime role's container status as `"running"` (synthesized — there's no Docker container for those roles).

#### Automated verifier (one-liner)

Download and run the verifier to confirm every step of the host-Ollama path — sidecar reachability, version, OS detection, host-Ollama health classifier, native Ollama on `:11434`, model pull via sidecar, VRAM load, master-side embedding round-trip, and idle eviction:

```bash
curl -fsSL {{SERVER}}/sideCar/scripts/verify-host-ollama.sh -o /tmp/verify-host-ollama.sh \
  && bash /tmp/verify-host-ollama.sh --master-url {{SERVER}}
```

Flags:

- `--master-url <URL>` — master to use for the manifest comparison and the embedding round-trip. Defaults to the sidecar's saved master.
- `--skip-idle` — skip the 5-minute idle-eviction wait (steps 1–9 only).
- `--role embedding|completion|ocr` — which role to pull/load (default `embedding`).
- `--verbose` — extra debug lines (curl bodies, poll progress).

Exit code is `0` if every check passes, `1` if any check failed. A clean run looks like:

```
[1/10] ✓ Sidecar reachable (status=200 at http://localhost:8098)
[2/10] ✓ Sidecar version (v2.2.73 matches master manifest)
[3/10] ✓ Host OS detected (darwin, confidence=env)
[4/10] ✓ Host-Ollama mode enabled
[5/10] ✓ Sidecar→host Ollama health probe OK (12ms)
[6/10] ✓ Native Ollama responds on host (version=0.1.34)
[7/10] ✓ Model pull/load via sidecar succeeded (role=embedding)
[8/10] ✓ Model loaded into VRAM (qwen3-embedding:0.6b, size_vram=638914560)
[9/10] ✓ Master returned embedding (dim=1024)
[10/10] ✓ Idle eviction confirmed (model no longer in /api/ps)

All checks passed.
```

### What's different in host-Ollama mode

- **No Docker containers** for `embedding` / `completion` / `ocr` on this host. The sidecar manages the **models inside the native Ollama** instead.
- **Pulling models**: still works (`POST /api/pull` on the host Ollama). Pull progress streams back to master via the existing task tracker. Files land in `~/.ollama/models` on the Mac.
- **Idle eviction**: when a role goes idle, the sidecar calls `keep_alive: 0` to evict that model from VRAM. **Other models loaded on the same Ollama keep their VRAM** — eviction is per-model, not per-process.
- **VRAM accounting**: `nvidia-smi` isn't available, so the sidecar trusts your declared `SS_HOST_OLLAMA_BUDGET_MB` plus `ollama ps` (which reports `size_vram` correctly on Metal).
- **Reranker** still requires a CUDA host. Run the reranker sidecar on a Linux+NVIDIA machine; the Mac sidecar handles only the Ollama roles.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `hostOllama.lastHealth.error: "dns"` | `host.docker.internal` doesn't resolve | Add `--add-host host.docker.internal:host-gateway` to the `docker run`, restart Docker Desktop |
| `hostOllama.lastHealth.error: "ollama_not_running"` | Ollama daemon not running on host | `brew services start ollama` |
| `hostOllama.lastHealth.error: "network"` | Firewall or wrong `OLLAMA_HOST` | Confirm `launchctl getenv OLLAMA_HOST` returns `0.0.0.0:11434`; restart Ollama |
| Embedding calls slow despite Mac being a fast machine | Models on CPU instead of Metal | From Mac terminal: `ollama ps` — check `PROCESSOR` column says `100% GPU`. If CPU, increase `OLLAMA_NUM_GPU` or check Ollama version is recent |
| Activity Monitor shows GPU usage but VRAM never drops | Idle timer not firing | Confirm `state.perRole[role].activeRequests` is 0 (via `/api/status`); reset via `POST /api/admin/gpu-reset` if leaked |

### 6. (Optional) Install the host-stats helper for live RAM reporting

By default the sidecar reports **Sound Suite inference memory** (sum of `size_vram` from `ollama ps` against your declared `SS_HOST_OLLAMA_BUDGET_MB`) on the master's `/admin/gpu` page. That answers "can I fit one more model?".

To *also* show **total macOS RAM, free RAM, and memory pressure** on that page, install the launchd helper. The sidecar inside Docker Desktop cannot read host RAM directly (the container's `/proc` reflects the VM, not macOS), so a tiny shell script on the Mac POSTs the numbers to the sidecar every 10 seconds.

```bash
# 1. Download the helper + plist
mkdir -p "$HOME/Library/Application Support/SoundSuite"
curl -fsSL {{SERVER}}/sideCar/scripts/report-host-stats.sh \
  -o "$HOME/Library/Application Support/SoundSuite/report-host-stats.sh"
chmod +x "$HOME/Library/Application Support/SoundSuite/report-host-stats.sh"

# 2. Sanity-check one POST manually (curl-only; no Xcode CLT prompts)
"$HOME/Library/Application Support/SoundSuite/report-host-stats.sh" --once

# 3. Install the launchd agent
curl -fsSL {{SERVER}}/sideCar/scripts/report-host-stats.plist \
  -o "$HOME/Library/LaunchAgents/ai.soundsuite.host-stats.plist"
# EDIT the plist: replace /Users/me/ with your actual home path
# (and adjust sidecar URL/port if it isn't http://localhost:8098)
launchctl load "$HOME/Library/LaunchAgents/ai.soundsuite.host-stats.plist"
```

Verify:

```bash
curl -s http://localhost:8098/api/status | jq '.host'
```

You should see:

```json
{
  "os": "darwin",
  "osConfidence": "env",
  "dockerDesktop": true,
  "stats": {
    "at": 1748623456789,
    "ageMs": 4321,
    "totalMb": 24576,
    "freeMb": 8192,
    "pressurePct": 38,
    "gpuName": "Apple M4 Pro",
    "gpuUtilPct": null,
    "source": "helper",
    "stale": false
  },
  "inferenceMemory": {
    "usedMb": 638,
    "budgetMb": 16384,
    "freeMb": 15746,
    "models": [
      { "name": "qwen3-embedding:0.6b", "role": "embedding", "sizeVramMb": 638 }
    ]
  }
}
```

If `stats.source` is `"docker-info"` or `"unknown"`, the helper isn't reaching the sidecar. Check:

- `tail -f /tmp/soundsuite-host-stats.{out,err}.log`
- `launchctl list | grep host-stats` (status `0` means launched; non-zero is the last exit code)
- The plist path inside `ProgramArguments` matches where you actually saved the script.

Uninstall:

```bash
launchctl unload "$HOME/Library/LaunchAgents/ai.soundsuite.host-stats.plist"
rm "$HOME/Library/LaunchAgents/ai.soundsuite.host-stats.plist"
rm -rf "$HOME/Library/Application Support/SoundSuite"
```

The helper uses only stock macOS tools (`bash`, `curl`, `sysctl`, `vm_stat`, `memory_pressure`). It does **not** require Homebrew, Xcode, or the Command Line Tools.

---

## macOS host with Docker Model Runner (vllm-metal)

As of Docker Desktop Feb 2026, Docker Model Runner (DMR) ships with **vllm-metal** — a native vLLM port for Apple Silicon that goes through Metal/MLX. This unlocks the **vLLM reranker** on a Mac (host-Ollama mode cannot run the reranker; DMR can).

### 1. Enable Docker Model Runner

In Docker Desktop:

1. **Settings → AI → Enable Docker Model Runner**
2. **Enable host-side TCP support** (port `12434` is the default)
3. Optionally set CORS origins if you need browser access

Verify from the Mac terminal:

```bash
docker model version
curl -s http://localhost:12434/engines/v1/models | jq
```

### 2. Pull the models you'll use

DMR has no auto-pull API — you must pull from the host CLI:

```bash
docker model pull ai/qwen3-reranker
docker model pull ai/qwen3-embedding
# or directly from HuggingFace:
docker model pull hf.co/Qwen/Qwen3-Reranker-8B
```

### 3. Run the sidecar in DMR mode

Reranker on DMR, embedding still on the LAN GPU host:

```bash
docker run -d --name ss-sidecar --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ss-sidecar-config:/app/config \
  -p 8098:8098 \
  -e SOUND_SUITE_MASTER_URL=https://your-master.example \
  -e SS_DMR=1 \
  -e SS_DMR_ROLES=reranker \
  -e SS_DMR_PORT=12434 \
  ss-sidecar:latest
```

You can mix DMR and host-Ollama in the same sidecar:

```bash
  -e SS_HOST_OLLAMA=1 \
  -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
  -e SS_DMR=1 \
  -e SS_DMR_ROLES=reranker \
```

### 4. Verify DMR mode

`GET /api/status` returns:

```json
{
  "dmr": {
    "enabled": true,
    "host": "host.docker.internal",
    "port": 12434,
    "roles": ["reranker"],
    "lastHealth": { "at": 1730000000000, "ok": true, "modelCount": 3 },
    "baseUrl": "http://host.docker.internal:12434/engines/v1"
  }
}
```

Each DMR role shows `containerStatus: "running"` (synthesized — no Docker container exists for these on this host).

### What's different in DMR mode

- **No Docker containers** for DMR roles on this host. DMR manages its own vllm-metal worker lifecycle.
- **No model pull from sidecar** — DMR has no /api/pull. Pull from the host CLI: `docker model pull <name>`.
- **No idle eviction** — DMR has no public unload API. Models stay resident until DMR's scheduler decides otherwise. Idle timers log a "model stays loaded" notice and bail.
- **Reranker works** on Mac — `/engines/vllm/v1/rerank` is real vLLM.
- **Master configuration**: point the master's reranker host at `http://<dmr-host>:12434/engines/vllm` (NOT through the sidecar — DMR's TCP port is opened on the Docker host directly).

### Open caveat

The master's reranker calls `${host}/v1/rerank`. DMR's vLLM rerank path is `/engines/vllm/v1/rerank` (or auto-select `/engines/v1/rerank`). To make the master's existing concatenation work, set:

```
rerankHost = http://<dmr-host>:12434/engines/vllm
```

so `${rerankHost}/v1/rerank` resolves correctly. The sidecar's `/api/status` reports `dmr.baseUrl` (`/engines/v1`, auto-select) for chat/embedding calls; reranker needs the `/engines/vllm` variant. Tracked as a future enhancement (sidecar could advertise per-role base URLs).

---

## Windows host with native Ollama

The same host-Ollama mode works on Windows with native Ollama (CUDA on NVIDIA, CPU otherwise). Docker Desktop on Windows likewise has no GPU passthrough for containers, so native Ollama is the right path on Windows hosts too.

### 1. Install Ollama natively on Windows

Download the installer from [ollama.com/download/windows](https://ollama.com/download/windows) and install.

Make it listen on all interfaces so Docker Desktop containers can reach it:

1. Open **System Properties → Environment Variables → System variables**
2. Add a new variable: `OLLAMA_HOST` = `0.0.0.0:11434`
3. Restart the **Ollama** service from `services.msc` (or sign out / back in).

Windows Defender Firewall will prompt on the first connection from a container — allow it for **private networks**.

Verify from PowerShell:

```powershell
Invoke-WebRequest -Uri http://localhost:11434/api/version -UseBasicParsing
```

### 2. Pre-pull models (optional)

```powershell
ollama pull qwen3-embedding:0.6b
ollama pull qwen3.5:9b
```

Models land in `C:\Users\<you>\.ollama\models`.

### 3. Run the sidecar in host-Ollama mode

```powershell
docker run -d --name ss-sidecar `
  --restart unless-stopped `
  -p {{SIDECAR_PORT}}:{{SIDECAR_PORT}} `
  -v /var/run/docker.sock:/var/run/docker.sock `
  --add-host host.docker.internal:host-gateway `
  -e SOUND_SUITE_MASTER_URL={{MASTER_URL}} `
  -e SS_HOST_OLLAMA=1 `
  -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr `
  -e SS_HOST_OLLAMA_BUDGET_MB=8192 `
  -e HOST_OS=win32 `
  -v ss-sidecar-config:/app/config `
  ss-sidecar:latest
```

Pick `SS_HOST_OLLAMA_BUDGET_MB` based on your NVIDIA card's VRAM minus what other apps need. On a 12 GB 3060, leaving ~4 GB for the desktop, set `8192`.

Verification is identical to the Mac path — check `/api/status.hostOllama` for `lastHealth.ok: true`.

### 4. Real-time GPU stats (recommended on Windows)

Docker Desktop on Windows runs containers in a Linux VM with **no GPU passthrough**, so the sidecar cannot read your NVIDIA card from inside its container. To populate the master's **Admin → GPU Fleet** page with live VRAM totals, install the host-side helper:

```powershell
# Download the helper from your master
Invoke-WebRequest -Uri {{MASTER_URL}}/sideCar/scripts/report-host-stats.ps1 `
  -OutFile "$env:USERPROFILE\report-host-stats.ps1"

# Register a Scheduled Task that runs at logon and polls every 10 s
schtasks /Create /SC ONLOGON /TN "SoundSuiteHostStats" `
  /TR "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File $env:USERPROFILE\report-host-stats.ps1" /F

# Run it now without waiting for the next logon
schtasks /Run /TN "SoundSuiteHostStats"
```

The script auto-detects `nvidia-smi.exe` (System32 or PATH) and reports the GPU name, total/used/free VRAM, temperature, and per-process attribution (e.g. `ollama.exe`) every 10 seconds. On a CPU-only or AMD host it still reports CPU and RAM so the master sees a non-empty host card with a clear "no GPU" indicator.

Override the sidecar URL or polling interval via env if needed:

```powershell
$env:SS_SIDECAR_URL='http://localhost:8098'   # default
$env:SS_REPORT_INTERVAL_SECONDS='10'          # 5..60
```

Verify:

```powershell
Invoke-RestMethod http://localhost:{{SIDECAR_PORT}}/api/status |
  Select-Object -ExpandProperty host
```

You should see `hasNvidia: True`, `stats.source: report-host-stats.ps1@1.0`, and `gpus[0].memoryTotal` populated.

```bash
# From the master host:
curl -s http://<windows-host>:{{SIDECAR_PORT}}/api/status | jq '.gpus, .host'
```

Expected output:

```json
[
  {
    "index": 0,
    "name": "NVIDIA GeForce RTX 4090",
    "memoryTotal": 24564,
    "memoryUsed": 1872,
    "memoryFree": 22692,
    "temperature": 42,
    "processes": [
      { "pid": 12340, "name": "ollama.exe", "usedMemory": 1500 }
    ]
  }
]
{
  "os": "win32",
  "osConfidence": "env",
  "dockerDesktop": true,
  "hasNvidia": true,
  "stats": { "source": "report-host-stats.ps1@1.0", "totalMb": 65336, "freeMb": 41204, ... },
  "gpus": [ ... ]
}
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

The container's `/app/config/` directory (or `./sidecar/config/` for native installs) is preserved across updates. Even if the volume is wiped completely, the `SOUND_SUITE_MASTER_URL` env var or the saved `serverUrl` in `sidecar.config.json` lets the sidecar reconnect on next boot.

### Migrating from an anonymous volume

Older installs (sidecar < 2.3.11) ran `docker run` without `-v ss-sidecar-config:/app/config`, so Docker created an **anonymous** volume. That volume survives `docker restart` but is garbage-collected the moment the container is removed (`docker rm`, which `install.sh` and many "restart" flows do under the covers). The new launcher scripts always mount the **named** volume `ss-sidecar-config`, which survives container removal and persists until you explicitly run `docker volume rm`.

If you previously installed without `-v`, export your existing config before recreating the container so you don't lose your master list:

```bash
docker exec ss-sidecar cat /app/config/config.json > sidecar-config-backup.json
docker stop ss-sidecar && docker rm ss-sidecar
# then re-run start.sh (or install.sh) — it will recreate with the named volume
./sidecar/start.sh {{MASTER_URL}}
# restore by editing in the dashboard, or:
docker cp sidecar-config-backup.json ss-sidecar:/app/config/config.json
docker restart ss-sidecar
```

You can also always recover from total volume loss by passing the masters at start:

```bash
docker run ... -e SIDECAR_MASTERS="http://master-a:3000,http://master-b:3000|3002" ...
```

To re-run the installer manually (e.g. for a major version bump):

```bash
./sidecar/install.sh {{MASTER_URL}}
```

---

## Uninstall

### Native install

```bash
docker stop ss-sidecar && docker rm ss-sidecar 2>/dev/null
rm -rf ./sidecar
```

(Or whatever path you set `INSTALL_DIR` to.)

### Docker install

```bash
docker stop ss-sidecar && docker rm ss-sidecar
docker volume rm ss-sidecar-config
```

Then remove the sidecar entry from **Admin → GPU Fleet** to stop master from trying to reach it.
