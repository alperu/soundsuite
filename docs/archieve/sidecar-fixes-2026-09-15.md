# Sidecar remediation report — 2026-09-15

Sidecar version: **2.3.84**. Observed from the Fantom MCP Server
(`/Users/alper/Code/mcpfantom`) during an 8-hour full code re-embed.

## Fleet at the time of the report

| host | address | runtime | code-embedding | reported `activeRequests` |
|---|---|---|---|---|
| BASWS35 | 10.10.20.134:8098 | Docker Ollama, TITAN RTX | :11437 | **7** |
| mcpserver.local | 192.168.88.238:8098 | macOS `host-ollama` | :11434 | **6,548** |
| Alpers-Mac-mini.local | 192.168.88.249:8098 | macOS `host-ollama` | :11434 | **6,328** |
| gpu-01 | — | reranker :8099 | — | never heartbeats Fantom |
| gpu-02 | — | RLM :8100 | — | never heartbeats Fantom |

Both Macs answer a direct `POST /api/embed` correctly and promptly
(`qwen3-embedding:4b`, 2560 dims), so inference is healthy. The defects below
are in the sidecar's accounting and role plumbing.

---

## 1. `activeRequests` is never released (highest priority)

**Symptom.** The Macs report 6,300+ concurrent requests while serving a
handful. BASWS35 sits at 7. The counter only grows.

**Cause.** In `src/lib/handlers.ts`, `handleAcquire` increments once per
acquire (`r.activeRequests++`, ~line 597). It is decremented only on an error
path inside `handleAcquire` (~615, ~629, ~641) and in `handleRelease` (~683),
which is reachable only from `src/lib/ws-client.ts:364`
(`case 'release': return handleRelease(role)`).

So on every **successful** acquire nothing in the sidecar decrements. The
balancing `release` must come from the master; when it does not arrive (or the
socket drops mid-request) the count leaks permanently. The host-runtime branch
returns early with `{ action: 'host-runtime', ... }`, which is why the two
macOS `host-ollama` boxes leak fastest.

**Consequences.**
- The idle timer never arms — `handleRelease` reports
  `idleTimerStarted: r.activeRequests === 0`, which can never be true — so
  roles stay pinned in memory. Hence the Mac mini holding `qwen3.5:9b`,
  `qwen3-embedding:4b` and `qwen3-embedding:0.6b` at once.
- `totalActive()` (line 285) sums these, so every consumer is wrong.
- Any scheduler treating `activeRequests` as capacity reads the Macs as
  saturated and routes around them.

**Fix.**
1. Return an opaque lease id from `handleAcquire`; `handleRelease` takes it, so
   duplicate/mismatched releases cannot double-decrement.
2. Expire leases via the existing `lastAcquire` field and a configurable TTL.
   This alone converts a permanent leak into a bounded one.
3. Release every lease owned by a ws-client connection when it drops.
4. Log a guard warning when `activeRequests` crosses a threshold.

Short-term mitigation: restart the sidecar on the two Macs to zero the counter.
Note `src/app/api/restart/route.ts:39` already warns that a restart discards
in-memory accounting and diverges from the master's view — itself an argument
for the lease model.

---

## 2. The embedding role is loaded through `/api/generate`

Warming an embedding role issues a completion request against a model that only
produces embeddings. Wasted work at best; on Ollama 0.3x it can also mislead
capability detection, since the server answers generate and embed differently.

**Fix.** Branch warm-up by role kind: embedding roles use `POST /api/embed`
with a one-token input, completion roles use `/api/generate`. Treat a non-2xx
from `/api/embed` as authoritative that the role cannot embed.

---

## 3. `gpu-01` and `gpu-02` never heartbeat

Fantom lists both with `online=None`, `available=None`, no capabilities. They
are configured and enabled but have never registered.

These are the only other CUDA machines on the network, running the reranker and
RLM and idle through multi-hour embedding runs. Embedding is pure prefill and
needs tensor cores: adding `code-embedding` to either roughly doubles fleet
throughput. The two Macs together give ~3 texts/s against BASWS35's 12-14.

**Fix.** Confirm the agent runs on both, its master URL points at the Fantom
host, and the outbound websocket is not blocked. Then assign `code-embedding`
with the fleet model.

---

## 4. `ensureOllamaModel` base-name tag match — patched, NOT committed

**Symptom (2026-09-14).** BASWS35 never pulled `qwen3-embedding:4b` because
`qwen3-embedding:0.6b` on disk satisfied a base-name `includes()` check; the
role then tried to load a model never downloaded.

**Status.** Fixed locally in `src/lib/handlers.ts` ~line 143:

```ts
let onDisk = diskModels.some(m =>
  m === def.model || (!def.model.includes(':') && m.split(':')[0] === modelBase));
```

Exact tag match, base-name fallback only when the configured model has no tag.
**Uncommitted** — `git status` shows `M sideCar/src/lib/handlers.ts`. Commit and
release it so the fleet does not regress on the next deploy.

---

## 5. Housekeeping

An untracked `.env.bak.1789388009` (1.1 KB, mode 600) sits at the **repo root**
(`/Users/alper/Code/court-lens-mcp/.env.bak.1789388009`), not inside `sideCar/`.
Check it for live credentials and delete or gitignore it before it is committed
or shared.

---

## Suggested order of work

1. **Lease-based `activeRequests`** with TTL expiry and release-on-disconnect.
   Idle timers, capacity signals and model residency are all wrong until this
   is fixed.
2. **Commit the `ensureOllamaModel` fix** — already written and verified.
3. **Bring `gpu-01`/`gpu-02` online**, give one `code-embedding`. Largest
   throughput win available.
4. **Split the warm-up path** by role kind.

## How to verify

- `activeRequests` on an idle Mac returns to 0 within the lease TTL and the
  idle timer arms.
- `ollama ps` shows embedding models unloading when idle instead of three
  models pinned.
- Fantom's Fleet panel lists gpu-01 or gpu-02 with `code-embedding` available.
- A full re-embed shows the new CUDA host taking a share comparable to
  BASWS35's in `[reembed-job] ... pipeline done` attribution lines.
