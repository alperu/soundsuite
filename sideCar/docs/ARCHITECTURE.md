# Architecture

How the sidecar works, and — more usefully — where it can mislead you if you read
its output carelessly.

## The shape of the system

```
        master                                sidecar host
  ┌────────────────┐                   ┌──────────────────────────────┐
  │                │  1. WS register   │  Next.js app  :8098          │
  │  scheduler     │ ─────────────────▶│                              │
  │  (your app)    │                   │  ├── /status   /acquire      │
  │                │◀── 2. heartbeat ──│  ├── /release  /start /stop   │
  │                │      every 5 s    │  └── idle timers, VRAM       │
  └───────┬────────┘                   └──────────┬───────────────────┘
          │                                       │ docker / host API
          │  3. inference goes DIRECT             ▼
          │     (never through the sidecar)  ┌─────────────────────────┐
          └─────────────────────────────────▶│ ollama :11434 … :11437  │
                                             │ vLLM   :8099, :8100     │
                                             └─────────────────────────┘
```

The sidecar is a **control plane**, not a data plane. It starts and stops model
containers and reports state. Inference bytes never pass through it, which is why
a busy sidecar stays responsive and why its uptime is not on your latency path.

## Connection model

A sidecar connects **outbound** to each master. Masters do not need to reach the
sidecar to establish the link, which is what makes a sidecar behind NAT usable.

Two transports, in preference order:

1. **WebSocket** — `ws://<master>:<wsPort>/sidecar`, default `wsPort` 3002. The
   sidecar sends `{type:'register', agentUrl, hostname, containers}` and then
   `{type:'heartbeat', …}` every 5 seconds. Commands travel master→sidecar on the
   same socket.
2. **HTTP gossip** — if the WebSocket cannot be established or drops, the sidecar
   POSTs the same heartbeat payload and polls for commands. Slower, but it works
   through proxies that mangle upgrades.

`mode` in `/status` tells you which is in use: `websocket`, `http`, or
`disconnected`. **`disconnected` with a fresh `lastHeartbeat` is normal** — it
means the WebSocket is down and HTTP gossip is carrying the connection.

### Reconnect behaviour

On WebSocket loss the sidecar retries with exponential backoff, doubling to a
5-minute ceiling. It never gives up: a sidecar booted while its master is down
will connect when the master appears.

Three failed WebSocket heartbeats force a reconnect. This matters for a subtle
reason covered under [Failure modes](#failure-modes): the socket can be dead
without either end being told.

## Roles, containers and modes

A role is a capability, not a process. `GET /status` reports per role:

| Field | Meaning |
|---|---|
| `status` | container state as reported — `running`, `not_found`, `error` |
| `loadedModels` | from Ollama's `/api/ps`; **absent for vLLM roles** |
| `config.port` | the port to call for inference |
| `config.gpuOnly` | routing must reject CPU-offloaded fallback |
| `gpuReady` | false when a `gpuOnly` role is partially CPU-offloaded |

`modes` (`indexing`, `searching`) group roles by workload so a master can bring up
a coherent set rather than individual containers.

### The synthetic `running` — read this before trusting status

For **host-Ollama** and **Docker Model Runner** roles there is no container to
inspect. The sidecar reports a synthesised `{status: 'running'}` so that master
routing needs no special case.

That value is an **assumption, not an observation.** A role can report `running`
because nothing checked. Consumers that need certainty should probe the role's own
endpoint, and any UI showing this should distinguish reported-from-container,
reported-synthetic, and probed.

## VRAM accounting

`vram.perRole` is the sidecar's own accounting, derived from `nvidia-smi` plus the
role registry:

| Field | Meaning |
|---|---|
| `actualMb` | measured attribution where available |
| `budgetMb` | the role's declared footprint |
| `loaded` | whether the model is resident — the genuine residency signal |
| `priority` | `critical` / `high` / `normal`, for eviction order |
| `gpuOnly` | never satisfy this role from CPU offload |

`vramSource` says how the numbers were obtained: measured from `nvidia-smi`,
`host-declared` (operator gave a budget via `SS_HOST_OLLAMA_BUDGET_MB`), or
`unknown` — which is what you get on macOS and Windows, where `nvidia-smi` does
not exist.

**Prefer `vram.perRole[role].loaded` over `containers[role].status`** when you need
to know whether a model is actually in VRAM. `status` can be synthetic; `loaded` is
accounted.

## Idle timers

Each role has an idle timer, armed by `/acquire` and disarmed while
`activeRequests > 0`. On expiry:

- **Container roles** — `docker stop`.
- **Host-Ollama roles** — `ollamaUnload(model)` with `keep_alive: 0`, so other
  models on the same Ollama keep their VRAM.
- **DMR roles** — no-op. Docker Model Runner has no public unload API and reaps
  its own workers.

This is why `/release` matters. A lost release leaves `activeRequests` elevated,
the idle timer never arms, and VRAM stays pinned — starving every other role on
that host. `POST /reset-counters` exists to recover from exactly that.

## Runtimes

| | Ollama | vLLM | Docker Model Runner |
|---|---|---|---|
| Model list | `/api/tags` | — | `/engines/v1/models` |
| Resident models | `/api/ps` | **no endpoint** | — |
| Liveness | direct | inferred from `nvidia-smi` PIDs, or a bounded `/v1/models` probe | probe |
| Unload | `keep_alive: 0` | container stop | not supported |
| Lifecycle owner | sidecar | sidecar | DMR's own scheduler |

The vLLM column is the one that causes trouble. `reranker` and `rlm` are exactly
the roles whose health cannot be asserted from the runtime, and they are also the
expensive ones. Any claim about them should name whether it was probed or inferred.

## Failure modes

Worth knowing before you debug a fleet.

**A WebSocket can be dead while both ends believe it is open.** `ws` only emits
`close` on a TCP FIN. A host that loses power, or a VPN path that drops, sends
nothing — the socket stays `ESTABLISHED` indefinitely. Both sides need ping/pong
liveness with a terminate-on-no-pong sweep; neither side can rely on `close`.

**A reconnect can orphan the previous socket.** If either end replaces its
connection reference without closing the old socket, the old one leaks. Worse: if a
close handler tears down shared state without checking that the state still refers
to *that* socket, closing a superseded socket destroys the live one — a
self-sustaining reconnect loop. Both ends here guard on socket identity.

**A socket that connects and never registers is owned by nobody.** It answers
pings, so a liveness sweep spares it, and it was never registered, so replacement
logic never touches it. Masters should bound the handshake and close sockets that
do not identify themselves.

**`activeRequests` can leak upward.** Release is fire-and-forget by design — a
failed release must not fail the request. The consequence is that the counter
drifts high, and routing then avoids a host that is actually free.

**A `gpuOnly` role can be "available" and still wrong.** If the model is partially
CPU-offloaded it will answer, slowly. `gpuReady: false` is the signal; ignoring it
turns a refusal into a latency mystery.

## Auto-update

The sidecar checks its master's build manifest and can update itself in place,
preserving configuration. It reports `version` in `/status` so a master can detect
a fleet running mixed builds — worth checking when behaviour differs between hosts
that should be identical.

See [`setup.md`](setup.md) for the update mechanism.
