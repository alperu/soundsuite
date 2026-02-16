# TODO: GPU Container Orchestrator — Fleet-Based Scalable Management

> **Status**: Core implementation complete (Tasks 0-8). Fleet router, API, admin UI, multi-container sidecar agent, and provider wiring all implemented.

## Context

GPU workloads (embedding, completion, OCR, reranking) total ~56GB VRAM — they can't all run simultaneously on a single 48GB GPU. Currently Ollama runs as a native app, the vLLM reranker is Dockerized with a sidecar agent.

**Goal**: Dockerize all GPU workloads. Each GPU machine runs a sidecar agent that manages its local Docker containers. Next.js acts as the **central router** — it knows all sidecars, their GPU capacity, and their running containers. When a request needs a GPU workload, Next.js routes it to the best available sidecar/container based on demand and availability.

## Scaling Model

| GPUs | Strategy | How It Works |
|------|----------|--------------|
| **1 GPU** | Mode-based switching | Indexing mode (Embedding+OCR) vs Searching mode (Embedding+Completion+Reranker). Only one workload set at a time. |
| **2-4 GPUs** | Dedicated assignment | Each model pinned to its own GPU via `NVIDIA_VISIBLE_DEVICES`. All concurrent. |
| **Many GPUs** | Scaled instances | Multiple instances of the same model (e.g., 2x completion on 2 GPUs) for concurrent users. Agent load-balances. |

## Architecture

```
Mac (Next.js :3000)
┌─────────────────────────────────────┐
│  Fleet Router                        │
│  ├─ Sidecar registry (admin config) │
│  ├─ Request routing (role → best IP)│
│  ├─ GPU status cache (polls /gpu)   │
│  └─ On-demand startup (/acquire)    │
│                                      │
│  GPU Orchestrator tab (admin UI)     │
│  ├─ Sidecar list + add/remove       │
│  ├─ Per-sidecar GPU topology        │
│  ├─ Container grid + Start/Stop     │
│  └─ Mode selector (1-GPU machines)  │
└──────┬──────────┬──────────┬────────┘
       │          │          │
       ▼          ▼          ▼
  Sidecar A    Sidecar B   Sidecar C
  (1x A6000)  (2x 4090)   (1x A100)
  :8098        :8098        :8098
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │embed    │ │embed    │ │completion│
  │completion│ │completion│ │reranker │
  │reranker │ │ocr      │ │         │
  └─────────┘ └─────────┘ └─────────┘
```

## Container Definitions

| Role | Image | Model | Port | VRAM | Modes |
|------|-------|-------|------|------|-------|
| Embedding | `ollama/ollama` | `qwen3-embedding:0.6b` | 11434 | ~1.2GB | Both |
| Completion | `ollama/ollama` | configurable | 11435 | ~40GB | Searching |
| OCR | `ollama/ollama` | `olmocr2:7b-q8` | 11436 | ~8GB | Indexing |
| Reranker | `vllm/vllm-openai` | `Qwen3-Reranker-8B` | 8099 | ~7GB | Searching |

Container naming: `ll-embedding`, `ll-completion`, `ll-ocr`, `ll-reranker`.

## Implementation Tasks

### Task 0: Fix stale path references ✅

Files referencing old `scripts/start-docker-agent.bat` path need updating to `sideCar/scripts/start-docker-agent.bat`:
- `src/components/admin-reranking-settings.tsx`
- `src/app/api/admin/agent-test/route.ts`
- `docs/vllm-reranker-setup.md`

### Task 1: Extend `sideCar/server.js` — Multi-Container Orchestrator ✅

Refactor from single-container to multi-container orchestrator.

**1a. Container Registry** — Replace single `CONTAINER_NAME` with configurable registry (role → image, model, port, VRAM, modes, type).

**1b. GPU Discovery & Placement** — nvidia-smi via transient container to discover GPUs. Bin-pack containers onto GPUs. Pin via `DeviceRequests.DeviceIDs`.

**1c. New Docker Socket Helpers**:
- `dockerRequestWithBody(method, path, body)` — POST with JSON
- `createContainer(role)` — Docker API create with GPU, ports, volumes
- `execInContainer(name, cmd)` — Docker exec for `ollama pull <model>`
- `pullImage(image)` — Pull Docker images

**1d. New Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Agent alive check (existing) |
| `GET` | `/status` | All containers + mode + VRAM (enhanced) |
| `GET` | `/gpu` | nvidia-smi VRAM info per GPU |
| `GET` | `/containers` | All managed containers with status |
| `POST` | `/mode` | Switch mode `{ mode: 'indexing' | 'searching' }` |
| `POST` | `/provision` | Pull images, create containers, pull models (idempotent) |
| `POST` | `/acquire` | `{ role }` — start if needed, reset idle timer |
| `POST` | `/release` | `{ role }` — decrement count, start idle timer |
| `POST` | `/start` | `{ role }` — manual start |
| `POST` | `/stop` | `{ role }` — manual stop |
| `POST` | `/config` | Registry overrides, per-role idle timeouts |

**1e. Mode Switching** (1-GPU only):
1. Start containers needed for new mode
2. Drain containers not needed (10s timeout)
3. Stop drained containers
4. Embedding never stops

With 2+ GPUs: modes unnecessary, all concurrent.

### Task 2: Update Dockerfile and Start Scripts ✅

- `sideCar/Dockerfile` — `node:20-slim` base
- `sideCar/scripts/start-docker-agent.bat/.sh` — update messages

### Task 3: Config Schema + Sidecar Fleet Registry ✅

**`src/lib/db/config.ts`** — Add:
```ts
gpuMode: 'indexing' | 'searching';
gpuAutoManage: boolean;
gpuSidecars: string; // comma-separated sidecar URLs
gpuIdleEmbeddingMin: number;   // 0 = never stop
gpuIdleCompletionMin: number;
gpuIdleOcrMin: number;
gpuIdleRerankerMin: number;
```

### Task 4: Fleet Router — `src/lib/gpu/fleet-router.ts` (New) ✅

Central routing: picks best sidecar for a given role.
- `resolveEndpoint(role)` → `{ host, port }` of best available container
- `releaseEndpoint(role, sidecarUrl)` → fire-and-forget release
- `getFleetStatus()` → all sidecars, GPUs, containers
- Routing algorithm: find sidecar with running container for role → least loaded. If none, pick sidecar with most free VRAM → `/acquire`.

### Task 5: API Route — `/api/admin/gpu-fleet/route.ts` (New) ✅

Proxies to fleet router and individual sidecars:
- `GET ?action=fleet` → fleet status
- `POST { action: 'mode', sidecar, mode }` → switch mode
- `POST { action: 'provision', sidecar }` → provision containers
- `POST { action: 'start'|'stop', sidecar, role }` → control containers

### Task 6: Admin UI — GPU Fleet Tab (New) ✅

`src/components/admin-gpu-orchestrator.tsx`:
1. **Sidecar Fleet** — List with Add/Remove, status badges, GPU count
2. **Per-Sidecar Detail** — GPU topology cards (VRAM bars, temperature, pinned containers), mode selector (1-GPU only)
3. **Container Grid** — All containers across sidecars, grouped by role, with Start/Stop
4. **Per-Model Idle Timeouts** — Configurable per role (embedding, completion, OCR, reranker)
5. **Provision Button** — Per-sidecar initial setup

Add `'gpu'` to `VALID_TABS` in `src/app/admin/[[...tab]]/page.tsx`.

### Task 7: Wire Up Providers via Fleet Router ✅

- `src/services/worker-init.ts` — Embedding/OCR resolve via fleet router
- `src/lib/ai/ai-provider.ts` — Completion resolves via fleet router
- `src/lib/search/reranker-lifecycle.ts` — Reranker resolves via fleet router

### Task 8: Docs ✅

- Update `docs/vllm-reranker-setup.md` with orchestrator setup section
- Fix stale path references

## Files Summary

| File | Action |
|------|--------|
| `sideCar/server.js` | ✅ **Major rewrite** — multi-container orchestrator with GPU discovery |
| `sideCar/Dockerfile` | ✅ No changes needed (node:22-alpine works) |
| `sideCar/scripts/start-docker-agent.bat` | ✅ Updated messages |
| `sideCar/scripts/start-docker-agent.sh` | ✅ Updated messages |
| `src/lib/db/config.ts` | ✅ Added gpuMode, gpuAutoManage |
| `src/lib/gpu/fleet-router.ts` | ✅ **New** — fleet router with resolveEndpoint/releaseEndpoint |
| `src/app/api/admin/gpu-fleet/route.ts` | ✅ **New** — fleet API (named gpu-fleet, not gpu-orchestrator) |
| `src/components/admin-gpu-fleet.tsx` | ✅ **New** — GPU tab UI with topology, mode, containers, provision |
| `src/app/admin/[[...tab]]/page.tsx` | ✅ Added `gpu` tab |
| `src/components/admin-dashboard.tsx` | ✅ Added GPU Fleet tab entry, docs, import, render |
| `src/services/worker-init.ts` | ✅ OCR + embedding resolve via fleet router |
| `src/lib/ai/ai-provider.ts` | ✅ Completion resolve via fleet router |
| `src/lib/search/reranker-lifecycle.ts` | ✅ Reranker resolve + release via fleet router |
| `docs/vllm-reranker-setup.md` | ✅ Added GPU Fleet Orchestrator section |

## Notes

- **Backward compatibility**: If `gpuSidecars` is empty, everything works as before.
- **Shared Ollama volume**: All Ollama containers mount `ollama-models:/root/.ollama`.
- **Agent is stateless**: Rediscovers GPUs and container status on restart.
- **Sidecar auto-registration** (future): Sidecars could call a Next.js webhook on startup.
