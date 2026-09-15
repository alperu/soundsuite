# Sidecar LLM roles → OpenRouter: what works, and four defects

**Status:** Audited live 2026-09-16 against the running fleet · **Priority:** one P1, three P2
**Scope:** the LAN layer — sidecar roles falling out to OpenRouter. **Not** the AI Keys
(WAN) provider picker, which is a separate concern and deliberately untouched.

---

## The model

Two independent layers, easy to conflate:

| | **AI Keys (WAN)** | **Sidecar roles + OpenRouter (LAN)** |
|---|---|---|
| what | anthropic / openai / gemini / groq / grok | embedding, code-embedding, reranker, completion, rlm |
| key lives | `/admin/ai-keys` | **`/admin/openrouter`** |
| chosen by | the user, per query | the operator, per role, via `virtualInference.mode.<role>` |
| OpenRouter's part | not a member | **cloud spillover for a fleet role** |

OpenRouter is infrastructure standing in for a GPU, not a provider the user picks.
That is why `getAvailableProvider()` returning `'ollama'` is correct: `'ollama'`
means "the LAN inference layer", which internally may resolve to OpenRouter.

---

## Verified working — live search, 2026-09-16

Captured from `logs/dashboard.log` during one real `/api/search/semantic` run:

| role | evidence |
|---|---|
| **embedding** | `[OpenRouterEmbeddingProvider] Embedding 50 chunks via OpenRouter qwen/qwen3-embedding-4b (2560d)` — repeatedly |
| **completion** | `[completeAI] Route: completion → cloud:openrouter (deepseek/deepseek-v4.1-flash), orchestrator=true` |
| **reranker** | `[Reranker] Reranking via OpenRouter { model: 'qwen/qwen3-reranker-8b', docs: 48 }` — routed correctly |
| **rlm** | verified separately end to end: master → `:8101` → sidecar → OpenRouter, needle found in 7 s |

**All four sidecar roles do route to OpenRouter.** The wiring is not the problem.

---

## Defect 1 — the reranker reaches OpenRouter and gets 503 · **P1**

```
[Reranker] Reranking via OpenRouter { model: 'qwen/qwen3-reranker-8b', docs: 48, topN: 48 }
[Reranker] OpenRouter rerank failed, falling back to first-stage order
  message: 'OpenRouter /rerank failed: 503 ... "service overloaded, please try again later"'
[Reranker] Rerank degraded — all hosts failed { provider: 'openrouter', candidatesTried: ['openrouter'] }
```

Routing is correct; the **model is unavailable**. Rerank degrades to first-stage
order, so **search quality silently drops** — the answer still returns, ranked
only by the fusion score.

This is the single-provider exposure the design notes already warned about:
`qwen/qwen3-reranker-4b` and `-0.6b` are listed on OpenRouter and served by
nobody, and `-8b` is evidently thin too. One 503 exhausted the candidate list —
`candidatesTried: ['openrouter']`, length one.

**Options, in order:**
1. Check provider count for `qwen/qwen3-reranker-8b` and pick a rerank model with
   several; this is the same criterion that rejected `poolside/laguna-s-2.1`.
2. Retry with backoff before declaring failure — a 503 "try again later" is
   explicitly transient and is currently treated as terminal on the first attempt.
3. Fall back to a *local* reranker when one is running before degrading to
   first-stage order. Today `cloud-only` makes OpenRouter the only candidate.

(1) and (2) are independent and both worth doing. (3) interacts with defect 2.

---

## Defect 2 — `cloud-only` is not honoured by the fleet router · **P2**

`cloud-only` appears **nowhere** in `src/lib/gpu/*.ts`. The only mode gate in
`resolveEndpoint()` is at `fleet-router.ts:1560`:

```ts
if (virtualInferenceModeFor(role, cloudConfig) !== 'local-only') { /* Phase 4 */ }
```

So the router is binary — `local-only` never goes cloud, **everything else goes
cloud only after Phases 1–3 have all failed**. `cloud-only` and `local-first`
are therefore identical in behaviour, and a role set to "OpenRouter Only":

- still uses a local GPU role if one is running — the opposite of the setting
- pays the full local-probe cost on every call when no local role exists

Same class of bug as the RLM path before `cloud-only` was added there
(`stream-rlm.ts` Phase 0), and the fix is the same shape: short-circuit to
Phase 4 when the mode is `cloud-only`.

Note the admin page has offered `cloud-only` for embedding/reranker/completion
for some time, so this is a pre-existing gap, not a regression.

---

## Defect 3 — acquire attempted on a host that has no reranker · **P2**

```
[CommandQueue] WS transport failed for http://10.10.20.134:8098 ... { action: 'acquire',
  error: 'Container "vllm-reranker" not found' }
```

`10.10.20.134` runs `ss-ocr` and `ss-rlm-sandbox` — not `ss-reranker`. With no
`reranker` entry in `state.registry`, the acquire falls back to the sidecar's
legacy `CONTAINER_NAME` default `'vllm-reranker'` (`sideCar/src/lib/state.ts:504`)
and reports a container nobody configured.

Two separate problems:
- something asks a host to acquire a role it was never assigned
- the error names a legacy default rather than saying "this host has no reranker
  role", which sends the reader looking for a container that should not exist

Harmless today (the call fails over) but it is noise in every search, and the
message actively misleads.

---

## Defect 4 — `completion` is never pushed in `allowedModels` · **P2**

`buildOpenRouterPush()` (`fleet-router.ts`) adds `embedding`, `code-embedding`,
`reranker` and `rlm-sandbox`. It does **not** add `completion`, though
`virtualInferenceModeCompletion` is set and `openRouterChatModel` is configured.

Consequences:
- the sidecar's `/api/status` omits `completion` from `modeByRole` and
  `rolesWithModel`, so the fleet view disagrees with the admin page
- a sidecar could not serve completion if ever asked (the `virtual-chat` route
  resolves its model from `allowedModels`)

**Not** currently a functional break for Sound Suite: the master calls OpenRouter
directly for completion via Phase 4, which reads master config
(`cloud-provider.ts:77` → `ctx.config.openRouterChatModel`), never the sidecar's
copy. But it is a silent disagreement between two sources of truth, and it
blocks sidecar-proxied chat for Fantom.

---

## How to re-run this audit

```bash
MARK=$(wc -l < logs/dashboard.log)
curl -s "http://localhost:3000/api/search/semantic?query=procedural%20deadline" > /dev/null
tail -n +$MARK logs/dashboard.log | grep -iE 'rerank|OpenRouter|cloud:|Route:'
```

One search exercises embedding, rerank and completion together. `[RLM]` lines
appear only when a query actually routes to RLM.
