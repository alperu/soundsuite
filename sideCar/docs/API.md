# API reference

All endpoints are on the sidecar, default `http://<gpu-host>:8098`. JSON in, JSON
out. There is no authentication — **the sidecar is not safe to expose to an
untrusted network.** It can start processes, read GPU state, and — since
`POST /restart` — restart its own container; keep it on a private network or a VPN.

## Lifecycle

### `POST /acquire`

Ensure a role is running and claim it.

```json
{ "role": "embedding" }
```

Starts the container if needed, resets the role's idle timer, and increments
`activeRequests`. Returns the endpoint to call for inference.

A cold role pays its start-up cost inside this call. For vLLM roles that can be
tens of seconds — set your client timeout accordingly, and do not assume
`/acquire` is fast.

Fails rather than degrades when the role is `gpuOnly` and only CPU-offloaded
capacity is available.

### `POST /release`

```json
{ "role": "embedding" }
```

Decrements `activeRequests` so the idle timer can arm. **Always call this**, including on
error paths. A lost release pins VRAM: the timer never arms, the container never
stops, and other roles starve.

Callers should treat it as fire-and-forget — a failed release must not fail the
request it followed.

### `POST /start` · `POST /stop`

```json
{ "role": "ocr" }
```

Explicit container control, bypassing acquire/release accounting. For operators and
dashboards; a scheduler should use `/acquire` and `/release`.

### `POST /touch`

```json
{ "role": "rlm" }
```

Reset a role's idle timer without claiming it. For a master that knows it will need
the role shortly and wants to avoid a cold start.

### `POST /reset-counters`

Zero the per-role `activeRequests`. The recovery path for leaked counts after a
master crashed mid-request.

Use deliberately: zeroing while a long job is genuinely in flight lets the idle
timer stop a container out from under it, turning a bookkeeping problem into a
failed job.

## State

### `GET /status`

The main endpoint. Everything a master needs to route:

```jsonc
{
  "agentUrl": "http://192.0.2.20:8098",
  "hostname": "gpu-1",
  "version": "2.3.76",
  "mode": "indexing",
  "uptime": 2443,
  "containers": {
    "embedding": {
      "exists": true,
      "status": "running",        // may be SYNTHETIC — see ARCHITECTURE.md
      "name": "ss-embedding",
      "image": "host-ollama",     // 'host-ollama' / 'dmr' indicate a synthetic status
      "loadedModels": [ /* Ollama only */ ],
      "config": { "port": 11434, "model": "…", "gpuOnly": false },
      "gpuReady": true
    }
  },
  "vram": {
    "totalMb": 24576, "freeMb": 12000, "usedMb": 12576,
    "perRole": {
      "embedding": { "loaded": true, "actualMb": 1200, "budgetMb": 1200,
                     "runtime": "ollama", "priority": "high", "gpuOnly": false }
    }
  },
  "roles": {
    "embedding": { "activeRequests": 0, "idleTimerActive": true,
                   "lastAcquire": "…", "lastRelease": "…" }
  },
  "gpus": [ { "index": 0, "name": "…", "memoryTotal": 24576 } ]
}
```

Reading it correctly:

- **`vram.perRole[role].loaded`** is the residency signal. `containers[role].status`
  can be synthetic.
- **`image: 'host-ollama'` or `'dmr'`** means the status was assumed, not probed.
- **`gpuReady: false`** on a `gpuOnly` role means it will answer, slowly. Treat it as
  unavailable.
- **Absent** is not the same as **down**. A role missing from `containers` tells you
  nothing about whether that capability exists on the host.

### `GET /health`

Liveness only. Cheap, no Docker or GPU calls — safe to poll.

### `GET /gpu`

`nvidia-smi` output: devices, memory, utilisation, per-PID attribution. Empty on
hosts without `nvidia-smi` (macOS, Windows without CUDA tooling) — empty means
*unknown*, not *no GPU*.

### `GET /containers`

Container inventory with state and images. `/status` is usually what you want.

### `GET /logs?role=<role>&tail=<n>`

Container logs for a role. Useful for diagnosing a model that starts and
immediately exits.

### `GET /host-stats` · `GET /host-os` · `GET /host-backend`

Host CPU/memory, detected OS, and which runtime backend is active
(containers / host-Ollama / DMR).

### `GET /setup-status`

Dependency check: Docker reachable, NVIDIA runtime present, host Ollama reachable,
DMR enabled. What the dashboard's setup page reads.

### `GET /diag/volume-mount`

Verifies the Docker socket mount actually works. First thing to check when every
container operation fails with permission errors.

## Configuration

### `GET /config` · `POST /config`

Read and update persisted configuration — models per role, idle timeouts, runtime
selection. Changes apply live where possible.

### `GET /mode` · `POST /mode`

The workload mode (`indexing`, `searching`), which selects a coherent role set
rather than individual containers.

### `POST /provision`

Pull models and prepare containers for the current mode. Long-running; poll
`/status` for progress rather than holding the connection.

## Masters

### `GET /masters` · `POST /masters`

List and add master connections. Each entry carries its URL, `wsPort`, connection
mode and last heartbeat.

### `GET /masters/[serverUrl]` · `DELETE /masters/[serverUrl]`

Inspect or remove one master. The URL is path-encoded.

`mode: 'disconnected'` with a fresh heartbeat is **normal** — the WebSocket is down
and HTTP gossip is carrying the connection. It is not an error state.

### `POST /ws-connect` · `POST /ws-disconnect`

Force a WebSocket reconnect or drop to HTTP gossip. Diagnostic; normal operation
manages this itself.

## Updates

### `POST /update`

Update the sidecar in place from its master's build manifest, preserving
configuration. `version` in `/status` lets a master spot a fleet on mixed builds —
worth checking when two hosts that should behave identically do not.

### `GET /restart` · `POST /restart`

Restart **the sidecar's own container**. Restarting the sidecar has more than once
been the thing that actually cleared a stuck state, and it otherwise needs shell
access to the host — which is exactly what an operator lacks when a host is
misbehaving.

**Not** the Docker engine. A container cannot restart the daemon it runs on, and on
macOS/Windows that daemon lives in a VM it has no authority over. Engine
start/stop/restart is a separate operator action over SSH (OliveTin
`build/docker/docker-ctl.sh`).

`GET` returns feasibility so a UI can disable the control with a reason:

```json
{ "canRestart": true,
  "target": { "id": "<64-hex>", "shortId": "<12-hex>", "name": "ss-sidecar",
              "identifiedBy": "mountinfo", "corroborated": true } }
```

`POST` returns **`202`** with the same `target`, then issues the restart ~250 ms
later so the response can flush. The `202` reports that the request was accepted,
**not that the restart succeeded** — once the daemon kills the container nothing
can be sent, so the only proof is the sidecar coming back. Poll `/status` and wait
for a *different* `bootEpoch`; a reachable `/status` alone may still be the
pre-restart process answering.

**The target is resolved from the runtime, never from `CONTAINER_NAME`.** That env
var names a managed *model* container (it defaults to `vllm-reranker`, and
`/status` reads it as the reranker), so trusting it would aim the restart at a
sibling. Resolution reads the container ID out of `/proc/self/mountinfo` — Docker
bind-mounts `/etc/hostname` from `/var/lib/docker/containers/<64-hex>/`, and
nothing inside the container can forge that — and corroborates it against the
in-container hostname, which Docker defaults to the 12-hex short ID.

Refusals are `409` with a named `reason` and a `detail` that says what was missing
or what disagreed:

| `reason` | Meaning |
|---|---|
| `docker-unreachable` | No usable Docker socket. Mount `/var/run/docker.sock` or set `DOCKER_HOST`. |
| `not-in-container` | Running bare-metal on the host — there is no container to restart. |
| `self-unresolvable` | In a container, but its ID could not be determined, or Docker has no such container. |
| `sources-disagree` | mountinfo and the hostname name different containers, or mountinfo names several. Never guesses. |
| `resolved-is-managed` | The resolved container is one this sidecar manages. Names both identities and the managed set. |

Operator-initiated only. Nothing in the sidecar triggers this on a condition: a
self-restart loop on a remote host is very hard to break.

Two consequences worth knowing. A restart does **not** restart the model
containers — host-Ollama and Docker Model Runner roles are unaffected by design,
so a restart aimed at clearing a stuck *model* will look like it did nothing. And
it discards in-memory `activeRequests` accounting while the masters' view of it
survives; `POST /reset-counters` is the remedy.

## The WebSocket protocol

Sidecar → master, on `ws://<master>:<wsPort>/sidecar`:

```jsonc
{ "type": "register",  "agentUrl": "…", "hostname": "…", "containers": [ … ] }
{ "type": "heartbeat", "containers": { … }, "activeRequests": 0, "roles": { … } }
```

Master → sidecar: commands with an `id`, answered with a matching result.

Notes for anyone implementing the master side:

- Heartbeats arrive every **5 s**. Treat a gap of a few intervals as stale, not as
  proof of death.
- A sidecar **reconnects** on its own (exponential backoff to a 5-minute ceiling),
  and forces a reconnect after three failed heartbeats. Expect a new socket for the
  same `agentUrl` and handle supersession: close the old socket, and guard your close
  handler on socket identity so closing a superseded socket does not tear down the
  live one.
- Bound the handshake. A socket that connects and never sends `register` belongs to
  nobody, answers pings, and will otherwise be held forever.
- Add ping/pong liveness. `close` only fires on a TCP FIN; a host that loses power
  or a VPN that drops sends nothing, and the socket stays `ESTABLISHED` indefinitely.
