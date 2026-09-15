# Fantom MCP — integrating with `ss-rlm-sandbox`

**Audience:** engineers working on the Fantom MCP master. You do not need the
Sound Suite repo open; everything you must build against is specified here.

Sound Suite's half is **built and verified end to end** (2026-09-16). Fantom's
half is **not started**. This document is that half.

---

## 0. What you get, and what it costs you

**You get:** one call to a sandbox that runs the RLM loop over your codebase —
holding context as a REPL variable, chunking, grepping, recursively sub-querying
— instead of N proxy actions you build, deploy to five hosts, and keep in step.

**It costs you three things**, in dependency order:

| # | item | size | blocks |
|---|---|---|---|
| 1 | Declare `domain: 'code'` in your config push | ~1 line | tool injection |
| 2 | Expose `search_code` / `search_symbols` / `search_files` over HTTP | medium | the sandbox retrieving anything |
| 3 | Send `X-SoundSuite-Master` when you dial `:8101` | ~5 lines | **every call** — without it you get a 409 |

Item 3 is the one that will bite first. Do it first.

---

## 1. Declare `domain: 'code'`

The `openrouter` block you already push gains one field:

```ts
{
  apiKey: string;
  allowedModels: Record<string, { model: string; provider?: string; dims?: number }>;
  modeByRole: Record<string, 'local-only' | 'local-first' | 'cloud-only'>;
  domain: 'code';        // <- NEW
}
```

**Hardcode it.** Sound Suite hardcodes `'legal'` in `buildOpenRouterPush()`
rather than exposing a toggle, for the same reason you should hardcode `'code'`:
which retrieval domain a codebase operates over is a fact about the software,
not an operator preference. A toggle only creates a way to misclick legal tools
onto a code caller.

**Never infer it from the port.** `:3000` and `:3848` are a deployment detail. A
master that declares no domain gets no tool injection and is treated as
unconfigured — it must not default to either side, because the failure mode is
confidently wrong answers rather than an error.

Sidecar side, already built: `sideCar/src/lib/virtual-inference.ts` has
`SandboxDomain = 'legal' | 'code'` and stores it per master. Its doc comment is
explicit that absent means *not declared*, not *legal by default*.

### Your model lives on the per-master channel

Set `allowedModels['rlm-sandbox'] = { model: '<your choice>' }`.

This is deliberately **not** the sidecar-global `modelOverrides`, which holds one
value per sidecar and would let one master clobber the other's choice. The
sidecar resolves the model from *your* `allowedModels` when *you* are the
identified caller.

---

## 2. Expose your retrieval tools over HTTP

The `rlms` library cannot take host callables across a process boundary when the
REPL is isolated. We run `environment="local"`, so tools *can* be plain Python
callables inside the container — but those callables still have to reach **your**
data, and your data is in your master. So they become small Python functions
that POST to HTTP endpoints on you.

| | Sound Suite (`legal`) | Fantom (`code`) |
|---|---|---|
| Search | `query_case_knowledge(query, limit)` | `search_code(query, limit)` |
| Structure | `query_case_graph(entity)` | `search_symbols(name)` |
| Files | — | `search_files(pattern)` |

You already implement all three for your own RLM loop
(`src/embedding/rlmToolLoop.ts`). This is about making them reachable from the
sandbox's network namespace.

### Contract

Request:

```http
POST /api/rlm-tools/search_code
Content-Type: application/json
Authorization: Bearer <scoped token>

{"query": "...", "limit": 20}
```

Response — keep it **small and JSON**. The sandbox chunks and re-queries; it
does not need prose:

```json
{"results": [{"path": "src/x.ts", "line": 42, "snippet": "...", "score": 0.81}]}
```

### Design points to settle before building

- **Auth.** These endpoints expose codebase search. The fleet is VPN-only and
  single-tenant, but do not ship them anonymous. Decide between your existing
  Basic auth and a scoped token issued with the config push. Note the Sound Suite
  sidecar route is *currently* unauthenticated within the Docker network — that
  is a known gap on our side, not a precedent to copy.
- **Size.** An RLM issues many sub-calls. A fat response multiplies.
- **Base URL is per master.** It comes from your own declaration, not a
  hardcoded value, so a master that moves host or port changes only its own
  entry.
- **`RLM_CONTEXT_TOKENS` is resolved on our side.** It used to clamp the sandbox
  to `ss-rlm`'s 40,960 vLLM ceiling; `ResolvedRlmEndpoint.contextTokens` now
  carries the hosted model's real window.

---

## 3. Identity — which master's key gets spent

**This is the part that will fail first, and it is not optional.**

Every sidecar in this fleet carries OpenRouter keys from **both** masters.
`apiKey`, `allowedModels` and the spend are per master by design. When the
sandbox calls back for a sub-model completion, the sidecar must know who it is
acting for.

Over a WebSocket that is free — the action arrives on that master's socket. Over
HTTP there is no such context, so the sidecar **refuses**:

```json
{"error":{"message":"2 masters have OpenRouter keys on this sidecar
 (http://100.114.170.238:3000, http://100.114.170.238:3848). The caller must
 identify itself with the X-SoundSuite-Master header — refusing to guess whose
 key and budget to spend.","type":"sidecar_error","code":409}}
```

It refuses rather than picking the first because picking would spend one
master's budget on the other's model, silently and unprovably.

### What you must do

Send your own canonical URL when you dial `:8101`:

```
POST http://<sidecar-host>:8101/v1/chat/completions
X-SoundSuite-Master: http://<your-master-host>:3848
```

The sandbox forwards it on every sub-model call. It must be **per request** —
one container serves both masters, so a container-wide value would bill your
traffic to us.

Sound Suite does this in `src/lib/ai/stream-rlm.ts` (`rlmHeaders()`), resolving
from `getCanonicalMasterUrl()` and attaching it only on the sandbox path.

**The URL must match exactly** what you sent as `serverUrl` in your `/config`
push — that is the key the sidecar stores your config under. A trailing slash or
a different host spelling resolves to 404 (`master … has pushed no OpenRouter
config`), not to a fallback.

### Errors you will see

| status | meaning | fix |
|---|---|---|
| 409 | Two+ masters have keys, you sent no header | Send `X-SoundSuite-Master` |
| 404 | The URL you sent matches no stored config | Match your `/config` `serverUrl` exactly |
| 503 | You are known but have no key, or no model for `rlm-sandbox` | Push a key; set `allowedModels['rlm-sandbox']` |
| 502 | Upstream OpenRouter failure | Read the message — it is passed through |

---

## 4. Files you will touch

On **your** side:

| file | change |
|---|---|
| wherever you build the OpenRouter push | add `domain: 'code'`; add `allowedModels['rlm-sandbox']` |
| your RLM entry point | send `X-SoundSuite-Master` on sandbox calls |
| new HTTP routes | `search_code`, `search_symbols`, `search_files` |
| `src/embedding/rlmToolLoop.ts` | reuse its retrieval, do not reimplement |

On **our** side — already built, listed so you can read the reference
implementation:

| file | what it shows you |
|---|---|
| `sideCar/src/app/api/v1/chat/completions/route.ts` | the endpoint your sandbox's sub-calls hit; identity resolution and refusal |
| `sideCar/src/lib/virtual-inference.ts` | `resolveSandboxMaster`, `sandboxModelFor`, `SandboxDomain`, per-master storage |
| `src/lib/ai/stream-rlm.ts` | how a master dials `:8101` and sends identity (`rlmHeaders`) |
| `docker/rlm-sandbox/server.py` | the shim, and where `custom_tools` will be wired |
| `src/lib/gpu/fleet-router.ts` | `buildOpenRouterPush()` — the push shape, incl. hardcoded `domain` |

---

## 5. Tool injection — where it plugs in

Currently **stubbed**: `server.py` passes `custom_tools=None`, so the loop
reasons over the prompt it is handed and cannot retrieve. Neither master exposes
tools over HTTP yet.

When it lands, the wiring is:

1. The sidecar knows the calling master's `domain` (you declared it in §1).
2. `server.py` receives the identity per request (§3).
3. It builds `custom_tools` as Python callables that POST to the declaring
   master's endpoints (§2).
4. `RLM(custom_tools=…)` injects them into the REPL globals.

With `environment="local"` these are ordinary callables — **not** code strings.
The code-string constraint in the original design note applies only to isolated
environments, which we do not use. If you read that note, prefer this file.

---

## 6. Verify your half

In order — each step is provable before the next, so a failure is never debugged
through two layers.

1. **Your push carries the new fields.** Sidecar `/api/status` shows your slot
   `configured`; `allowedModels` has an `rlm-sandbox` entry.
2. **Identity resolves.** With your header:
   ```bash
   curl -H 'X-SoundSuite-Master: http://<you>:3848' \
        http://<sidecar>:8098/api/v1/chat/completions
   # -> 200 {"object":"list","data":[{"id":"<your model>",...}]}
   ```
   A 409 means the header is missing or mismatched; `data: []` means no model.
3. **A sub-model call works.** POST the same URL with `{"messages":[…]}` and get
   a completion billed to *your* key.
4. **The sandbox answers you.** POST `:8101/v1/chat/completions` with your header
   and a needle-in-haystack prompt. Sound Suite's equivalent returns in ~7 s.
5. **Your tools are reachable from the container's namespace** — not just from
   your laptop. The container resolves the host via
   `host.docker.internal:host-gateway`.
6. **Tool injection**, once §5 ships.

Steps 1–4 need nothing from us.

---

## 7. Things that cost us time — do not repeat them

Each of these was a real failure on this fleet.

- **`type: 'vllm'` is a lie told for the container lifecycle.** The sidecar keyed
  its vLLM command builder off that type and handed our image
  `[<model-id>, '--host', …]`, so Docker exec'd the model id as a binary and every
  container died with `[FATAL tini] exec deepseek/deepseek-v4-flash failed`.
  Fixed with `ContainerDef.usesImageCmd`. If you add a role, trace what *else*
  reads its type.
- **Containers are immutable.** A container keeps the `Cmd` it was created with
  forever; pulling a corrected image changes nothing. Three hosts restart-looped
  until drift detection learned to notice a `Cmd` that should not be there.
- **A drift check that only fires when it expects *something* cannot detect a
  leftover.** The Cmd comparison was gated on `expected.Cmd` being truthy.
- **`rlms`, not `rlm`.** The PyPI distribution is `rlms`; the importable module
  is `rlm`. Checking the wrong name yields a confident, wrong "not published".
- **A blank string is not "no change".** `/admin/openrouter` wrote `''` over a
  configured sandbox model because `typeof '' === 'string'` passed the guard,
  and `resolveRlmEndpoint()` skips the whole fallback when the model is unset.
- **GHCR packages are private by default**, and there is no REST endpoint to
  change that — it is a manual UI step. A private package fails the pull with a
  401 that looks exactly like a missing image.
- **Build multi-arch.** This fleet is 3× `windows-docker-wsl2` (amd64) and 2×
  `mac-docker-ollama` (arm64). Single-arch fails on the other half as a
  container that will not start, not as a pull error.

---

## 8. Open questions — yours as much as ours

1. **Does the pattern with a general model beat the purpose-trained 8B?**
   Unknown. Only measurement answers it. Run both roles against the same
   evaluation set. **Do not retire `ss-rlm` on the strength of a design
   document.**
2. **Cost shape changes** from per-GPU-hour to per-token, and an RLM makes many
   sub-calls. Per-role daily caps exist on the OpenRouter panel; `max_budget`
   works inside the loop. Note the master currently cannot *see* sandbox spend —
   `usage` comes back zeroed (see [README](./README.md#known-defect)).
3. **Auth on the tool endpoints** (§2) is unsettled on both sides.
