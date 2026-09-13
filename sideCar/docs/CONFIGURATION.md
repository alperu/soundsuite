# Configuration

Every environment variable the sidecar reads, with its default and the reason it
exists. Nothing here is required except a way to reach a master.

Configuration is also editable from the dashboard at `http://<host>:8098`, and is
persisted so it survives container recreation.

## Identity and networking

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `AGENT_PORT` | `3000` in container, published as `8098` | Port the sidecar listens on. |
| `AGENT_URL` | derived | The URL masters should call back on. Set it when autodetection guesses wrong — behind NAT, or on a host with several interfaces. |
| `EXTERNAL_IP` / `SS_EXTERNAL_IP` | autodetected | Address advertised to masters. Same reason as `AGENT_URL`. |
| `SIDECAR_HOSTNAME` | OS hostname | Label shown in master UIs. `COMPUTERNAME` is used on Windows. |
| `HOST_OS` | detected from Docker `/info` | `darwin` / `win32` / `linux`. Only a hint; detection usually suffices. |

## Connecting to masters

| Variable | Default | Purpose |
|---|---|---|
| `MASTER_URL` / `SERVER_URL` / `SOUND_SUITE_MASTER_URL` | — | The master to register with. Three names exist for backward compatibility; prefer `MASTER_URL`. |
| `SIDECAR_MASTERS` | — | Comma-separated list for **multiple masters**, e.g. `http://a:3000,http://b:3848`. |
| `SIDECAR_MASTER_HOSTS` | — | Host-only form; ports are inferred. |
| `SS_DISCOVERY_DISABLED` | unset | Set to disable master autodiscovery and accept only what you configured. Use this on a shared network where you do not want the sidecar volunteering itself. |
| `RECENT_MASTERS_PATH` | alongside config | Where the recently-seen master list is cached, so the sidecar reconnects after a restart without reconfiguration. |

### WebSocket port

The master's WebSocket port is per-master, not global, and defaults to **3002**.
A master that consolidates HTTP and WebSocket on one port should have its
`wsPort` set explicitly. There is no reliable convention mapping an HTTP port to a
WebSocket port — do not assume `port + 2`.

## Storage

| Variable | Default | Purpose |
|---|---|---|
| `CONFIG_PATH` / `SIDECAR_CONFIG_PATH` | platform-specific | Persisted configuration. Mount this if you want settings to survive `docker rm`. |
| `CONTAINER_NAME` | `ss-sidecar` | The sidecar's own container name, used for self-update. |
| `DOCKER_HOST` | unix socket | Standard Docker variable; set it for a remote or non-default daemon. |

## Runtime: containers (default)

No configuration needed. The sidecar manages `ss-<role>` containers through the
mounted Docker socket. Requires:

```
-v /var/run/docker.sock:/var/run/docker.sock
```

On Linux with an NVIDIA GPU, the NVIDIA container runtime must be installed for
containers to see the device.

## Runtime: host Ollama

For **macOS and Windows hosts**, where Docker Desktop cannot pass the GPU through
but native Ollama can use Metal or CUDA directly.

| Variable | Default | Purpose |
|---|---|---|
| `SS_HOST_OLLAMA` | off | `1` enables host-Ollama mode. |
| `SS_HOST_OLLAMA_ROLES` | — | Comma-separated roles served by host Ollama. Only `ollama`-type roles qualify — `reranker` and `rlm` are vLLM and cannot be served this way. |
| `SS_HOST_OLLAMA_HOST` | `host.docker.internal` | Where the host Ollama listens. |
| `SS_HOST_OLLAMA_PORT` | `11434` | Host Ollama port. |
| `SS_HOST_OLLAMA_BUDGET_MB` | `0` (unknown) | Operator-declared VRAM budget. `nvidia-smi` does not exist on macOS, so without this the planner falls back to each role's declared footprint and reports `vramSource: unknown`. On a 24 GB Mac, `16384` leaves headroom for the OS. |

Host setup, one time:

```bash
# macOS
brew install ollama && brew services start ollama
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
ollama pull qwen3-embedding:4b
```

```powershell
# Windows: install from ollama.com, then
setx OLLAMA_HOST "0.0.0.0:11434" /M
# restart the Ollama service
```

**Behaviour changes in this mode.** Container state becomes a synthetic
`{status:'running'}` (see [ARCHITECTURE](ARCHITECTURE.md#the-synthetic-running--read-this-before-trusting-status)),
pulls and loads hit the host endpoint, and the idle timer unloads the model with
`keep_alive: 0` instead of stopping a container — so other models on the same
Ollama keep their VRAM.

## Runtime: Docker Model Runner

A third runtime. On Apple Silicon this means **vllm-metal** — real vLLM via
MLX/Metal, including `/engines/vllm/v1/rerank`, which host Ollama cannot do.

| Variable | Default | Purpose |
|---|---|---|
| `SS_DMR` | off | `1` enables DMR mode. |
| `SS_DMR_ROLES` | — | Roles routed to DMR. Works for any role; `reranker` is the compelling case. |
| `SS_DMR_HOST` | `host.docker.internal` | DMR host. |
| `SS_DMR_PORT` | `12434` | Requires Docker Desktop → AI → *Enable host-side TCP*. |
| `SS_DMR_BUDGET_MB` | `0` | Informational; DMR manages its own eviction. |

Models must be pulled on the host — `docker model pull <model>`. The sidecar does
not auto-pull for DMR.

DMR has no unload API, so idle timers are a no-op for these roles.

### Combining runtimes

Mixing is supported and often correct — reranking via DMR, embeddings via host
Ollama:

```
-e SS_HOST_OLLAMA=1 -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
-e SS_DMR=1 -e SS_DMR_ROLES=reranker -e SS_DMR_PORT=12434
```

## Lifecycle

| Variable | Default | Purpose |
|---|---|---|
| `IDLE_TIMEOUT_MS` | per role | How long a role stays up with no active requests. Raise it if cold starts hurt more than idle VRAM does. |
| `LOG_LEVEL` | `info` | `debug` for connection and routing detail. |

## Restart policy

The sidecar container has no restart policy by default, so a host reboot leaves it
down. Set one:

```bash
docker update --restart unless-stopped ss-sidecar
```

`unless-stopped` rather than `always`, so an operator who stopped it deliberately
is respected.

## What is not configurable, and why

**Role ports.** `embedding` is 11434, `reranker` is 8099, and so on. These are part
of the contract a master routes against; a per-host override would mean every
master needed per-host knowledge. Masters read the port from
`containers[role].config.port` rather than assuming, so if this ever becomes
configurable, correct masters will keep working.

**VRAM budgets per role.** Declared in the role registry, because they describe the
model, not the host. Host capacity is expressed with `SS_HOST_OLLAMA_BUDGET_MB`.

Note that a VRAM figure is a memory footprint, not a request ceiling. Do not derive
a concurrency limit from it.
