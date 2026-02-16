# Sidecar Gossip Protocol — Architecture Spec

## Problem

The server cannot reach sidecars directly (different subnets, NAT, Docker networking).
Current `sendToSidecar()` push model fails: "Sidecar http://10.10.20.5:8098 is unreachable".

## Solution: Gossip Protocol (Sidecar-Initiated Communication)

All connections are **outbound from sidecar**. Server never initiates connections to sidecars.

```
Sidecar ──WS connect──→ Server:3002   (primary, real-time)
Sidecar ──HTTP poll───→ Server:3000   (fallback, when WS is down)
Server  ──commands────→ via WS push or queued for poll
```

## Communication Channels

### Primary: WebSocket (existing, repurposed)

Sidecar connects outbound to `ws://<server>:3002/sidecar`.
Server pushes commands DOWN the same connection. No port 3002 exposure needed on sidecar.

```
Sidecar → Server:  register, heartbeat (with full status), command results
Server → Sidecar:  commands (start, stop, provision, config, mode, acquire, release)
```

### Fallback: HTTP Command Queue

When WS is down, sidecar polls for commands via HTTP:

```
POST /api/admin/gpu/sidecars/poll     ← sidecar fetches pending commands
POST /api/admin/gpu/sidecars/result   ← sidecar reports results
POST /api/admin/gpu/sidecars/heartbeat ← sidecar reports full status (already exists)
```

## Server-Side Changes

### 1. Command Queue (new)

**DB Table: `SidecarCommand`**
```
id          String   @id @default(uuid)
sidecarUrl  String               -- target sidecar agentUrl
action      String               -- start, stop, provision, mode, config, acquire, release, gpu
payload     String   @default("{}") -- JSON: { role, mode, idleTimeouts, ... }
status      String   @default("pending") -- pending, dispatched, completed, failed, expired
result      String?              -- JSON response from sidecar
createdAt   DateTime @default(now())
updatedAt   DateTime @updatedAt
expiresAt   DateTime             -- auto-expire after 60s (prevent stale commands)
```

### 2. Refactor `sendToSidecar()` → `queueSidecarCommand()`

**Old flow:** Server → HTTP fetch to sidecar → wait for response
**New flow:**
1. Try WS tunnel first (if sidecar has active WS connection) — real-time, <100ms
2. If no WS: insert command into `SidecarCommand` table with status=pending
3. Return a promise that resolves when sidecar reports the result (via poll+result or WS)
4. Timeout after 30s (120s for provision)

```typescript
async function queueSidecarCommand(
  agentUrl: string,
  action: string,
  payload?: object,
  timeoutMs = 30_000
): Promise<any> {
  // 1. Try WS tunnel (instant if connected)
  if (wsRelay.hasSidecarConnection(agentUrl)) {
    return wsRelay.sendCommand(agentUrl, { action, ...payload }, timeoutMs);
  }

  // 2. Queue for HTTP poll pickup
  const cmd = await prisma.sidecarCommand.create({
    data: {
      sidecarUrl: agentUrl,
      action,
      payload: JSON.stringify(payload || {}),
      status: 'pending',
      expiresAt: new Date(Date.now() + timeoutMs),
    },
  });

  // 3. Wait for result (poll by sidecar → result reported back)
  return waitForCommandResult(cmd.id, timeoutMs);
}
```

### 3. Expand Heartbeat

Current heartbeat only sends `{ agentUrl, containers, activeRequests }`.
Expand to include **full status** so server never needs to query sidecar:

```typescript
// Sidecar sends on every heartbeat (every 5s):
{
  agentUrl: "http://10.10.20.5:8098",
  hostname: "gpu-box-1",
  version: "2.0.20",
  mode: "searching",
  containers: {
    embedding: { status: "running", image: "ollama/ollama", port: 11434 },
    reranker: { status: "created", image: "vllm/vllm-openai", port: 8099 },
    // ...
  },
  activeRequests: 2,
  idleTimeouts: { embedding: 0, completion: 600000, ... },
  peakDemand: { embedding: 3, reranker: 1 },
  gpus: [{ name: "RTX 4090", memoryTotal: 24576, memoryFree: 18000, ... }],
  uptime: 3600
}
```

Server caches this in memory (Map<agentUrl, CachedStatus>) + persists to DB.
Admin UI reads cached status — no push to sidecar needed for status display.

### 4. New API Routes

**POST `/api/admin/gpu/sidecars/poll`**
```typescript
// Sidecar calls this every 3-5s when WS is down
// Request: { agentUrl: string }
// Response: { commands: [{ id, action, payload }] }
// Server marks returned commands as "dispatched"
```

**POST `/api/admin/gpu/sidecars/result`**
```typescript
// Sidecar reports command execution result
// Request: { commandId: string, result: object, error?: string }
// Server resolves the waiting promise for that command
```

### 5. Admin UI: Cached Status + Async Commands

- **Status display:** Read from server-cached heartbeat data (no sidecar reach needed)
- **Start/Stop/Provision buttons:** Queue command → show "pending..." → update when result arrives
- **Sidecar dashboard proxy:** Embed sidecar status/logs in admin UI via cached heartbeat data + command queue
- **Logs:** Sidecar streams logs via WS; server buffers last N lines per sidecar

## Sidecar-Side Changes

### 1. Replace `ws-client.ts` with Gossip Client

```typescript
// gossip-client.ts — unified communication module

// Primary: WebSocket (outbound to server)
// - Send heartbeat every 5s (full status + containers + GPU)
// - Receive commands, execute, send results back
// - Exponential backoff reconnect on disconnect

// Fallback: HTTP poll (when WS is down)
// - POST /heartbeat every 5s
// - POST /poll every 3s to fetch pending commands
// - POST /result to report execution results

// Startup sequence:
// 1. Load config (server URL, mode, registry)
// 2. Auto-provision all containers for current mode (pull + create, don't start)
// 3. Connect to server via WS (or start HTTP poll)
// 4. Begin heartbeat loop
```

### 2. Auto-Provision on Startup

On boot, sidecar:
1. Reads mode from config (default: `searching`)
2. For each role in that mode's container list:
   - Check if Docker image exists → `docker images` API
   - If not: pull image (can take minutes for vllm)
   - Check if container exists → `docker inspect`
   - If not: create container (don't start)
3. Report provisioned state in first heartbeat

```typescript
async function autoProvision(): Promise<void> {
  const roles = containersForMode(state.currentMode);
  for (const role of roles) {
    const def = state.registry[role];
    // Check if image exists locally
    const hasImage = await imageExists(def.image);
    if (!hasImage) {
      log.info(`Pulling image ${def.image} for ${role}...`);
      await pullImage(def.image);
    }
    // Check if container exists
    const cs = await getContainerState(def.containerName);
    if (!cs.exists) {
      log.info(`Creating container ${def.containerName} for ${role}...`);
      await createContainer(role);
    }
    log.info(`${role}: provisioned (image: ${def.image}, container: ${def.containerName})`);
  }
}
```

### 3. VRAM-Aware Container Start

Before starting a container, check available GPU VRAM:

```typescript
async function canStartContainer(role: string): Promise<{ ok: boolean; reason?: string }> {
  const def = state.registry[role];
  const gpus = await discoverGpus();
  if (gpus.length === 0) return { ok: false, reason: 'No GPU detected' };

  const gpu = gpus[0]; // Single GPU assumption for now
  if (gpu.memoryFree < def.vram) {
    return {
      ok: false,
      reason: `Need ${def.vram}MB VRAM but only ${gpu.memoryFree}MB free on ${gpu.name}`,
    };
  }
  return { ok: true };
}
```

### 4. Command Execution

Sidecar receives commands (via WS push or HTTP poll) and executes locally:

```typescript
async function executeCommand(cmd: { id: string; action: string; payload: any }): Promise<any> {
  switch (cmd.action) {
    case 'start':
      const check = await canStartContainer(cmd.payload.role);
      if (!check.ok) return { error: check.reason };
      return handleStart(cmd.payload.role);

    case 'stop':
      return handleStop(cmd.payload.role);

    case 'provision':
      return provisionContainers();

    case 'mode':
      return switchMode(cmd.payload.mode);

    case 'config':
      // Apply idle timeouts, registry updates, etc.
      return applyConfig(cmd.payload);

    case 'acquire':
      const vramCheck = await canStartContainer(cmd.payload.role);
      if (!vramCheck.ok) return { error: vramCheck.reason };
      return handleAcquire(cmd.payload.role);

    case 'release':
      return handleRelease(cmd.payload.role);

    case 'gpu':
      return { gpus: await discoverGpus() };

    default:
      return { error: `Unknown action: ${cmd.action}` };
  }
}
```

## Admin UI: Sidecar Dashboard Proxy

### Approach: Server-Side Aggregation

Instead of embedding an iframe (requires sidecar reachability), the admin UI shows sidecar data from **server-cached heartbeats**:

```
Admin GPU Fleet page:
├── Sidecar List (from cached heartbeats)
│   ├── Hostname, IP, Status, Last Seen
│   └── Select sidecar → detail panel
├── Selected Sidecar Detail
│   ├── GPU Info (from heartbeat cache)
│   ├── Container Table (from heartbeat cache)
│   │   ├── Role, Image, Status, VRAM, Port
│   │   └── Start/Stop buttons → queue command
│   ├── Mode Selector → queue mode command
│   ├── Provision button → queue provision command
│   └── Activity Log (streamed via WS)
└── Fleet-Wide Settings
    ├── Idle Timeouts → queue config to all
    ├── Min Online → sidecar self-enforces
    └── Auto-Manage toggle
```

### Log Streaming

Sidecar sends log entries up the WS connection:
```json
{ "type": "log", "level": "info", "category": "containers", "message": "Starting ss-reranker...", "ts": "..." }
```
Server buffers last 200 entries per sidecar. Admin UI subscribes via SSE or WS.

## Sequence Diagrams

### Start Container (via WS)
```
Admin UI → POST /api/admin/gpu-fleet { action: "start", url, role: "reranker" }
Server   → wsRelay.sendCommand(url, { action: "start", role: "reranker" })
           (pushed down existing WS connection)
Sidecar  ← receives command via WS
Sidecar  → check VRAM (7000MB needed, 18000MB free → OK)
Sidecar  → docker start ss-reranker
Sidecar  → WS send: { type: "result", id, status: "running" }
Server   → resolves promise → returns to admin UI
Admin UI ← { status: "running", message: "ss-reranker started" }
```

### Start Container (WS down, HTTP fallback)
```
Admin UI → POST /api/admin/gpu-fleet { action: "start", url, role: "reranker" }
Server   → no WS connection → INSERT INTO SidecarCommand (pending)
Server   → wait for result (up to 30s)...

Sidecar  → POST /poll { agentUrl }
Server   → returns [{ id: "cmd-123", action: "start", payload: { role: "reranker" } }]
Sidecar  → check VRAM → docker start
Sidecar  → POST /result { commandId: "cmd-123", result: { status: "running" } }
Server   → resolves waiting promise → returns to admin UI
Admin UI ← { status: "running" }
```

### Auto-Provision on Startup
```
Sidecar boots → reads config (mode: searching)
  → roles for searching: [embedding, completion, reranker]
  → pull ollama/ollama (if not cached)
  → pull vllm/vllm-openai (if not cached)
  → create ss-embedding (if not exists)
  → create ss-completion (if not exists)
  → create ss-reranker (if not exists)
  → connect WS to server
  → first heartbeat reports: all containers "created" (not running)
  → server caches status
  → admin UI shows containers as "provisioned" (yellow badge)
```

## Task Breakdown

### Phase 1: Server Command Queue (foundation)
- [ ] **T1.1** Add `SidecarCommand` model to Prisma schema
- [ ] **T1.2** Create `/api/admin/gpu/sidecars/poll` route
- [ ] **T1.3** Create `/api/admin/gpu/sidecars/result` route
- [ ] **T1.4** Add `waitForCommandResult()` utility with timeout
- [ ] **T1.5** Add expired command cleanup (cron or on-poll)

### Phase 2: Expand Heartbeat + Status Cache
- [ ] **T2.1** Expand heartbeat route to accept full status payload
- [ ] **T2.2** Create server-side `SidecarStatusCache` (in-memory Map + DB persist)
- [ ] **T2.3** Update `getFleetStatus()` to read from cache instead of pushing to sidecars
- [ ] **T2.4** Update admin UI to use cached status data

### Phase 3: Refactor `sendToSidecar()` → `queueSidecarCommand()`
- [ ] **T3.1** Create `queueSidecarCommand()` function (WS-first, queue fallback)
- [ ] **T3.2** Replace all `sendToSidecar()` calls in fleet-router.ts
- [ ] **T3.3** Replace all `sendToSidecar()` calls in gpu-fleet/route.ts
- [ ] **T3.4** Update `resolveEndpoint()` to use cached status + queue acquire
- [ ] **T3.5** Update `releaseEndpoint()` to use queue
- [ ] **T3.6** Move `enforceMinOnline()` config to sidecar (push via command)

### Phase 4: Sidecar Gossip Client
- [ ] **T4.1** Create `gossip-client.ts` (replaces ws-client.ts)
  - WS primary with heartbeat (5s)
  - HTTP poll fallback (3s)
  - Command execution + result reporting
- [ ] **T4.2** Add auto-provision on startup (pull + create, don't start)
- [ ] **T4.3** Add VRAM checking before container start
- [ ] **T4.4** Add log streaming via WS ({ type: "log", ... })
- [ ] **T4.5** Self-enforce min-online based on server-pushed config

### Phase 5: Admin UI Enhancement
- [ ] **T5.1** Show sidecar status from cache (no direct sidecar calls)
- [ ] **T5.2** Add "pending" state for async commands
- [ ] **T5.3** Show sidecar logs in admin panel (from WS log stream)
- [ ] **T5.4** VRAM display per sidecar (from cached GPU info)
- [ ] **T5.5** Provision status indicator (provisioned vs started vs not-provisioned)

### Phase 6: Cleanup
- [ ] **T6.1** Remove direct HTTP push from `sendToSidecar()`
- [ ] **T6.2** Remove old sidecar HTTP fallback registration code
- [ ] **T6.3** Update sidecar build script + version bump
- [ ] **T6.4** Update setup docs

## Migration Strategy

1. Build command queue + poll endpoints (server-side, backward compatible)
2. Build new gossip client in sidecar (alongside old ws-client)
3. Switch sidecar to gossip client
4. Verify everything works
5. Remove old push code
6. Build and deploy new sidecar tarball
