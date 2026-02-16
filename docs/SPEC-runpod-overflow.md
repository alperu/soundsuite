# RunPod Overflow GPU — Design Spec

## Problem

When local GPU infrastructure (e.g. a single RTX A6000 48GB) is fully loaded — all VRAM allocated to active containers — incoming requests either queue or fail. There's no automatic overflow to handle demand spikes (indexing large document batches, concurrent search + OCR, etc.).

Additionally, mode switching is manual. If a user kicks off an indexing job while in searching mode, they must manually switch modes and wait for containers to reconfigure.

## Goals

1. **RunPod overflow**: When local GPU is saturated, automatically route excess work to RunPod cloud GPUs. Shut them down when demand subsides. Pay per-second, zero idle cost.
2. **Auto mode switching**: The orchestrator should detect workload and switch modes automatically. Indexing has higher priority than searching (if indexing work is queued, switch to indexing mode).
3. **Admin RunPod settings page**: Configure API key, GPU preferences, cost limits, and per-role overflow toggles.

---

## Part 1: Auto Mode Switching

### Current State

- Mode is set manually via sidecar dashboard or admin GPU fleet page
- `switchMode()` in `sideCar/src/lib/containers.ts` handles container start/stop
- Modes: `indexing` (embedding + OCR) and `searching` (embedding + completion + reranker)
- Embedding is shared across both modes

### Design

**Server-side orchestrator** (not sidecar) decides the mode based on workload signals:

```
Signals:
  - Job queue depth (QUEUED + PROCESSING documents in Prisma)
  - Active search requests (from fleet-router activeRequests tracking)
  - User-initiated indexing (manual scan, file watcher events)

Priority: indexing > searching

Rules:
  1. If job queue has QUEUED documents → switch to indexing
  2. If no queued work for 2 minutes → switch back to searching
  3. Hysteresis: don't flip-flop — require stable signal for 30s before switching
  4. Manual override: admin can lock mode (disable auto-switching)
```

### New File: `src/lib/gpu/mode-scheduler.ts`

```typescript
interface ModeSchedulerConfig {
  enabled: boolean;           // gpu.autoModeSwitch config key
  indexingPriority: boolean;  // true = indexing wins ties (default true)
  switchDelay: number;        // ms to wait before confirming switch (default 30000)
  idleBeforeSearch: number;   // ms with no indexing work before returning to search (default 120000)
}

// Runs on 10-second interval
// Checks: prisma.document.count({ where: { status: 'QUEUED' } })
// Checks: fleet-router active request counts per role
// Emits mode switch commands to all connected sidecars
```

### Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `gpu.autoModeSwitch` | boolean | `false` | Enable automatic mode switching |
| `gpu.modeSwitchDelay` | number | `30` | Seconds to wait before confirming switch |
| `gpu.indexingIdleTimeout` | number | `120` | Seconds with no queued docs before returning to searching |

---

## Part 2: RunPod Integration

### Service Choice: **Serverless** (primary) + **Pods** (fallback)

After research, RunPod offers two viable paths:

| Factor | Serverless | GPU Pods |
|--------|-----------|----------|
| Billing | Per-second of compute | Per-second while running |
| Idle cost | Zero (scales to 0) | Zero when stopped (small storage fee) |
| Spin-up | Auto on request, <200ms FlashBoot + model load | Manual via API, ~30-60s |
| Docker | Custom image with handler | Any Docker image (Ollama, vLLM directly) |
| Scaling | Auto 0→N workers | Fixed, manual scaling |
| API | REST (simple) | GraphQL (more complex) |
| Best for | Steady overflow traffic | Burst + full control |

**Recommendation**:

- **Serverless** for embedding + reranking (stateless, high-throughput, auto-scales)
- **GPU Pod** for completion + OCR (longer-running, stateful, model-heavy)

### GPU Selection

For our model sizes:

| Role | Model | VRAM Need | Recommended GPU | RunPod Price |
|------|-------|-----------|----------------|--------------|
| embedding | qwen3-embedding:0.6b | 1.2 GB | RTX 4090 (24GB) | ~$0.00077/s ($2.77/hr) |
| completion | qwen3.5:14b | 12 GB | RTX 4090 (24GB) | ~$0.00077/s ($2.77/hr) |
| ocr | olmocr2:7b-q8 | 8 GB | RTX 4090 (24GB) | ~$0.00077/s ($2.77/hr) |
| reranker | Qwen3-Reranker-8B | 7 GB | RTX 4090 (24GB) | ~$0.00077/s ($2.77/hr) |

**RTX 4090 (24GB)** is the sweet spot — handles all our models, cheapest per-second rate. A single pod can run multiple roles if needed.

### Architecture Overview

```
                         ┌─────────────────────────┐
                         │   Sound Suite Server     │
                         │                          │
                         │  fleet-router.ts          │
                         │    resolveEndpoint()      │
                         │      │                    │
                         │      ├── 1. Local sidecar │──→ RTX A6000
                         │      │   (check VRAM)     │
                         │      │                    │
                         │      └── 2. RunPod        │──→ Cloud GPU
                         │          (overflow)       │
                         │                           │
                         │  runpod-provider.ts       │
                         │    startPod() / stopPod() │
                         │    routeRequest()         │
                         └───────────────────────────┘
```

### Integration Point: `resolveEndpoint()` Extension

Current flow in `fleet-router.ts`:
1. Check cache for running container → return if found
2. Try to acquire on idle sidecar → start container
3. Try all sidecars (even disconnected)
4. **NEW: Phase 4** → Route to RunPod if all local sidecars saturated

```typescript
// Phase 4: RunPod overflow
if (config.runpodEnabled && config[`runpod.overflow.${role}`]) {
  const runpod = await import('./runpod-provider');
  const endpoint = await runpod.getOrCreateEndpoint(role);
  if (endpoint) {
    return { host: endpoint.url, sidecarUrl: 'runpod', role, isCloud: true };
  }
}
```

### New Files

#### `src/lib/gpu/runpod-provider.ts`

Core RunPod integration. Two strategies based on role:

```typescript
// ─── Serverless Strategy ─────────────────────────────────
// For embedding + reranking: deploy as serverless endpoints
// Zero idle cost, auto-scales, per-second billing

interface ServerlessEndpoint {
  id: string;
  role: GpuRole;
  status: 'idle' | 'active' | 'error';
  url: string;               // https://api.runpod.ai/v2/{endpoint_id}
  workersActive: number;
  workersMax: number;
}

async function ensureServerlessEndpoint(role: GpuRole): Promise<ServerlessEndpoint>
async function invokeServerless(endpointId: string, input: unknown): Promise<unknown>
async function scaleDown(endpointId: string): Promise<void>  // Set max workers to 0

// ─── Pod Strategy ────────────────────────────────────────
// For completion + OCR: full Docker container with Ollama
// Start on demand, stop when idle

interface PodInstance {
  id: string;
  role: GpuRole;
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  host: string;              // pod-{id}-{port}.proxy.runpod.net
  gpu: string;               // 'NVIDIA RTX 4090'
  costPerSec: number;
  startedAt: number;
  lastRequestAt: number;
}

async function startPod(role: GpuRole): Promise<PodInstance>
async function stopPod(podId: string): Promise<void>
async function getPodStatus(podId: string): Promise<PodInstance>
```

#### `src/lib/gpu/runpod-api.ts`

Low-level RunPod API client:

```typescript
// RunPod uses GraphQL for pod management, REST for serverless
const GRAPHQL_URL = 'https://api.runpod.io/graphql';
const SERVERLESS_URL = 'https://api.runpod.ai/v2';

// Pod operations (GraphQL)
async function createPod(config: PodConfig): Promise<string>    // Returns pod ID
async function resumePod(podId: string): Promise<void>
async function stopPod(podId: string): Promise<void>
async function terminatePod(podId: string): Promise<void>
async function listPods(): Promise<PodInfo[]>
async function getGpuAvailability(): Promise<GpuStock[]>

// Serverless operations (REST)
async function createEndpoint(config: EndpointConfig): Promise<string>
async function runSync(endpointId: string, input: unknown): Promise<unknown>
async function runAsync(endpointId: string, input: unknown): Promise<string>  // Job ID
async function getJobStatus(endpointId: string, jobId: string): Promise<JobResult>
async function getEndpointHealth(endpointId: string): Promise<HealthInfo>

// Account
async function getBalance(): Promise<{ balance: number; spent: number }>
```

#### `src/lib/gpu/runpod-idle-monitor.ts`

Watches RunPod instances and shuts them down when idle:

```typescript
// Runs every 30 seconds
// Checks lastRequestAt for each active pod
// If idle > configuredTimeout (default 5 min) → stop pod
// If serverless endpoint has 0 requests for 10 min → scale to 0 workers
// Tracks cost accumulation and enforces hourly/daily spend limits
```

### RunPod Docker Images

We need custom Docker images for RunPod:

| Role | Base Image | Entrypoint | Notes |
|------|-----------|------------|-------|
| embedding | `ollama/ollama` | Ollama + auto-pull model | Serverless handler wraps `/api/embed` |
| completion | `ollama/ollama` | Ollama + auto-pull model | Pod with Ollama, standard API |
| ocr | `ollama/ollama` | Ollama + auto-pull model | Pod with Ollama, standard API |
| reranker | `vllm/vllm-openai` | vLLM with model args | Serverless handler wraps `/v1/rerank` |

For **Pods**, we can use the standard images directly (Ollama, vLLM) since pods give us full Docker control. The pod proxy URL exposes the container ports.

For **Serverless**, we need a thin wrapper. RunPod provides `runpod` Python SDK with a handler pattern:

```python
# serverless_handler.py (for embedding)
import runpod
import requests

def handler(event):
    input_data = event["input"]
    # Forward to local Ollama inside the container
    resp = requests.post("http://localhost:11434/api/embed", json=input_data)
    return resp.json()

runpod.serverless.start({"handler": handler})
```

**Alternative (simpler)**: Use RunPod's **Proxy Endpoint** feature — it routes HTTP directly to your container's HTTP server without needing a handler. This works perfectly with Ollama and vLLM since they already expose HTTP APIs.

---

## Part 3: Admin RunPod Settings Page

### Tab: `runpod` (new admin tab)

#### UI Layout

```
┌─────────────────────────────────────────────────────┐
│ RunPod Cloud GPU Overflow                           │
│                                                     │
│ ┌─ Connection ─────────────────────────────────────┐│
│ │ API Key: [••••••••••••••••••] [Test Connection]  ││
│ │ Status: ● Connected  Balance: $142.37            ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Overflow Settings ─────────────────────────────┐│
│ │ ☑ Enable RunPod overflow                        ││
│ │                                                  ││
│ │ Preferred GPU: [RTX 4090 (24GB) ▾]              ││
│ │ Fallback GPU:  [RTX 3090 (24GB) ▾]              ││
│ │                                                  ││
│ │ Strategy: ○ Serverless (auto-scale, zero idle)  ││
│ │           ● Pods (full Docker, more control)     ││
│ │           ○ Hybrid (serverless for embed/rerank, ││
│ │                     pods for completion/OCR)      ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Per-Role Overflow ─────────────────────────────┐│
│ │                                                  ││
│ │ Role        Overflow   Idle Timeout   Status     ││
│ │ ─────────── ────────── ──────────── ──────────── ││
│ │ Embedding   [☑]        [5] min      ● Local     ││
│ │ Completion  [☑]        [5] min      ● Local     ││
│ │ OCR         [☐]        [5] min      ○ Disabled  ││
│ │ Reranker    [☑]        [5] min      ● Local     ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Cost Controls ─────────────────────────────────┐│
│ │ Max hourly spend:  $[10.00]                      ││
│ │ Max daily spend:   $[50.00]                      ││
│ │ Max monthly spend: $[500.00]                     ││
│ │                                                  ││
│ │ Today's spend: $3.42  This month: $47.20        ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Active Instances ──────────────────────────────┐│
│ │ (empty — no RunPod instances active)            ││
│ │                                                  ││
│ │ When overflow triggers, active pods/endpoints    ││
│ │ will appear here with live cost tracking.        ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ [Save Settings]                                     │
└─────────────────────────────────────────────────────┘
```

### Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runpod.apiKey` | string | `''` | RunPod API key (encrypted at rest) |
| `runpod.enabled` | boolean | `false` | Master enable for RunPod overflow |
| `runpod.preferredGpu` | string | `'NVIDIA RTX 4090'` | Primary GPU type to request |
| `runpod.fallbackGpu` | string | `'NVIDIA RTX 3090'` | Fallback if preferred unavailable |
| `runpod.strategy` | string | `'pods'` | `'serverless'` / `'pods'` / `'hybrid'` |
| `runpod.overflow.embedding` | boolean | `true` | Allow embedding overflow to RunPod |
| `runpod.overflow.completion` | boolean | `true` | Allow completion overflow to RunPod |
| `runpod.overflow.ocr` | boolean | `false` | Allow OCR overflow to RunPod |
| `runpod.overflow.reranker` | boolean | `true` | Allow reranker overflow to RunPod |
| `runpod.idleTimeout` | number | `5` | Minutes before stopping idle RunPod instance |
| `runpod.maxHourlySpend` | number | `10` | Cost guard: max $/hour |
| `runpod.maxDailySpend` | number | `50` | Cost guard: max $/day |
| `runpod.maxMonthlySpend` | number | `500` | Cost guard: max $/month |

### API Route: `src/app/api/admin/runpod/route.ts`

```typescript
// GET  — Return current config + active instances + balance
// POST — Actions:
//   action: 'save'         — Save RunPod settings
//   action: 'test'         — Test API key, return balance + GPU availability
//   action: 'stopAll'      — Emergency stop all RunPod instances
//   action: 'getInstances' — List active pods/endpoints
//   action: 'stopInstance' — Stop a specific instance
```

---

## Part 4: End-to-End Overflow Flow

### Trigger: `resolveEndpoint('completion')` called, all local sidecars busy

```
1. fleet-router checks local sidecars → all at capacity
2. fleet-router checks RunPod config → enabled, completion overflow = true
3. runpod-provider.getOrCreateEndpoint('completion')
   a. Check if a RunPod pod for 'completion' already running → return its URL
   b. Check cost limits → abort if over budget
   c. Check GPU availability → RTX 4090 in stock?
   d. Start pod: createPod({ gpu: 'NVIDIA RTX 4090', image: 'ollama/ollama', ... })
   e. Wait for pod ready (poll status, ~30-60s)
   f. Return proxy URL: https://pod-{id}-11435.proxy.runpod.net
4. fleet-router returns { host: proxyUrl, isCloud: true }
5. Caller uses host for Ollama API request (same API, different host)
6. releaseEndpoint() → runpod-idle-monitor tracks last request time
7. After 5 min idle → stopPod()
```

### Cost Protection Flow

```
Before starting any RunPod instance:
  1. Query current spend (tracked in DB or RunPod API)
  2. If hourly spend >= maxHourlySpend → reject, queue locally
  3. If daily spend >= maxDailySpend → reject, queue locally
  4. If monthly spend >= maxMonthlySpend → reject, queue locally
  5. Log warning at 80% threshold
```

---

## Part 5: File Inventory

### New Files

| File | Purpose |
|------|---------|
| `src/lib/gpu/runpod-api.ts` | Low-level RunPod GraphQL + REST client |
| `src/lib/gpu/runpod-provider.ts` | High-level pod/serverless lifecycle management |
| `src/lib/gpu/runpod-idle-monitor.ts` | Idle detection + auto-shutdown + cost tracking |
| `src/lib/gpu/mode-scheduler.ts` | Auto mode switching based on workload |
| `src/components/admin-runpod-settings.tsx` | RunPod admin UI component |
| `src/app/api/admin/runpod/route.ts` | RunPod admin API endpoint |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/gpu/fleet-router.ts` | Add Phase 4 RunPod overflow in `resolveEndpoint()` |
| `src/lib/db/config.ts` | Add `runpod.*` and `gpu.autoModeSwitch` config keys |
| `src/components/admin-dashboard.tsx` | Add `runpod` tab |
| `src/app/admin/[[...tab]]/page.tsx` | Add `'runpod'` to `VALID_TABS` |

---

## Implementation Order

1. **Phase A** — Auto mode switching (standalone, no RunPod dependency)
   - `mode-scheduler.ts` + config keys + admin toggle in GPU Fleet page

2. **Phase B** — RunPod API client + admin page (config only, no routing)
   - `runpod-api.ts` + `admin-runpod-settings.tsx` + API route
   - Test connection, view balance, verify API key works

3. **Phase C** — RunPod provider + fleet-router integration
   - `runpod-provider.ts` + modify `resolveEndpoint()`
   - Pod creation, status tracking, proxy URL routing

4. **Phase D** — Idle monitor + cost controls
   - `runpod-idle-monitor.ts` + spend tracking + auto-shutdown
   - Cost limit enforcement, alerts at 80% threshold

5. **Phase E** — Serverless endpoints (optional optimization)
   - Custom Docker images for serverless handler
   - Deploy embedding + reranker as serverless for lower latency
