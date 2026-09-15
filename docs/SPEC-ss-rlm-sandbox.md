# `ss-rlm-sandbox` — the two-master contract

**Audience:** engineers implementing the **Fantom MCP** side. You do not need this
repo open; everything you must build against is described here.

Sound Suite has implemented one half of a two-master contract. This document
specifies the other half, and describes **what was actually built** — where the
implementation diverges from the original design note, the code is described,
not the note.

Status as of 2026-09-15: Sound Suite's half is merged. Fantom's half is not
started. The sandbox Docker image does not exist yet.

---

## 1. What this is, and why

`ss-rlm` runs `mit-oasys/rlm-qwen3-8b-v0.1` — a Qwen3-8B post-trained for
recursive reasoning, self-hosted on Docker vLLM at ~10 GB VRAM.

**No provider hosts that model.** Verified live on 2026-09-15: ~704 Hugging Face
downloads, **zero** inference providers on Hugging Face, and absent from
OpenRouter's catalogue entirely (a search for `rlm|recursive` returns nothing).
It is one of only two roles on the fleet that no SaaS can serve.

But **RLM is an inference strategy, not a weight.** The pattern replaces
`llm.completion(prompt, model)` with `rlm.completion(prompt, model)`: the context
is held as a variable in a REPL that the model programmatically chunks, greps and
recursively sub-queries. The reference implementation drives ordinary API models.

So the pattern can run against models already being paid for. `ss-rlm-sandbox` is
that: a container running the RLM loop, calling a hosted chat model for its
sub-queries. It does **not** replace `ss-rlm` — both run until the pattern is
measured against the fine-tune.

---

## 2. The two-master contract

Both masters register on every sidecar and are distinguished by their own
`serverUrl`. Config is pushed per master over the existing WebSocket and stored
per master on the sidecar — this is the mechanism Fantom must use.

| Master | Port | `domain` | Retrieval tools |
|---|---|---|---|
| Sound Suite | `<master-host>:3000` | `'legal'` | `query_case_knowledge`, `query_case_graph` |
| Fantom MCP | `<master-host>:3848` | `'code'` | `search_code`, `search_symbols`, `search_files` |

### 2.1 The pushed config block

Sound Suite emits this from `buildOpenRouterPush()`; Fantom must emit the same
shape. It is sent as the `openrouter` key of the `/config` push.

```ts
{
  apiKey: string;                    // the master's own OpenRouter key
  allowedModels: Record<string, {    // keyed by ROLE
    model: string;                   //   e.g. 'deepseek/deepseek-v4-flash'
    provider?: string;               //   pin, embeddings only
    dims?: number;                   //   expected width, embeddings only
  }>;
  modeByRole: Record<string, string>;  // 'local-only' | 'local-first' | 'cloud-only'
  domain: 'legal' | 'code';            // THIS MASTER's self-declaration
}
```

Returns `null` — meaning "not configured, do not call out" — unless the feature
is enabled *and* a key is set. A sidecar that receives no block never calls
OpenRouter. That is the required default.

The sandbox's model rides `allowedModels['rlm-sandbox']`, on the **per-master**
channel rather than the sidecar-global `modelOverrides` used for other modes.
This is deliberate: `modelOverrides` holds exactly one value per sidecar, so one
master's choice would silently clobber the other's. Legal reasoning over
pleadings and code reasoning over an unfamiliar language are not obviously the
same pick, and each master must be able to choose independently.

### 2.2 `domain` is declared, never inferred

**Do not infer the domain from the port number.** The ports above are a current
deployment detail. Each master declares its own domain, because each master
knows what it is.

**A master that declares no `domain` gets no tool injection and is treated as
unconfigured.** It must not default to either side. Silently defaulting would
hand legal retrieval tools to a code caller, or the reverse — a failure that
produces confidently wrong answers rather than an error.

On Sound Suite's side, `domain: 'legal'` is **hardcoded** in
`buildOpenRouterPush()`, not read from an admin setting — there is no UI toggle
for it. Which retrieval domain a codebase operates over is a fact about the
software, not an operator preference; exposing it as a setting would let a
misclick point the push at the wrong tool set. Fantom's implementation should
hardcode `'code'` for the same reason rather than making it configurable.

---

## 3. Tool injection

The `rlm` library **cannot accept host callables across the process boundary** —
its documentation is explicit that custom tools must be passed as Python code
strings or JSON-serialisable values. So tools arrive as code strings that call
HTTP endpoints reachable from the container's network namespace.

This means **Fantom must expose its retrieval tools over HTTP** to the sandbox
container. The injected string for each tool is a small Python function that
POSTs to that endpoint and returns the parsed result.

Shape, with both domains side by side:

| | Sound Suite (`legal`) | Fantom (`code`) |
|---|---|---|
| Search | `query_case_knowledge(query, limit)` | `search_code(query, limit)` |
| Structure | `query_case_graph(entity)` | `search_symbols(name)` |
| — | — | `search_files(pattern)` |

Each resolves to an HTTP endpoint on the declaring master. The base URL is
therefore **per master**, not a single hardcoded value — a master that moves
ports or hosts changes only its own declaration.

---

## 4. Security — requirements, not suggestions

The code executing in the sandbox was written by a model, not by us. These
constraints are why container isolation is considered sufficient; relaxing any
of them invalidates that reasoning.

- **No Docker socket in the sandbox.** The sidecar mounts
  `/var/run/docker.sock` for *itself*, to manage containers, and does not pass it
  into role containers. A sandbox escape that reached that socket would be full
  host control.
- **No API key in the sandbox.** Sub-model calls go back out through the
  sidecar's existing virtual-inference proxy. The OpenRouter key stays on the
  master and the sidecar, never inside the sandbox.
- **No outbound internet required.** The sandbox needs a route to the local
  sidecar and to the declaring master's tool endpoints — nothing else. That is
  far easier to lock down than an allowlist.
- Non-root, read-only rootfs with tmpfs scratch, memory and PID limits, and a
  wall-clock timeout. Model-written loops do not reliably terminate.

The relaxed threat model assumes the fleet runs **inside a VPN** and is
single-tenant. If that changes, the `rlm` library's `environment=` parameter
swaps `docker` for `e2b` or `modal` in one line.

---

## 5. Model selection

Default: **`deepseek/deepseek-v4-flash`**. Verified live 2026-09-15:

| | |
|---|---|
| Price | $0.087 / $0.174 per M tokens |
| Context | 1,048,576 |
| Tools | yes |
| Reasoning | yes |
| Providers | **17** |

**Context length is not the binding constraint.** Sound Suite's existing RLM loop
uses only ~15–20K tokens per run (see its own endpoint documentation), so a
million-token window is irrelevant here. What matters is **tool-calling
reliability** — the loop is an evidence-gatherer that decides what to fetch next,
and a model that cannot call tools cannot drive it at all. The admin picker
therefore filters to models supporting both `tools` and `reasoning`.

`poolside/laguna-s-2.1` was rejected despite matching on price ($0.090/$0.180,
same context, both capabilities): it has **one provider**. For a role issuing
many sub-calls per question, a single-provider dependency is the same exposure
that took `qwen/qwen3-reranker-4b` and `-0.6b` dark — both are listed on
OpenRouter and served by nobody.

Because an RLM issues many sub-calls, **cost shape changes from per-GPU-hour to
per-token.** Per-role daily caps exist on the OpenRouter admin panel.

---

## 6. Implementation notes that contradict the original design note

An earlier design note circulated with two details that turned out to be wrong.
If you are working from that note, prefer this section.

**The role is `type: 'vllm'`, not `type: 'utility'`.** Utility roles are
explicitly skipped by the sidecar's `ensureContainerForRole()` and
`provisionContainers()` — that is how the `cuda` role stays managed out of band.
Declaring the sandbox as utility would have meant the sidecar **never created the
container**, contradicting the requirement that it participate in leases, idle
timers and mode switching. It is typed `vllm` to get the normal container
lifecycle; it is not literally vLLM.

**Docker roles do not all need a GPU.** Every docker-runtime role previously
requested GPU passthrough unconditionally, so a GPU-less host — a Mac running
Docker Desktop — would have **refused to create** a sandbox that needs no GPU at
all, defeating the "runs anywhere Docker runs" premise. `ContainerDef` gained an
additive `requiresGpu` flag, read as `!== false`, so every pre-existing role
keeps its previous behaviour and only the sandbox opts out.

---

## 7. Routing

Fallback lives in `resolveRlmEndpoint()`, **not** in the general
`resolveEndpoint()` cloud-provider phase: RLM has always had its own discovery
path and is not a member of the `GpuRole` union.

Order of resolution:

1. `ss-rlm` discovery — cache, live probe, direct vLLM probe.
2. If that comes up empty **and** `virtualInference.mode.rlm` is `local-first`
   **and** a sandbox model is configured, look for a connected sidecar running
   `rlm-sandbox`.
3. Otherwise refuse, exactly as before.

`virtualInference.mode.rlm` defaults to **`local-only`**, so behaviour is
unchanged until an operator opts in. A run that falls back emits a `notice`
event, so a degraded answer is visible in the progress channel rather than
silent.

---

## 8. Not built yet

| Item | Owner |
|---|---|
| Sandbox Docker image (`python:3.11-slim` + `rlm`, non-root) | Sound Suite / operator |
| Host-side proxy bridging sub-model calls to virtual-inference | Sound Suite |
| HTTP exposure of `search_code` / `search_symbols` / `search_files` | **Fantom** |
| `domain: 'code'` declaration in the config push | **Fantom** |
| Evaluation of the pattern vs. the self-hosted fine-tune | both |

Known TODO: `RLM_CONTEXT_TOKENS` (40,960 — `ss-rlm`'s vLLM ceiling) still clamps
the sandbox path, even though a hosted model has far more. Not yet fixed, because
the sandbox's HTTP contract does not exist to size against.

---

## 9. Current fleet state

Both masters register on every sidecar today. **Only Sound Suite has pushed
OpenRouter config** — Fantom has pushed none, so its `openrouter` status reads
`unset` on every host and the code domain is entirely inert until Fantom
implements its half.

Nothing breaks in the meantime: a master with no pushed block simply never
routes to OpenRouter, which is the intended default.

---

## 10. Open question

**Does the pattern with a general model beat the purpose-trained 8B?** Unknown.
The only honest answer is measurement, on the same evaluation set used for the
embedding and coder comparisons. Both roles run in parallel until then; do not
retire `ss-rlm` on the strength of this document.
