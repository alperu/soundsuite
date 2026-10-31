# Sidecar remediation report — 2026-09-15

Sidecar version at time of writing: **2.3.84**.
Observed from the Fantom MCP Server (`/Users/alper/Code/mcpfantom`) during an
8-hour full code re-embed across the fleet.

## Fleet at the time of the report

| host | address | runtime | code-embedding | reported `activeRequests` |
|---|---|---|---|---|
| BASWS35 | 10.10.20.134:8098 | Docker Ollama, NVIDIA TITAN RTX | :11437 | **7** |
| mcpserver.local | 192.168.88.238:8098 | macOS `host-ollama` | :11434 | **6,548** |
| Alpers-Mac-mini.local | 192.168.88.249:8098 | macOS `host-ollama` | :11434 | **6,328** |
| gpu-01 | — | reranker :8099 | — | never heartbeats Fantom |
| gpu-02 | — | RLM :8100 | — | never heartbeats Fantom |

Both Macs answer a direct `POST /api/embed` correctly and promptly
(`qwen3-embedding:4b`, 2560 dimensions), so the inference path itself is
healthy. The defects below are in the sidecar's accounting and role plumbing.

---

## 1. `activeRequests` is never released (highest priority)

**Symptom.** The Macs report over 6,300 concurrent requests while actually
serving at most a handful. BASWS35 sits at 7. The counter only ever grows.

**Cause.** In `src/lib/handlers.ts`, `handleAcquire` increments the counter
once per acquire:

```ts
r.activeRequests++;
clearIdleTimerForRole(role);
```

It is decremented in exactly two situations:

- an **error** path inside `handleAcquire` (lines ~615, ~629, ~641), and
- `handleRelease` (line ~683), which is only ever reached from
  `src/lib/ws-client.ts:364` — `case 'release': return handleRelease(role)`.

So on every **successful** acquire the counter is incremented and nothing in
the sidecar ever decrements it. The balancing `release` must arrive from the
master. When the master does not send one (or sends it for a different role,
or the socket drops mid-request) the count leaks permanently. The host-runtime
branch returns early:

```ts
if (def.runtime === 'host') {
  ...
  return { action: 'host-runtime', role, activeRequests: r.activeRequests };
}
```

which is why the two macOS `host-ollama` boxes leak fastest.

**Consequences.**

- The idle timer never arms. `handleRelease` reports
  `idleTimerStarted: r.activeRequests === 0`, which can no longer be true, so
  roles are pinned in memory forever. This is why the Mac mini keeps
  `qwen3.5:9b`, `qwen3-embedding:4b` and `qwen3-embedding:0.6b` resident
  simultaneously.
- `totalActive()` (line 285) sums these values, so every consumer of the
  aggregate is wrong.
- Any scheduler that treats `activeRequests` as capacity will read the Macs as
  saturated and route around them.

**Fix.** Make the acquire/release pair robust rather than relying on a
cooperative master:

1. Return an opaque lease id from `handleAcquire` and have `handleRelease`
   take it, so a duplicate or mismatched release cannot double-decrement and a
   missing one can be identified.
2. Expire leases. Record `lastAcquire` per lease (the field already exists) and
   sweep any lease older than a configurable TTL, defaulting to a few minutes.
   This alone converts a permanent leak into a bounded one.
3. Decrement on socket loss. When the ws-client connection to the master drops,
   release every lease that connection owns.
4. Add a guard log when `activeRequests` exceeds a threshold, so the condition
   is visible in the sidecar's own UI rather than only from the master.

A short-term mitigation available today: restart the sidecar service on the two
Macs to zero the counter. Note `src/app/api/restart/route.ts:39` already warns
that a restart discards in-memory accounting and the master's view diverges,
which is itself an argument for the lease model above.

---

## 2. The embedding role is loaded through `/api/generate`

**Symptom.** Warming or health-checking an embedding role issues a completion
request against a model that only produces embeddings.

**Why it matters.** For an embedding-only GGUF this is wasted work at best. On
Ollama 0.3x it can also mislead capability detection, because the server
answers a generate call differently from an embed call. The correct warm-up for
an embedding role is a single `POST /api/embed` with a one-token input.

**Fix.** Branch the warm-up by role kind: embedding roles use `/api/embed`,
completion roles use `/api/generate`. Treat a non-2xx from `/api/embed` as the
authoritative signal that the role cannot embed.

---

## 3. `gpu-01` and `gpu-02` never heartbeat

**Symptom.** Fantom lists both hosts with `online=None`, `available=None`, and
no capabilities. They are configured and enabled but have never registered.

**Why it matters.** These are the only other CUDA machines on the network. They
currently run the reranker (:8099) and the RLM (:8100) and sit idle through
multi-hour embedding runs. Embedding is pure prefill and needs tensor cores, so
adding the `code-embedding` role to either roughly doubles fleet throughput.
The two Macs together contribute about 3 texts/s against BASWS35's 12-14.

**Fix.** Confirm the sidecar agent is installed and running on both, that its
master URL points at the Fantom host, and that the outbound websocket is not
blocked. Then assign the `code-embedding` role with the same model as the rest
of the fleet.

---

## 4. `ensureOllamaModel` base-name tag match — already patched, not committed

**Symptom (2026-09-14).** BASWS35 never pulled `qwen3-embedding:4b` because
`qwen3-embedding:0.6b` was on disk and satisfied a base-name `includes()`
check. The role then tried to load a model that had never been downloaded.

**Status.** Fixed locally in `src/lib/handlers.ts` around line 143:

```ts
let onDisk = diskModels.some(m =>
  m === def.model || (!def.model.includes(':') && m.split(':')[0] === modelBase));
```

Exact tag match, with a base-name fallback only when the configured model
carries no tag. **This change is uncommitted** — `git status` shows
`M sideCar/src/lib/handlers.ts`. It should be committed and released so the
fleet does not regress on the next deploy.

Also present in the working tree: an untracked `.env.bak.1789388009`. Check it
for credentials before it is committed or shared.

---

## Suggested order of work

1. **Lease-based `activeRequests`** with TTL expiry and release-on-disconnect.
   Everything else downstream (idle timers, capacity signals, model residency)
   is wrong until this is right.
2. **Commit the `ensureOllamaModel` fix.** It is already written and verified.
3. **Bring `gpu-01`/`gpu-02` online** and give one of them `code-embedding`.
   This is the single largest throughput win available.
4. **Split the warm-up path** by role kind.

## How to verify

- `activeRequests` on an idle Mac returns to 0 within the lease TTL, and the
  idle timer arms.
- `ollama ps` on the Macs shows embedding models unloading when idle instead of
  three models pinned at once.
- Fantom's Fleet panel lists gpu-01 or gpu-02 with `code-embedding` available.
- A full re-embed shows the new CUDA host taking a share comparable to
  BASWS35's in the `[reembed-job] ... pipeline done` attribution lines.
