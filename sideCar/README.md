# SideCar for LLMs

A small agent you run on a machine with a GPU. It lets a remote application use
that GPU for embeddings, completions, OCR, reranking and recursive-LM work —
without that application needing to run on the GPU box, or know anything about
Docker, Ollama, vLLM or VRAM budgeting.

One sidecar per GPU host. Any number of applications ("masters") can share it.

```
  ┌──────────────┐        WebSocket + HTTP        ┌──────────────────────────┐
  │   master     │ ────────────────────────────▶  │  sidecar  (this repo)    │
  │  (your app)  │ ◀───── 5 s heartbeat ───────── │  :8098                   │
  └──────────────┘                                │                          │
                                                  │  ├─ ollama  :11434-11437 │
  ┌──────────────┐                                │  ├─ vLLM    :8099, :8100 │
  │ another      │ ────────────────────────────▶  │  └─ nvidia-smi accounting│
  │ master       │                                └──────────────────────────┘
  └──────────────┘
```

The sidecar does not decide what to run. It reports what it has, starts and stops
model containers on request, tracks VRAM, and refuses work it cannot do on the
GPU. Scheduling stays with the master.

## Why this exists

Running inference next to your application is convenient until it isn't: the GPU
box is usually not the box your app runs on, GPU passthrough on macOS and Windows
Docker is unavailable or partial, and VRAM is a shared resource that two
processes will happily fight over.

The sidecar makes the GPU a service with a contract:

- **It answers what it actually observes**, not what it was configured to have.
  A role nothing has probed is reported as unknown, never as healthy.
- **It accounts for VRAM**, so a second master cannot silently evict the first
  master's resident model.
- **It refuses rather than degrades.** A role marked `gpuOnly` is not served from
  CPU offload just because that would technically answer.

## Quick start

### Docker (Linux host with NVIDIA runtime)

```bash
docker run -d --name ss-sidecar \
  -p 8098:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e MASTER_URL=http://192.0.2.10:3000 \
  ss-sidecar:v2.3.76
```

### macOS or Windows host (native Ollama, no GPU passthrough)

Docker Desktop cannot pass a Metal or, in most setups, a CUDA device through to a
container. Run Ollama natively on the host and point the sidecar at it:

```bash
# one-time, on the host
brew install ollama && brew services start ollama
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
ollama pull qwen3-embedding:4b

docker run -d --name ss-sidecar \
  -p 8098:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e MASTER_URL=http://192.0.2.10:3000 \
  -e SS_HOST_OLLAMA=1 \
  -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
  -e SS_HOST_OLLAMA_BUDGET_MB=16384 \
  -e HOST_OS=darwin \
  ss-sidecar:v2.3.76
```

Then open `http://<gpu-host>:8098` for the dashboard.

Full installation paths — tarball, Windows service, auto-update — are in
[`docs/setup.md`](docs/setup.md).

## Roles

A *role* is a named inference capability with a port, a VRAM budget and a
runtime. These are the defaults; models are configurable per role.

| Role | Port | VRAM budget | Runtime | Notes |
|---|---|---|---|---|
| `embedding` | 11434 | ~1.2 GB | Ollama | small, cheap to keep resident |
| `code-embedding` | 11437 | ~2 GB | Ollama | separate model for code |
| `completion` | 11435 | ~10 GB | Ollama | chat / generation |
| `ocr` | 11436 | ~8 GB | Ollama | **`gpuOnly`** — never CPU-offloaded |
| `reranker` | 8099 | ~7 GB | vLLM | cross-encoder reranking |
| `rlm` | 8100 | ~34 GB | vLLM | recursive-LM evidence loops |
| `cuda` | — | — | utility | GPU presence / diagnostics only |

Containers are named `ss-<role>` (`ss-embedding`, `ss-ocr`, …).

Two runtimes, and the difference matters when you read health:

- **Ollama** exposes `/api/tags` and `/api/ps`, so the sidecar can ask which
  models are actually resident.
- **vLLM** has no per-model endpoint. Liveness for `reranker` and `rlm` is
  inferred from `nvidia-smi` PID attribution, or confirmed by a bounded
  `GET /v1/models` probe. **Inferred is reported as inferred.**

## How a master uses it

1. **Discover** — `GET /status` returns roles, container states, loaded models,
   VRAM accounting and per-role active request counts.
2. **Acquire** — `POST /acquire {role}` ensures the role is running and resets its
   idle timer. Returns the endpoint to call.
3. **Infer** — the master calls the model endpoint **directly**. Inference traffic
   does not proxy through the sidecar.
4. **Release** — `POST /release {role}` decrements the active count so the idle
   timer can eventually stop the container.

A master registers over WebSocket (`ws://<master>:<wsPort>/sidecar`) and
heartbeats every 5 seconds. If the WebSocket is unavailable it falls back to HTTP
gossip, so a sidecar behind a restrictive network still works.

Full endpoint reference: [`docs/API.md`](docs/API.md).

## Multiple masters

A single sidecar serves several applications at once. Each master is tracked
independently with its own connection mode, heartbeat and reconnect backoff, and
each sees the same VRAM accounting — so one master starting a 34 GB model is
visible to the others rather than silently starving them.

Add masters with `SIDECAR_MASTERS`, or from the dashboard.

## Documentation

| Document | Contents |
|---|---|
| [`docs/setup.md`](docs/setup.md) | Installation, starting, auto-updates, dependency checks |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works: connection model, roles, VRAM, idle timers, failure modes |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Every environment variable, with defaults and why each exists |
| [`docs/API.md`](docs/API.md) | Endpoint reference |

## Development

```bash
npm install
npm run dev     # http://localhost:8098
npm run build
npm start
```

Next.js 15 + React 19 + TypeScript. The only runtime dependency beyond the
framework is `ws`.

## Design rules this codebase follows

These are not style preferences. Each came from a defect that shipped.

1. **Unreported is not down.** A host that declares a container and returns no
   status has told you nothing about it. Never collapse "no answer" into
   "unhealthy".
2. **A claim names its basis.** "Role X is live" must say what was probed. A
   synthetic status the sidecar assumed is labelled as assumed, not laundered
   into an observation.
3. **Describe the action, not the outcome, before the outcome exists.** A status
   line emitted before a probe completes cannot report what the probe found.
4. **Refuse rather than degrade quietly.** A `gpuOnly` role served from CPU
   offload is a slow success that reads as a fast one.

## Provenance

The sidecar is developed inside [Sound Suite](https://soundsuite.ai) and mirrored
here so it can be used on its own. The upstream copy lives in that repository's
`sideCar/` directory; this repository is a subtree of it and shares its history.
Fixes flow upstream-first.

## Licence

[Project Sandstar Source-Available License (PSSL) v1.1](LICENSE) — the same
licence the rest of Project Sandstar uses, with a section added for this
component.

**Source-available, not open source.** In short:

- **Free**, including commercially, when the applications requesting inference
  from SideCar are Licensor applications — the Fantom MCP Server, the Axon MCP
  Server, Sound Suite, or software within a Project Sandstar deployment. Use it on
  as many hosts as you like. Read, modify and redistribute it under §2.
- **A commercial licence is required** to serve inference to third-party or
  other-vendor applications, or to resell or broker that inference.

The test is the **requesting application**, not the data. SideCar consumes no
point values or control data, so the Packet Rule that governs the other Licensed
Software (§3.2) does not apply here — §1.7.1, §1.8.1 and §3.1.1 state the
SideCar-specific test instead.

Read [LICENSE](LICENSE) for the binding terms; this summary is not one.
