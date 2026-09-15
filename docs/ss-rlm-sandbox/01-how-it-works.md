# How `ss-rlm-sandbox` works

Every claim here was checked against the running fleet on 2026-09-16.

---

## 1. The shape

```
                    ┌─ CONTROL PLANE ───────────────────────────────┐
                    │  pull / start / stop, lease, idle timer        │
   master :3000 ────┤  (the sidecar NEVER proxies inference)         │
     │  /config     │                                                │
     │   push       │   SIDECAR :8098                                │
     │              │   · per-master OpenRouter key                  │
     │              │   · allowedModels['rlm-sandbox'] per master    │
     │              │        │ docker run (runtime: docker-cpu)      │
     │              │        ▼                                       │
     │ DATA PLANE   │   ╔═══════════════════════════════════════╗    │
     └──────────────────▶║ ss-rlm-sandbox                 :8101  ║    │
   resolveRlmEndpoint()  ║  server.py — OpenAI-compatible shim   ║    │
   POST /v1/chat/…       ║     │                                 ║    │
   + X-SoundSuite-Master ║     ▼                                 ║    │
                         ║  RLM(environment="local")             ║    │
                         ║  model-written Python in a REPL,      ║    │
                         ║  in-process — the container IS the    ║    │
                         ║  isolation boundary                   ║    │
                         ║     │                    │            ║    │
                         ╚═════│════════════════════│════════════╝    │
                               │ llm_query          │ custom_tools    │
                               │ rlm_query          │ (STUBBED)       │
                               ▼                    ▼                 │
                    sidecar /api/v1/chat/completions   master HTTP    │
                               │                      (not built)     │
                               ▼                                      │
                    OpenRouter · deepseek/deepseek-v4.1-flash          │
                                                                      │
   KEY LIVES HERE ────────────────────────────────────────────────────┘
   (sidecar, per master — NEVER in the container)
```

**The sidecar is control plane only.** It creates the container and manages its
lease, but the master's inference call goes **straight to `:8101`**.
`resolveRlmEndpoint()` returns `http://<sidecar-host>:8101` and dials it
directly. Same shape as the Docker Model Runner path.

Sub-model calls go the *other* way — container back to its own sidecar — because
the container holds no API key by design.

---

## 2. The four hops

| # | hop | who | code |
|---|---|---|---|
| 1 | master → `:8101/v1/chat/completions` | master | `src/lib/ai/stream-rlm.ts` — 3 fetch sites |
| 2 | `server.py` → `RLM.completion(prompt)` | container | `docker/rlm-sandbox/server.py` |
| 3 | RLM sub-call → sidecar `:8098/api/v1/chat/completions` | container | `rlms` library, `backend="openai"` + `base_url` |
| 4 | sidecar → OpenRouter | sidecar | `sideCar/src/app/api/v1/chat/completions/route.ts` |

Hop 3 is the one that surprises people: the container talks to **its own
sidecar**, not to OpenRouter. That is what keeps the key out of a process
running model-written Python.

---

## 3. Making a call

### From the master (normal path)

Nothing to do. `resolveRlmEndpoint()` picks the sandbox automatically when:

1. no sidecar has `ss-rlm` running, **and**
2. `virtualInference.mode.rlm` is `local-first` (not the default `local-only`), **and**
3. `rlm.sandboxModel` is set on `/admin/openrouter`

A run that falls back emits a `notice` event, so a degraded answer is visible in
the progress channel rather than silent.

### Directly (testing)

```bash
curl -s -X POST http://<sidecar-host>:8101/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-SoundSuite-Master: http://<your-master>:3000' \
  -d '{"messages":[{"role":"user","content":"<your long context + question>"}],
       "max_tokens":256}'
```

**`X-SoundSuite-Master` is required** when more than one master has pushed a key
to that sidecar — which is the case on this fleet today. Without it you get a
409 naming both masters. See §5.

`stream: true` is rejected: the master's sandbox path collects a whole answer,
and silently not streaming would hang the caller.

### Health

```bash
curl http://<sidecar-host>:8101/health      # {"ok":true,"model":…,"sidecar":…}
curl http://<sidecar-host>:8101/v1/models   # the model hint the container holds
```

---

## 4. What the container actually is

```
python:3.11-slim
  + rlms 0.1.3            vendored at public/rlm/, pinned @ 854e688f, checksum-verified
  + server.py             ~250 lines — the only code we wrote
```

`server.py` exists because **`rlms` is a library, not a service**: it exposes
`RLM.completion()`, and the master dials an OpenAI-compatible endpoint. The
shim is the adapter.

### `environment="local"`, deliberately

The `rlms` library ships seven REPL environments including `docker`. We use
`local`.

`DockerREPL` shells out to the `docker` CLI to spawn *nested* containers, which
needs `/var/run/docker.sock` inside ours. [`SPEC §4`](../SPEC-ss-rlm-sandbox.md)
forbids that, and the sidecar never passes the socket to role containers
(`docker.ts` gives them only `ollama-models` or `huggingface-cache` binds).

So **the container is itself the isolation boundary** — which is SPEC §4's own
reasoning, applied one layer out from where the original design note put it.
Nothing is lost: `llm_query`, `rlm_query`, `custom_tools`, `persistent`,
`compaction` are the `RLM` class's API, not `DockerREPL`'s. One thing is gained:
with `local`, `custom_tools` takes **ordinary Python callables** rather than
injected code strings.

If the threat model ever hardens, `environment="e2b"` / `"modal"` are hosted
microVMs needing no local socket — a one-line swap. Only `docker` is unavailable.

### Safety rails

Set in `server.py`, all env-overridable:

| rail | default | env |
|---|---|---|
| wall-clock timeout | 300 s | `SS_MAX_TIMEOUT` |
| root-loop iterations | 30 | `SS_MAX_ITERATIONS` |
| consecutive errors | 5 | `SS_MAX_ERRORS` |
| recursion depth | 1 | `SS_MAX_DEPTH` |
| parallel sub-calls | 4 | `SS_MAX_CONCURRENT_SUBCALLS` |
| total tokens | unset | `SS_MAX_TOKENS` |
| USD budget | unset | `SS_MAX_BUDGET_USD` |

`max_budget` **works** — the library reads `usage.cost` off the response
(`rlm/clients/openai.py:_track_cost`, not gated on `base_url`), and the sidecar
route forwards OpenRouter's `usage` verbatim with `usage: {include: true}`.
Break either and the rail silently becomes a no-op.

---

## 5. Identity — whose key gets spent

`apiKey`, `allowedModels` and the spend are **per master**, so Sound Suite and
Fantom cannot charge each other.

The existing `virtual-*` actions get the caller's identity free: they arrive
over that master's WebSocket. The sandbox calls in over **HTTP**, which has no
such context. So:

- **exactly one master configured** → resolved automatically
- **more than one** → **409**, naming every candidate, refusing to guess
- **`X-SoundSuite-Master` present** → that master is used

Picking the first configured master would spend one master's budget on the
other's model, silently and unprovably. The 409 is deliberate.

On this fleet **both masters have pushed keys** (`:3000` Sound Suite, `:3848`
Fantom), so the header is mandatory in practice.

The master sends it from `getCanonicalMasterUrl()`, only on the sandbox path
(`stream-rlm.ts`). `server.py` reads it per request and forwards it on every
sub-model call — **per request, not per container**, since one container serves
both masters.

---

## 6. Where everything lives

| thing | path |
|---|---|
| Image source | `docker/rlm-sandbox/{Dockerfile,server.py}` |
| Published image | `ghcr.io/project-sandstar/rlm-sandbox:0.1.1` (public, multi-arch) |
| Vendored library | `public/rlm/` + `scripts/vendorRlm.sh` |
| Sidecar route (hop 4) | `sideCar/src/app/api/v1/chat/completions/route.ts` |
| Master identity resolution | `sideCar/src/lib/virtual-inference.ts` → `resolveSandboxMaster`, `sandboxModelFor` |
| OpenRouter client | `sideCar/src/lib/openrouter-client.ts` → `chat()` |
| Registry entry (×2 — keep in sync) | `sideCar/src/lib/state.ts` `defaultRegistry['rlm-sandbox']` **and** `sideCar/src/lib/mode-templates.ts` `rlmSandboxDef()` |
| Master routing (hop 1) | `src/lib/ai/stream-rlm.ts` → `resolveRlmEndpoint()`, `rlmHeaders()` |
| Model config | `/admin/openrouter` → `rlmSandboxModel` |
| Role assignment | `/admin/roleassign` → `ss-rlm-sandbox`, runtime **Docker (no GPU)** |
