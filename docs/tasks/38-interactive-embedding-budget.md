# The interactive embedding path has no interactive budget

**Status:** Proposed — **verified by source, arithmetic not yet observed to completion** · **Effort:** S (items 1–4), M (item 7) · **Priority:** P1 · **Created:** 2026-09-09
**Related:** [task 30](./30-mcp-parity-and-fleet-visibility.md) Part 3 · [task 22](./22-rerank-observability.md)

> **Provenance.** The asymmetry, the constants and the call sites are verified by reading source —
> line citations below. The worst-case arithmetic is computed from those constants and has **not**
> been observed running to completion; no measurement in this task waited longer than 20 s. The
> claim that the observed stalls *are* this path is **diagnosed, not proven** — see §6.

Field names and code citations only. No case data.

## 1. The asymmetry

The rerank path already solves "a degraded fleet must not block a live search". The embedding
path has the same exposure and no equivalent.

**Rerank — `src/lib/search/reranker.ts:186-192`:**

```ts
// Interactive (user-facing) callers use a shorter timeout so a cold/degraded
// fleet can't block a live search for the full cold-start budget; on timeout
// the all-hosts-failed path below falls back to first-stage order. Batch
// callers (default) keep the long timeout for cold-start tolerance.
const timeoutMs = opts?.interactive
  ? (config.rerankInteractiveTimeoutMs ?? 30_000)
  : (config.rerankTimeoutMs ?? 90_000);
```

`opts.interactive` is threaded from the query path at `src/lib/search/deep-search.ts:798-803`.
On exhaustion it degrades gracefully and **says so** — `reranker.ts:369-375` emits
`warn('degraded', …)` carrying *"Results not reranked — reranker unavailable within the
interactive timeout; showing first-stage (hybrid) order."*

**Embedding — `src/lib/ingestion/ollama-embedding-provider.ts`:**

| Constant | Line | Value |
|---|---|---|
| `PREFLIGHT_TIMEOUT_MS` | 53 | `1_500` |
| `EMBED_TIMEOUT_MS` | 127 | `120_000` |
| `EMBED_MAX_ATTEMPTS` | 129 | `3` |
| `EMBED_BASE_DELAY_MS` | 131 | `3_000` |

One `EMBED_TIMEOUT_MS`, used for every caller. There is no `interactive` option on the provider,
no interactive constant in `src/lib/db/config.ts`, and no call site passes one. The 120 s value is
correct for its documented purpose — `ollama-embedding-provider.ts:124-126` records that a dead
socket once hung ~72 s before undici noticed, and the comment says it "covers cold model loads
(30-60s) with margin". That reasoning is sound **for batch ingestion**. It is inherited by live
queries because nothing distinguishes them.

## 2. Worst-case arithmetic

From the constants above and the retry loop at `ollama-embedding-provider.ts:150-167`
(`delay = EMBED_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1_000`):

| Step | Budget |
|---|---|
| preflight | 1.5 s |
| attempt 1 | 120 s |
| backoff 1 | 3.0–4.0 s |
| attempt 2 | 120 s |
| backoff 2 | 6.0–7.0 s |
| attempt 3 | 120 s |
| **total** | **≈ 370 s (~6 min)** before the caller sees an error |

Retries re-resolve the host (`this.lastPreflight = null`, line 155) and exclude failed hosts, so
in a multi-host fleet the attempts usually land elsewhere and this ceiling is rarely reached. But
nothing bounds it, and a live query is entitled to none of that patience.

**Compare:** rerank costs a live search at most 30 s and then returns labelled, degraded results.
Embedding can cost it six minutes and then throw — and unlike rerank there is no first-stage order
to fall back to, because without an embedding there is no vector leg at all.

## 3. What "interactive" must mean here

`opts.interactive` on rerank is a *caller* property, not a config mode, and the same shape applies:

- **Interactive** — anything on a user-facing query path: `query_case_knowledge`,
  `research_evidence` in `fast` mode, and the retrieval phase of any job a caller is watching.
- **Batch** — ingestion, backfill, reindex, and background job phases.

The parameter must be threaded, not inferred. Inferring from process or environment is what makes
a batch job silently adopt an interactive budget during a long ingest.

## 4. A documented default that does not match the code

`src/lib/db/config.ts:91-96` declares:

```ts
/** Shorter timeout (ms) for INTERACTIVE (user-facing) rerank calls. …
 *  Default 15000. */
rerankInteractiveTimeoutMs: number;
```

`reranker.ts:191` reads `config.rerankInteractiveTimeoutMs ?? 30_000`.

The documented default is **15000**; the code fallback is **30_000**. Whichever is intended, the
two disagree, and the comment is the one a reader trusts. Fix in this task since it is the same
file family and the same class of defect.

## 5. Amendments this requires to task 30

Task 30 Part 3 proposes `fleet_status()`. Two additions, both from source:

**(a) It must probe, not relay.** The sidecar probes Ollama roles and only inspects vLLM roles:

- Ollama roles are queried live — cached `/api/tags` and `/api/ps` snapshots keyed by `host:port`
  (`sideCar/src/lib/ollama-api.ts:82`), which is where `loadedModels`, `gpuPercent` and `until`
  come from.
- vLLM roles have no equivalent. `sideCar/src/lib/state.ts:412` states it: vLLM "doesn't expose a
  per-model size endpoint like Ollama's `/api/ps`". Their reported status is Docker container
  state, and `loadedModels` is empty.

**The two vLLM roles are `ss-reranker` and `ss-rlm`** — exactly the roles whose health cannot
currently be asserted. Task 30 already records the consequence: the rerank host was confirmed live
by shell-probing `:8099` (HTTP 200 in 0.37 s on `/v1/models`) while the fleet reported otherwise.
A `fleet_status()` that re-serves container state through MCP reproduces the `notReady` defect —
green while the path is sick.

Requirement: a bounded `GET /v1/models` per vLLM role, one short per-host timeout, host reported
`unknown` on timeout rather than the call hanging (task 30 already lists this risk).

**(b) Encode the role→port map, including the shared-Ollama exception.** Port is fixed by role:

| Role | Port | Typical runtime |
|---|---|---|
| `ss-embedding` | 11434 | Ollama |
| `ss-completion` | 11435 | Ollama |
| `ss-ocr` | 11436 | Ollama |
| `ss-code-embedding` | 11437 | Ollama |
| `ss-reranker` | 8099 | Docker vLLM |
| `ss-rlm` | 8100 | Docker vLLM |

**Exception that must not be reported as drift:** a role backed by a *shared* Ollama answers on
**11434** rather than its own per-role port. Observed across the fleet for `completion`, `ocr` and
`code-embedding` on hosts without a dedicated container. A port outside both the role's own port
and 11434 is a real anomaly; the shared case is not.

**(c) `UNREPORTED` is not `down`.** A host that declares a container and returns no status is
telling you nothing about that container. Three separate conclusions of the form "role X does not
exist in the fleet" were drawn from unreported hosts during this session and all three were wrong.
`fleet_status()` must distinguish `running` / `exited` / `unloaded` / `not_pulled` / `created` /
`unreported` / `unreachable`, and must never collapse the last two into "down".

## 6. What is diagnosed rather than proven

Live queries on the default `searchMode` were measured at 5.1–6.1 s on three of four attempts and
past 20 s on the fourth; a `vector`-mode call exceeded 20 s twice and then returned in 3.4 s. No
probe waited past 20 s, so **none of these observations reached any timeout in §2** and none
establishes that the embedding path is what stalled. The consistent part is that `keyword` mode —
which uses neither embedding nor rerank — never stalled.

Item 6 in the work table exists to close this: instrument first, then tune. Setting a smaller
interactive budget without measuring where the time goes would hide the symptom and lose the
evidence.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Add `embedInteractiveTimeoutMs` to `src/lib/db/config.ts` alongside `rerankInteractiveTimeoutMs`, with the same comment shape. Pick a default deliberately and justify it in the comment — it must exceed a warm embed but not a cold model load. | ☐ |
| 2 | Add `opts?: { interactive?: boolean }` to the embedding provider and select the timeout from it, mirroring `reranker.ts:186-192` exactly. Same option name, same semantics — a differently-named flag meaning the same thing is worse than none. | ☐ |
| 3 | Cap **attempts** as well as per-attempt time on the interactive path. A 3-attempt retry with exponential backoff is a batch policy; one retry, or none, is the interactive one. The per-attempt timeout alone does not bound the call. | ☐ |
| 4 | Thread `interactive: true` from `query_case_knowledge` and from `research_evidence` in `fast` mode. Do not infer it. | ☐ |
| 5 | Reconcile the `rerankInteractiveTimeoutMs` default: `config.ts:95` says 15000, `reranker.ts:191` falls back to 30_000. Decide which is correct and make both say it. | ☐ |
| 6 | Emit a timing breakdown on the interactive embed path — preflight, host resolution, embed, per attempt — mirroring the rerank instrumentation at `reranker.ts:352-357` that exists "to see WHERE the interactive budget went". Land this **before** tuning any value. | ☐ |
| 7 | On interactive exhaustion, fail with a specific, user-facing reason rather than a generic throw. Unlike rerank there is no graceful degrade available, so the honest outcome is a clear error naming the embedding leg — which is what makes `TOOL_NOT_READY` meaningful instead of a silent wait. | ☐ |
| 8 | Amend [task 30](./30-mcp-parity-and-fleet-visibility.md) Part 3 with §5(a), (b) and (c) above, and raise its priority — it is currently P2 while being the only way to distinguish a real rerank from a fallback. | ☐ |
| 9 | Cross-check [task 22](./22-rerank-observability.md): its premise that rerank degradation is invisible predates `reranker.ts:369-375`, which emits a user-facing `warn('degraded', …)` threaded via `onWarning`. Verify whether that warning reaches the MCP response or stops at the deep-search boundary, and correct whichever document is wrong. | ☐ |

## Acceptance

- A live query against a **stopped** embedding host returns an error naming the embedding leg
  within the interactive budget, not after ~370 s.
- The same call from a batch caller still gets the full cold-start tolerance — verified by test,
  not by inspection.
- `config.ts` and the code agree on every timeout default in both files.
- The timing breakdown from item 6 distinguishes cold load from unreachable host in the log.
- No interactive default is changed before item 6 has produced a measurement.

## Risks

- **Tuning before measuring.** A shorter interactive budget will convert a slow query into a fast
  error, which looks like a regression if the underlying host was merely cold. Item 6 first.
- **Capping attempts reduces multi-host resilience.** Retries currently re-resolve and exclude
  failed hosts (`ollama-embedding-provider.ts:150-167`), so a lower attempt cap makes an
  interactive query less likely to route around a single bad host. The bound and the cap must be
  chosen together, not independently.
- **`keep_alive` interaction.** `EMBED_KEEP_ALIVE` (line 133, default `30m`) keeps the model
  resident specifically so searches do not pay repeated cold loads. If cold loads are rare in
  practice, a short interactive budget is cheap; if eviction is common, it will fire often. Item 6
  should report observed cold-load frequency before item 1's default is fixed.
- **A fleet tool leaks infrastructure detail into an MCP surface.** Task 30 already carries this
  risk; §5 does not change it. `local`-only remains the safe default.
