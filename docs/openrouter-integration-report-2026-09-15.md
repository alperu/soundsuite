# OpenRouter integration — implementation report

**Date:** 2026-09-15 · **Branch:** `feat/openrouter-virtual-inference` · **Sidecar:** 2.3.85 → **2.4.0**

Companion to `docs/SPEC-openrouter-virtual-inference.md` (the design). This is what
was actually built, what was verified, and what was deliberately left out.

---

## 1. Verification summary

| Check | Result |
|---|---|
| Master `tsc --noEmit` | **59 errors — exactly the pre-existing baseline**, 0 new |
| Sidecar `tsc --noEmit` | **0 errors** |
| New OpenRouter tests (master) | **52 passing** |
| Full search suite (regression) | **415 passing, 0 failing** |
| Sidecar suite | **79 passing, 0 failing** (24 virtual-inference) |
| Ingestion suite | 63 failing — **identical to the pre-existing baseline**, none OpenRouter |
| Live network calls in tests | **zero** — every suite mocks `fetch` |
| API key in tarball | **clean** |

The 59 master errors are all pre-existing Prisma `$on` typing in `worker-init.ts`
and friends; the diff against the baseline shows only line-number drift.

---

## 2. What was integrated

### 2.1 Reranker — `qwen/qwen3-reranker-8b`

The headline item, because reranking was **CUDA-vLLM-only**, which is why Mac
hosts depend on the Docker Model Runner / vllm-metal path. A hosted reranker
removes that constraint fleet-wide, and carries none of the vector-space risk
because reranking is stateless.

- `src/lib/search/reranker.ts` branches on `rerankProvider === 'openrouter'`.
- OpenRouter's rerank response is **shape-identical** to the existing
  `VllmRerankResponse` (`results[]` with `index` + `relevance_score` +
  `document.text`), verified live, so result mapping is shared via
  `mapRerankResults()` rather than duplicated.
- **Per-provider token budget**: local vLLM stays at 8192 (`--max-model-len`);
  OpenRouter uses the curated 40,960. Raising the constant globally would have
  broken local vLLM; reusing 8192 would have truncated documents for nothing.
- The OpenRouter path skips preflight, the candidate-host loop and
  `rerankerLifecycle` entirely — all three manage a local GPU that isn't there.
- Every `OpenRouterError` kind falls back to first-stage order. Rerank never
  throws to the caller.

**Landmine found and fixed:** the pre-existing `!config.rerankHost` early-exit
would have killed every OpenRouter call before reaching the new branch, since an
OpenRouter-only deployment legitimately has no local host. Now scoped to
`rerankProvider === 'vllm'`, with a regression test.

### 2.2 Embeddings — 4B (2560d) and 8B (4096d)

- New `src/lib/ingestion/openrouter-embedding-provider.ts`.
- `openai-embedding-provider.ts` deliberately **untouched** — a sibling provider
  rather than widening a whitelist, so the three working OpenAI models cannot
  regress.
- `EmbeddingConfig.provider` widened to add `'openrouter'` **and the missing
  `'ollama'`** (an Ollama implementation existed but wasn't in the type).
- Wired into both selection sites: `src/services/worker-init.ts` (ingestion) and
  `src/lib/mcp/get-tool-registry.ts` (**query side** — without it a corpus
  embedded via OpenRouter would be queried with the wrong model).

### 2.3 Search / completion — DeepSeek and friends

`src/lib/ai/models.ts` gains `'openrouter'` as an `AIProviderKey`, seeded from a
curated shortlist. The registry is static and cannot hold 446 dynamic models, so
the full catalogue is browsed at `/admin/openrouter` and resolved at runtime.

Standouts: `deepseek/deepseek-v4-flash` — **1,048,576 context at $0.089/M in** —
and `deepseek/deepseek-v4-flash-0731` at 1,310,720 context. `moonshotai/kimi-k3`
for the largest context, `qwen/qwen3.5-9b` matching the local completion role.

### 2.4 Admin — `/admin/openrouter`

One new tab (the GPU/reranking/RLM/LocalAI panels already existed). Write-only
key field, enable toggle **defaulting off**, searchable/sortable/paginated
catalogue browser, a visually distinct curated embedding/rerank section with a
live availability check, and credits + per-role daily caps.

Catalogue is Redis-cached (`openrouter:models:v1`, 1h) and **trimmed** before
caching — never the raw upstream payload, never the Config table, never the RSC
payload. Degrades to a direct fetch when Redis is unavailable.

### 2.5 Sidecar 2.4.0 — `virtualInference`

- `sideCar/src/lib/virtual-inference.ts` — per-master config, routing decision,
  and the serving path.
- `sideCar/src/lib/openrouter-client.ts` — minimal self-contained client
  (sideCar is a separate package and cannot import the master's).
- New WS commands `virtual-embed` / `virtual-rerank`, scoped to `m.serverUrl`
  exactly as `acquire`/`release` are.

**Per-master scoping** — the requirement that Sound Suite and Fantom MCP expose
different models through one sidecar. Config lives in virtual-inference's own
`processGlobal` map keyed by `serverUrl`, *not* on `MasterConnection` in
`state.ts`. Two consequences, both deliberate: `saveConfig()` cannot serialize a
key it doesn't know exists, and resolution for master M never falls through to
another master's settings. A model outside the requesting master's allow-list is
refused even when a different master permits it — that refusal is the feature.
`retireMaster()` clears the entry so a reused URL never inherits a stranger's key.

---

## 3. The three safety mechanisms

These were not in the original ask. Each addresses a specific way this feature
could do damage.

### 3.1 Dimension guard — the only path that can lose data

`VectorStore.addChunks()` reacts to a schema mismatch by calling `dropTable()`
then `createTable()`. Local `ss-embedding` is `qwen3-embedding:0.6b` at **1024
dims**, and **no hosted model matches it** (Qwen 2560/4096, OpenAI 1536/3072,
Gemini 3072). So an operator switching that role to a cloud model and ingesting
would, unguarded, **destroy the `chunks` table**.

`embed()` enforces `expectedDims` and throws before returning; the sidecar
enforces the same on its own path; `assertDimensionCompatible()` refuses a
provider/table mismatch before anything is written.

### 3.2 Provider pinning — protects the vector space

Every embedding call sends `provider: {order:[pin], allow_fallbacks:false}`.
`qwen3-embedding-4b` has exactly one provider today (DeepInfra), but if a second
joins, OpenRouter may route between them — and two providers serving one model
do not guarantee identical vectors. One logical vector space would silently
become two, degrading recall with **no error anywhere**. Rerank is stateless and
needs no pin.

### 3.3 Spend guard — because this session watched the same bug shape

The min-online loop acquired every 30s forever against a counter nothing
corrected. The identical shape against a metered API **bills**.

`assertSpendAllowed()` alone was decorative: nothing incremented the total, so a
cap could never be reached. Recording now happens centrally in `chargeTokens()`
inside the client, so embeddings and chat are charged too — not just the one call
site that remembered. Prices come from the curated catalogue, **not** from the
`/endpoints` API, which reports `prompt: "0"` for rerank and would charge nothing.

Plus a circuit breaker (5 consecutive failures → 60s cooldown) and
`getCredits()` reading the real remaining balance.

---

## 4. Availability, and how to keep the curated list honest

`GET /api/v1/models` returns 446 **chat** models and **zero** embedding or rerank
models; `?category=embedding` returns 400. There is no enumeration path, so the
embedding/rerank list is curated in code.

But there **is** a validation path, discovered during this work:

```
GET /api/v1/models/{author}/{slug}/endpoints    ← no API key, no billable call
```

It reports the providers actually serving a model plus per-provider pricing.
`scripts/probeOpenRouter.ts` (`npm run probe:openrouter`) uses it over every
curated id and exits non-zero when an **embedding or rerank** model goes dark —
chat misses are reported but non-fatal, since chat has 445 alternatives while
embedding/rerank spaces are pinned with no automatic fallback.

Three response states, and they mean different things:

| State | Meaning | Action |
|---|---|---|
| `endpoints: [...]` | available | use it |
| `endpoints: []` (404) | listed, **no provider right now** | transient — fall back to local, not a config error |
| 400 "does not exist" | wrong id | a real config error |

**Last run: all 15 curated models available, exit 0.**

Models deliberately excluded because they have zero providers:
`qwen/qwen3-embedding-0.6b`, `qwen/qwen3-reranker-4b`, `qwen/qwen3-reranker-0.6b`.

### Cross-package drift guard

`sideCar/` cannot import the master's catalogue, so it mirrors the provider pins
and dimensions by hand. `src/lib/openrouter/__tests__/sidecar-constants-drift.test.ts`
reads the sidecar source as text and asserts the two agree. A stale dimension is
worse than no guard because it *looks* safe; a stale pin silently splits a vector
space.

---

## 5. Logging

The sidecar now logs real work, naming provider, model and requesting master:

```
[virtual-inference] [<master>] embedding via OpenRouter qwen/qwen3-embedding-4b (2560d)
                    — local ss-embedding unavailable: <reason>
[virtual-inference] [<master>] embedding via OpenRouter qwen/qwen3-embedding-4b (2560d)
                    completed in 340ms (128 tokens, 12 vectors)
[virtual-inference] [<master>] rerank via OpenRouter qwen/qwen3-reranker-8b (12 docs)
[virtual-inference] [<master>] local ss-code-embedding available — using local
```

Master side logs `Reranking via OpenRouter {model, docs, topN}` and
`Embedding N chunks via OpenRouter <model> (<dims>d)`.

**No log line contains the key or any prefix of it.** `/api/status` exposes
presence only (`openrouter: 'configured' | 'unset'`) — it is unauthenticated on
the LAN.

---

## 6. Deliberately NOT built

- **The multi-space table migration.** Per-document provider routing needs a
  space registry, `Document` schema fields, and conversion of the 11 hardcoded
  `'chunks'` call sites — see §2 of the spec. With the dimension guard in §3.1
  the cloud providers are selectable **and safe** without it, but one index is
  still one provider. This is the next piece of work.
- **OCR.** PaddleOCR-VL isn't on OpenRouter, and a generic vision model returns a
  different output shape than `assessOcrOutput` is tuned for. Enabling it means
  re-tuning that gate.
- **RLM.** `mit-oasys/rlm-qwen3-8b-v0.1` has no hosted provider.
- **The deep container-creation throw path** in the sidecar is not wired to cloud
  fallback — a deliberate scope call.

---

## 7. Operating it

1. `/admin/openrouter` → paste key → **Enable**.
2. `/admin/reranking` → provider `openrouter`, model `qwen/qwen3-reranker-8b`.
   This is the recommended first move: verified working, stateless, no
   vector-space risk, and it unblocks reranking on every Mac.
3. Set a daily cap per role before enabling anything else.
4. `npm run probe:openrouter` on a schedule — a curated model can go dark when
   its last provider withdraws.
5. Embeddings: only switch a role whose **dimensions match** the existing table,
   or accept a full re-index. `ss-embedding` at 1024d has no hosted counterpart.
