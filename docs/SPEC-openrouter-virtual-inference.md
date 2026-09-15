# Roadmap — OpenRouter virtual inference

Status: **proposal**. Nothing below is implemented.
Written 2026-09-15. Supersedes the "usage-based SaaS options" research note by
selecting OpenRouter as the single cloud aggregator.

---

> **Operator policy, 2026-09-15.** Three rules drive the routing design below:
> 1. **No reranker available locally → use OpenRouter.** Local reranking is
>    CUDA-vLLM-only, so this is what gives Macs a reranker at all.
> 2. **Local GPU unavailable for search/completion → use OpenRouter.**
> 3. **Embedding uses ALL available sources — local and OpenRouter together.**
>    Validated by measurement (§2.4), and legal only across sources serving the
>    same model at the same width.
>
> Rule 3 overturns an earlier prohibition in §3 that was written before the
> equivalence question had been measured.

## 0. What we are building, in one paragraph

Every sidecar gains a **`virtualInference` capability**: when a role's local
model is unavailable — not installed, container down, host offline, VRAM
exhausted — the sidecar can serve that role by calling OpenRouter instead of
local Ollama/vLLM. The OpenRouter key and the list of models each application
is allowed to use are **pushed from the master over the existing WebSocket**,
scoped per master, so Sound Suite and the Fantom MCP server can expose
different model sets through the same physical sidecar. A new `/admin/openrouter`
tab holds the key and browses the live catalogue; the existing GPU, reranking,
RLM and LocalAI panels each gain a routing-mode dropdown. Separately, **each
document can be assigned its own embedding provider** — one doc embedded
locally, the next through OpenRouter — which is supported by giving each
embedding space its own LanceDB table and fanning search out across them (§2).

---

## 1. Verified facts this design rests on

All probed live against `https://openrouter.ai` on 2026-09-15.

| Probe | Result |
|---|---|
| `GET /api/v1/models` | **200 with no API key**, **445 models** |
| Model fields returned | `id`, `name`, `description`, `context_length`, `pricing{prompt,completion,input_cache_read}`, `architecture{modality,input_modalities,output_modalities,tokenizer}`, `supported_parameters`, `top_provider`, `reasoning`, `knowledge_cutoff`, `hugging_face_id`, `canonical_slug` |
| Kimi 3 | **`moonshotai/kimi-k3`** — "MoonshotAI: Kimi K3", context **1,048,576**, modality `text+image+video->text` |
| Vision-capable models | **274 of 445** (`image` in `architecture.input_modalities`) |
| Embedding models in catalogue | **ZERO** |
| Rerank models in catalogue | **ZERO** |
| `?category=embedding`, `?category=rerank`, `?output_modalities=embedding` | **400** — not supported filters |
| `?supported_parameters=embeddings` | 200, but returns 421 *chat* models and no embedders |
| `POST /api/v1/embeddings` | **401** — endpoint exists, key-gated |
| `POST /api/v1/rerank` | **401** — endpoint exists, key-gated |
| `GET /api/v1/credits` | **401** — real balance endpoint, key-gated |
| `GET /api/v1/key` | **401** — real key-metadata endpoint, key-gated |

### The two consequences that shape everything below

**(a) Embedding and rerank models cannot be discovered.** The endpoints work,
but the catalogue does not enumerate them and no filter parameter exposes them.
So `/admin/openrouter` browses 445 live models for chat/RLM/completion/OCR, and
embedding + rerank pickers are fed from a **curated static list in code**. Do
not build the embedding picker expecting the API to populate it — it will
render empty.

**(b) `/api/v1/credits` exists**, so the spend guard in §8 can read the real
remaining balance rather than trusting our own token accounting. That matters:
this session just spent hours on a counter that inflated because nothing
authoritative ever corrected it. Against a paid API the same bug class bills.

### 1.1 Per-role model mapping — PROBED WITH A LIVE KEY

Every row below was tested against the real endpoints on 2026-09-15 with a
temporary API key. These are measured results, not catalogue lookups.

| Role | Local default | OpenRouter model | Probe result |
|---|---|---|---|
| `ss-embedding` | `qwen3-embedding:0.6b` (1024d) | `qwen/qwen3-embedding-0.6b` | ❌ **404 "No endpoints found"** |
| `ss-code-embedding` | `qwen3-embedding:4b` (2560d) | `qwen/qwen3-embedding-4b` | ✅ **200 — measured 2560 dims** |
| — | `qwen3-embedding:8b` (4096d) | `qwen/qwen3-embedding-8b` | ✅ **200 — measured 4096 dims** |
| `ss-reranker` | Qwen3-Reranker-8B | `qwen/qwen3-reranker-8b` | ✅ **200 — correct ranking** |
| `ss-reranker` | — | `qwen/qwen3-reranker-4b` | ❌ **404 "No endpoints found"** |
| `ss-reranker` | — | `qwen/qwen3-reranker-0.6b` | ❌ **404 "No endpoints found"** |
| `ss-completion` | `qwen3.5:9b` | `qwen/qwen3.5-9b` | ✅ in catalogue, 262,144 ctx |
| search | — | `moonshotai/kimi-k3` | ✅ in catalogue, 1,048,576 ctx |
| `ss-ocr` | PaddleOCR-VL-1.6-0.9B | — | ❌ no counterpart (§7) |
| `ss-rlm` | `mit-oasys/rlm-qwen3-8b-v0.1` | — | ❌ no hosted provider |

**Measured dimensions match the local models exactly** — 2560 and 4096. That is
the single most important number here: an OpenRouter space and a local space for
the same model size are dimension-compatible, so §2's per-space tables line up
with the existing local tables without a dimension conversion anywhere.

#### More working embedding models (probed)

The embeddings docs page names other providers; these were tested too:

| Model | Result |
|---|---|
| `openai/text-embedding-3-small` | ✅ **1536 dims** |
| `openai/text-embedding-3-large` | ✅ **3072 dims** |
| `google/gemini-embedding-001` | ✅ **3072 dims** |
| `mistralai/mistral-embed` | ❌ 400 "Model does not exist" |

Those OpenAI dimensions are **exactly** the ones
`src/lib/ingestion/openai-embedding-provider.ts` already whitelists (3-small
1536, 3-large 3072), which confirms §9.1: reaching them through OpenRouter needs
only a `baseURL`, not a new model table.

#### There IS a discovery path after all — `/api/v1/models/{id}/endpoints`

This partially corrects §1(a). The ids are all correct (they match the
`openrouter.ai/qwen` vendor page exactly); the 404s are purely about **provider
availability**, and there is an unauthenticated endpoint that reports it:

```
GET https://openrouter.ai/api/v1/models/qwen/qwen3-reranker-8b/endpoints   → no key needed
```

| Model | Providers serving it |
|---|---|
| `qwen/qwen3-reranker-8b` | **Fireworks** |
| `qwen/qwen3-embedding-4b` | **DeepInfra** — $0.02/M |
| `qwen/qwen3-reranker-4b` | **none** — listed, zero providers |
| `qwen/qwen3-reranker-0.6b` | **none** |
| `qwen/qwen3-embedding-0.6b` | **none** |

So the accurate statement is: embedding and rerank models **cannot be
enumerated** (the catalogue excludes them, so the curated list in §4.3 is still
required) but **can be validated programmatically** — provider list and per-
provider pricing, with no key and no billable inference call.

**This is the mechanism the §4.3 CI probe should use.** It is strictly better
than probing `/api/v1/embeddings`: unauthenticated, free, and it reports *why* a
model is unavailable instead of just failing. Three response states to handle:

- **`endpoints: []`** — listed, no provider. Temporarily unavailable; fall back
  to local, do not treat as a config error.
- **`endpoints: [...]`** — available, and the entry carries the live price.
- **400 "Model does not exist"** — the id is wrong (confirmed with
  `mistralai/mistral-embed`). This one *is* a config error.

A curated entry can go dark when its last provider drops it and can come back
later, so the list is not write-once — run the probe on a schedule.

#### Single-provider models and vector-space stability

Note that `qwen3-embedding-4b` is served by exactly **one** provider (DeepInfra).
That is good for §2: one provider means one stable vector space. But if a second
provider joins, OpenRouter may route between them, and two providers serving the
same model do **not** guarantee identical vectors — which would silently split
one logical space in two.

**Therefore: every embedding call must pin the provider** —
`provider: { order: ["DeepInfra"], allow_fallbacks: false }`. Taking the default
routing for embeddings trades vector-space integrity for availability, which is
the wrong trade. Reranking is stateless and may allow fallbacks freely.

#### Correction to §1(a)

`/api/v1/models` returning zero embedding and zero rerank models is a fact about
**the catalogue, not the API**. These models exist and are individually
documented (`openrouter.ai/qwen/qwen3-embedding-4b` returns real pricing and
context metadata; a fabricated id returns a generic page with no description).
The catalogue simply excludes non-chat models. The §4.3 curated-list design is
still required — discovery is genuinely impossible — but the list is now
**validated**, not speculative.

#### The reranker works, and it is the headline result

```
POST /api/v1/rerank  model=qwen/qwen3-reranker-8b
query: "motion to compel discovery"
  [0] 0.9609  "The court granted the motion to compel discovery…"
  [2] 0.0311  "Discovery sanctions were denied because…"
  [1] 0.0000  "Recipe for sourdough bread…"
```

Correct discrimination, including the near-miss legal document scoring well
above the irrelevant one. Response shape for implementation: `results[]`, each
with `index` and `relevance_score`; request takes `model`, `query`, `documents`,
`top_n`.

Reranking is **CUDA-vLLM-only today**, which is why Mac hosts depend on the
Docker Model Runner / vllm-metal path in `CLAUDE.md`. This removes that
constraint from every Mac in the fleet, and it carries **none of §2's
vector-space risk** because reranking is stateless and persists nothing. It is
the highest-value, lowest-risk item in this document — and it needs neither
Phase 0 nor the per-space work.

#### The `ss-embedding` problem

`qwen3-embedding:0.6b` is the local default for `ss-embedding` and it has **no
OpenRouter counterpart** — only the 4b and 8b sizes are hosted. So that role has
three options, and this is a decision for the operator:

1. Move `ss-embedding` to `qwen3-embedding:4b` so a cloud fallback exists (costs
   local VRAM, and changes dims 1024 → 2560, so it needs a full re-index).
2. Leave it at 0.6b and accept `local-only` for that role permanently.
3. Use per-document routing (§2) to send selected documents to a 4b/8b
   OpenRouter space while 0.6b keeps serving the rest — the spaces are separate
   tables, so the dimension difference is a non-issue.

Option 3 is the one the per-document design makes available, and it is probably
the right answer: no re-index, no VRAM change, cloud capacity where it is wanted.

Note that **no hosted model matches 0.6b's 1024 dims** — not the Qwen sizes
(2560/4096), not OpenAI (1536/3072), not Gemini (3072). So there is no
drop-in cloud fallback for the existing `ss-embedding` space under any option;
options 1 and 2 both accept that, and option 3 routes around it.

#### Calibration note on the circulated mapping

It was **right** about `qwen3-embedding-4b` ($0.02/M, 33K ctx) and
`qwen3-reranker-8b` ($0.20/M) — both confirmed. It was **wrong** about the
0.6B/4B reranker variants and the 0.6B embedding model, none of which have a
provider, and it slightly under-priced `qwen/qwen3.5-9b` ($0.08/$0.13 claimed vs
**$0.10/$0.15** actual). Verify before curating.

#### Spend guard confirmed

`GET /api/v1/credits` returns `{"data":{"total_credits":…,"total_usage":…}}` —
exactly the ground truth §8 needs. The probe cost $0.00000063.

> **Key hygiene:** the key used for this probe was temporary and supplied for
> testing. It is deliberately **not recorded in this document** and must not be
> committed anywhere. Rotate it; §6 governs how the production key is handled.

---

## 2. Per-document provider routing — "doc A local, doc B OpenRouter"

**Verdict: feasible.** One document embedded locally and another through
OpenRouter is a supported design. But the **unit of isolation is the LanceDB
table, not the row** — and that distinction is the whole engineering cost.

### 2.1 Why it cannot be a per-row flag

Facts from the current code:

| Fact | Location |
|---|---|
| **One table, `chunks`**, hardcoded at 11 non-test call sites | `get-tool-registry.ts:72`, `corpus-status.ts:44`, `corpus-denominator.ts:29`, `personas/extract.ts:191`, 7 route handlers |
| `LanceDBRow` has **no provider / model / dims column** | `vector-store.ts` — nothing records which model made a vector |
| Stored dimension is sampled from **ONE row** and cached | `getStoredVectorDimension()` — `this.table.query().limit(1)` |
| Search **throws** on dimension mismatch | `vectorSearch()` → `dimensionMismatchError()`, code `EMBEDDING_DIMENSION_MISMATCH` |
| One embedding provider is built per process from global config | `get-tool-registry.ts:63-94`; query embedded at `query-case-knowledge.ts:304` |

Put a 2560-dim cloud vector and a 1024-dim local vector in the same `chunks`
table and two things happen, both bad:

1. `getStoredVectorDimension()` samples whichever row LanceDB returns first and
   **caches it**. Every subsequent search is validated against a dimension that
   was decided by an arbitrary row.
2. Worse — `addChunks()` has a **drop-and-recreate fallback**: on a schema
   mismatch it calls `this.db.dropTable(...)` then `createTable(...)`. A
   mismatched insert can therefore **destroy the entire corpus table**. This is
   a data-loss path, not just a correctness one.

And even at *matching* dimensions the failure is silent: two providers serving
the same model produce slightly different numbers (quantization, pooling,
normalization differ per serving stack), so a query embedded one way and
compared against vectors embedded the other way just quietly loses recall. No
error anywhere. That is the scenario that shows up weeks later as "search feels
off."

### 2.2 The design that works — table per embedding space

The precedent already exists in this codebase. `src/lib/chat/chat-vector-store.ts`
does exactly this:

```ts
export function chatTableName(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `chunks_chat_${safe}`;
}
```

Generalize it. Each document is routed at ingestion to the table for its
embedding space:

```ts
// chunks__ollama__qwen3_embedding_4b__2560
// chunks__openrouter__qwen_qwen3_embedding_4b__2560
function spaceTableName(provider: string, model: string, dims: number): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
  return `chunks__${safe(provider)}__${safe(model)}__${dims}`;
}
```

- **Ingestion**: the per-document provider choice picks the table. Doc A lands
  in the local table, doc B in the OpenRouter table. Both are first-class.
- **Persist the assignment**: add `embeddingProvider` / `embeddingModel` /
  `embeddingDims` to the `Document` row in Prisma, so a re-index reproduces the
  same routing and the UI can show which provider owns each document.
- **Query**: embed the query **once per distinct space** and fan out, then merge.
- **Registry**: one `Config` row listing active spaces, so query-time fan-out
  does not have to guess from `tableNames()`.

Within any single table there is exactly one model, one provider, one
dimension — so `getStoredVectorDimension()`, the mismatch guard and the
drop-recreate fallback all keep working **unmodified**. That is the reason to
draw the line at the table.

### 2.3 The real cost — merging results across spaces

This is where the honest difficulty is, and it is not in the storage layer.

**Scores from different embedding spaces are not comparable.** An L2 distance of
0.42 in the local space and 0.42 in the OpenRouter space mean different things.
You cannot sort a merged list by raw score.

Three consequences to budget for:

1. **Fusion must be rank-based, not score-based.** The codebase already has the
   right tool — hybrid search uses RRF with a tunable `rrfK` (`SearchQuery.rrfK`,
   default 60). Reuse RRF across spaces: take each table's ranked list, fuse by
   reciprocal rank. Never compare raw distances.
2. **The reranker becomes load-bearing, not optional.** `src/lib/search/reranker.ts`
   already exports `rerank<T extends RerankableResult>()`. A cross-encoder scores
   (query, text) pairs directly and **ignores the embedding entirely**, which
   restores one genuinely comparable ordering over the merged set. With
   multi-space search, rerank stops being a quality nicety and becomes the
   correctness mechanism. Budget for it always being on.
3. **FTS/BM25 shifts too.** Each table carries its own FTS index, and BM25 IDF is
   computed per table — so the same term scores differently in a small cloud
   table than in a large local one. Same fix: fuse by rank, rerank after.

**Latency**: N embeddings + N searches instead of 1. The embeddings parallelize;
the searches parallelize. With two spaces this is not a concern. With ten it is.
Cap the number of active spaces — 2 to 3 is the sane operating range, and the
admin UI should resist creating more.

**Counting breaks.** `corpus-denominator.ts` and `corpus-status.ts` open
`CHUNKS_TABLE` directly and would silently undercount, reporting only the
default space. Both must iterate the space registry. This is the kind of bug
that makes a corpus look half-ingested.

### 2.4 What this means for the equivalence question

Routing whole documents to separate tables **sidesteps vector-space mixing
entirely** — each document's vectors are only ever compared against a query
embedded in the *same* space. So per-document routing does **not** require the
two providers to produce equivalent vectors, and it is not blocked on any
measurement.

The equivalence question survives only in one narrower place: **`local-first`
failover within a single space** (§3), where a local outage mid-run would push
vectors from a different provider into a table that already has one provider's
vectors. That is the case the mode matrix forbids for embedding roles, and the
reason the provider must be pinned per ingestion run.

### MEASURED 2026-09-15 — the equivalence question is now answered

The check described above was run against the live fleet. **Local
`qwen3-embedding:4b` and OpenRouter `qwen/qwen3-embedding-4b` (DeepInfra, pinned)
are close enough to share one index.**

Per-text cosine between the two providers' vectors, both 2560d:

| Fixture | Cosine |
|---|---|
| synthetic legal sentence | 0.985940 |
| a line of source code | 0.984510 |
| synthetic testimony sentence | 0.988858 |

That is **below the 0.99 bar** this document originally set — but the bar was the
wrong test. What matters is not vector identity, it is whether **retrieval
ranking** survives. So a second experiment embedded 8 documents two ways (all
local, vs. alternating local/cloud) and ranked both against the same
locally-embedded query:

- **Ranking order: identical.** Top-3 identical.
- Per-document score shift from using a cloud vector: **max 0.0164, mean 0.0076**
- Inter-rank gaps in the same result set: **0.05 – 0.14**

The perturbation is roughly an order of magnitude smaller than the gaps it would
have to cross, which is why the ordering held. Documents separated by less than
about 0.01 cosine *can* reorder between sources — acceptable, and the reranker
re-scores the merged set downstream anyway.

**Conclusion: mixing local and cloud within one index is safe, and only under one
condition — the same model at the same width.** Mixing `:4b` (2560d) with `:8b`
(4096d) is not merely degraded but unstorable, and would hit the drop-and-recreate
path in §2.1. The `all-sources` mode in §3 therefore verifies model and dimension
agreement across sources before engaging, and falls back to local-only otherwise.

The 0.99 threshold is retained as a **re-test trigger**: if a provider changes,
or a second provider starts serving a model, re-run both experiments rather than
assuming this result carries over.

Reranking and RLM have no such constraint at all — stateless, scored at query
time, nothing persists. They may use every mode.

---

## 3. Routing modes

The request was three modes. We need **four**, because `local-only` is today's
behaviour and must remain expressible (OCR requires it — §7).

| Mode | Meaning |
|---|---|
| `local-only` | Current behaviour. Never calls OpenRouter. Default for every role. |
| `local-first` | Try local; on unavailability fall back to OpenRouter. **This is the mode the request describes** — "if `ss-codeEmbedding` or `ss-embed` is not available, route demand to virtualInference." |
| `hybrid` | Local and OpenRouter both eligible; router picks per-request on load/latency. |
| `cloud-only` | Never touch local GPU. For hosts with no GPU at all. |

### Permission matrix — which roles may take which mode

| Role | `local-only` | `local-first` | `hybrid` | `cloud-only` |
|---|---|---|---|---|
| `embedding` | ✅ | ✅ | ❌ **forbidden** | ✅ |
| `code-embedding` | ✅ | ✅ | ❌ **forbidden** | ✅ |
| `reranker` | ✅ | ✅ | ✅ | ✅ |
| `rlm` | ✅ | ✅ | ✅ | ✅ |
| `completion` | ✅ | ✅ | ✅ | ✅ |
| `ocr` | ✅ | ❌ | ❌ | ❌ |

`hybrid` is forbidden for embedding roles for the reason in §2.1: it would mix
two providers' vectors **inside one table**. The UI must not offer it — not
merely reject it on save.

Even in `local-first`, an embedding role switching provider **must not happen
mid-build**. The provider is resolved once per ingestion run and pinned for its
duration; a mid-run local failure fails the run rather than silently completing
it against the cloud.

**Per-document routing is a separate axis from the mode.** The mode governs what
happens when a role's local model is *unavailable*. Per-document routing (§2) is
a deliberate choice made per document at ingestion, and it is legal for
embedding roles precisely because each choice lands in its own table. The two
compose: a document routed to the OpenRouter space is `cloud-only` for its own
lifetime, whatever the role-level mode says.

### Config keys

Follow the existing per-role convention already used by `gpu.min.<role>` and
`gpu.idle.<role>` in the `Config` table:

```
virtualInference.mode.<role>        local-only | local-first | hybrid | cloud-only
virtualInference.model.<role>       OpenRouter model id, e.g. moonshotai/kimi-k3
virtualInference.enabled            master kill switch, default false
openrouter.apiKey                   SECRET — see §6
openrouter.dailyCapUsd.<role>       spend guard, §8
```

---

## 4. Admin UI

### 4.1 One new tab, not five

The request reads as five pages of work. It is not. `/admin/reranking`,
`/admin/gpu`, `/admin/rlm`, `/admin/localai` and `/admin/ocr` **all already
exist and are already wired**. The work there is one shared control added to
panels that are already rendering.

Only `/admin/openrouter` is new. Adding it means exactly three edits:

1. `src/app/admin/[[...tab]]/page.tsx` — add `'openrouter'` to `VALID_TABS`.
2. `src/components/admin-dashboard.tsx` — add to the `TabKey` union (~line 34),
   the `TABS` array (~lines 40-49), and the render switch (~lines 415-424).
3. New `src/components/admin-openrouter.tsx`.

### 4.2 `/admin/openrouter` — the new tab

- **Key field.** Write-only. Renders as `sk-or-v1-…••••` once set, never round-
  trips the plaintext to the browser. See §6.
- **Live catalogue.** Fetch `/api/v1/models`, render a searchable, sortable
  table: id, context length, modality, prompt price, completion price.
  445 rows — the table needs search and pagination, not a `<select>`.
- **Balance.** `GET /api/v1/credits` for remaining credit, shown next to the
  spend caps from §8.
- **Curated embedding/rerank section.** A separate, visually distinct block,
  labelled as hand-maintained, explaining that OpenRouter does not enumerate
  these. Seed it with the §1.1 verified set — `qwen/qwen3-embedding-4b` (2560d),
  `qwen/qwen3-embedding-8b` (4096d), `qwen/qwen3-reranker-8b` — each carrying its
  **measured** dimension. Entries that 404 (`qwen3-embedding-0.6b`,
  `qwen3-reranker-4b`, `qwen3-reranker-0.6b`) must not be listed; a probe script
  in CI re-validates the list so a silently withdrawn provider surfaces as a test
  failure rather than a runtime 404.

### 4.3 The shared model picker

One component, `<VirtualModelPicker role={...} />`, dropped into each existing
panel. Two data paths behind one interface:

| Consumer | Source | Filter |
|---|---|---|
| RLM, completion, reranker-as-LLM | live `/api/v1/models` | sort by `pricing.prompt`, show `context_length` |
| OCR (if ever enabled) | live, pre-filtered | the **274** with `image` in `architecture.input_modalities` |
| `embedding`, `code-embedding` | **curated static list in code** | n/a — API cannot enumerate |
| rerank | **curated static list in code** | n/a — API cannot enumerate |

### 4.4 Catalogue caching

445 models is a large payload. It must **not** go into the `Config` key-value
table and must **not** be embedded in the RSC payload.

Redis is already in the stack — `getRedis()` / `isRedisAvailable()` in
`src/lib/redis.ts`, used by the worker-pool routes. Cache the catalogue there
under `openrouter:models:v1` with a ~1h TTL, served through a new
`GET /api/openrouter/models` route that degrades to a direct upstream fetch when
`isRedisAvailable()` is false — matching how `src/app/api/worker-pool/state/route.ts`
already handles Redis absence.

---

## 5. Per-master scoping — "Sound Suite gets xyz, Fantom gets abc"

### The problem, stated precisely

`pushFullConfig(agentUrl, …)` in `src/lib/gpu/fleet-router.ts` is keyed by the
**sidecar's `agentUrl`** — not by which master is pushing. Both masters push
into the same sidecar and the result is **last-write-wins**. The
`selfLastConfigPushAt` field exists only to *surface* that collision, not to
resolve it.

So the requested behaviour — different model allowlists per application over the
same WebSocket — **does not exist today** and cannot be bolted onto the current
push path.

### The fix is cheap, because the plumbing already landed

`state.masters` is already a `Map` keyed by `serverUrl`, and the WS dispatch in
`sideCar/src/lib/ws-client.ts` already threads `m.serverUrl` into handlers —
that threading was added for lease ownership (`closeLeasesForOwner(m.serverUrl)`).
The same channel carries per-master config.

**Change:** per-master OpenRouter settings live in the
`state.masters.get(url)` slot, **not** in global `state`:

```ts
interface MasterEntry {
  serverUrl: string;
  authToken?: string;
  wsPort?: number;
  // NEW — scoped to this master, never global
  openrouter?: {
    apiKey: string;              // in-memory only, see §6
    allowedModels: string[];     // this application's allowlist
    modeByRole: Record<string, RoutingMode>;
  };
}
```

Resolution order when a request arrives for role R from master M:

1. `state.masters.get(M).openrouter.modeByRole[R]` — the asking master's mode.
2. If absent, `local-only`. **Never** fall through to another master's setting.

A request whose model is not in the asking master's `allowedModels` is refused,
even if another master has it enabled. That refusal is the feature.

---

## 6. Key handling

### The threat

Two facts make this non-optional:

- The sidecar's `saveConfig()` (`sideCar/src/lib/config.ts`) writes to
  `/app/config/config.json` and **already persists `masters[].authToken`** to
  disk.
- `/api/status` on the sidecar is **unauthenticated on the LAN** — this session
  has been curling it all afternoon with no credentials.

So a key that follows the existing master-config path lands in a plaintext file
*and* is readable by anyone who can reach port 8098.

### Rules

1. **In-memory only.** The pushed `openrouter.apiKey` must never reach
   `saveConfig()`. Add it to the `MasterEntry` in memory and explicitly omit it
   from the object literal `saveConfig()` serializes. A sidecar restart
   re-receives the key on reconnect — that is the intended lifecycle.
2. **Redacted from every sidecar read surface.** `/api/status` and `/api/config`
   must show presence (`openrouterKey: "set"`), never the value.
3. **Masked on the master too.** `src/lib/db/config.ts` maintains
   `SECRET_CONFIG_KEYS` — a set whose comment notes it is "the belt to the
   pattern's braces" alongside a case-insensitive `apiKey` match. `openrouter.apiKey`
   matches that pattern, but **add it to the explicit set anyway**, exactly as
   `embedding.openaiApiKey` and `ai.geminiApiKey` are, so `getPublicConfig()`
   masks it before the RSC payload.

### The alternative we are NOT taking, recorded

**Master-proxied inference**: the sidecar calls back to the master, the master
calls OpenRouter, the key never leaves the master. Strictly safer — no
credential on any fleet host.

Rejected because it adds a hop to every inference and makes the master a
throughput bottleneck for work explicitly designed to run at the edge. Recorded
here so the tradeoff is a decision rather than an accident. Revisit if the fleet
ever spans an untrusted network — the current LAN assumption is what makes
key-push acceptable.

---

## 7. OCR stays local-only

`/admin/ocr` gets **no** virtualInference dropdown, and this is a deliberate
design decision, not an omission:

1. **PaddleOCR-VL 1.6 is not among the 445.** No OpenRouter model is the same
   model.
2. A generic vision model (one of the 274) returns a **different output shape**.
   The `assessOcrOutput` quality gate is tuned against PaddleOCR's structure.
   Feeding it a generic VLM's prose output makes the gate's verdicts
   meaningless.

Enabling cloud OCR later therefore means **re-tuning that quality gate**, which
is its own project. Write that cost down now so a future reader does not treat
it as a dropdown that was forgotten.

---

## 8. Spend guard

This session measured a min-online loop acquiring every 30 seconds, forever,
with zero releases. Against a counter, that inflated a number. **Against a
metered API, the identical bug bills.**

Required before any mode other than `local-only` is enabled in production:

- **Per-role daily cap** — `openrouter.dailyCapUsd.<role>`. Exceeded → the role
  reverts to `local-only` and logs loudly.
- **Circuit breaker** — N consecutive upstream errors opens the circuit for a
  cooldown. Prevents a retry loop against a failing provider from burning
  budget on errors.
- **Balance as ground truth** — poll `GET /api/v1/credits` rather than trusting
  our own token accounting. Our accounting is exactly what failed last time.
- **Every cloud call logged** with role, master, model and cost, so spend is
  attributable to an application.

---

## 9. Provider abstraction

### 9.1 Do not modify `openai-embedding-provider.ts`

The obvious move is to add a `baseURL` to `OpenAIEmbeddingProvider` and relax
its `AVAILABLE_MODELS` whitelist. **Don't.**

That abstraction is already drifting: `EmbeddingConfig.provider` in
`src/lib/ingestion/embedding-provider.ts` is typed
`'transformers' | 'openai' | 'claude'` — it does not list `ollama`, despite an
Ollama path existing. Widening a union that is already lying about its own
membership compounds the problem, and it puts the three working OpenAI models at
risk of regression for no benefit.

Instead: **a new sibling provider**, `OpenAICompatibleEmbeddingProvider`, taking
`(baseURL, apiKey, modelName, dims)`. OpenRouter's `/api/v1/embeddings` is
OpenAI-shaped, so the new class is small, and the existing OpenAI path is
untouched. Widen the union by adding `'openrouter'` — and, while there, add the
missing `'ollama'`.

### 9.2 Phase 4 — reconcile with `SPEC-runpod-overflow.md`

`docs/SPEC-runpod-overflow.md` **already claims a Phase 4** in
`resolveEndpoint()` for RunPod overflow. `resolveEndpoint()` today has Phase 1
(`src/lib/gpu/fleet-router.ts:1173`), Phase 2 (`:1383`) and Phase 3 (`:1409`).

Two specs in one repo both hard-coding "Phase 4" into the same function is a
guaranteed merge conflict and a guaranteed ordering bug.

**Resolution: neither spec gets a hard-coded phase.** Define one interface:

```ts
interface CloudProvider {
  readonly id: string;                    // 'openrouter' | 'runpod'
  canServe(role: string): boolean;
  resolve(role: string, ctx: ResolveCtx): Promise<Endpoint | null>;
}
```

`resolveEndpoint()` gains a single Phase 4 that walks an **ordered list of
`CloudProvider`s read from config**. OpenRouter and RunPod each implement it.
Operators reorder them; neither spec owns the slot. `SPEC-runpod-overflow.md`
should be amended to reference this interface rather than its own phase.

---

## 10. Search model selection

The request names Kimi 3, direct Gemini, and Claude Fable as search options.
These are two different mechanisms and should not be conflated in the UI:

- **Kimi 3** → `moonshotai/kimi-k3` through OpenRouter. Its 1,048,576-token
  context is the reason to want it for search over long documents.
- **Gemini / Claude Fable** → already reachable via the existing
  `AI_PROVIDERS` registry in `src/lib/ai/models.ts` (`AIProviderKey` =
  `'openai'|'anthropic'|'gemini'|'groq'|'grok'|'ollama'`), which has its own
  key handling and primary/fallback chain.

`AI_PROVIDERS` is a **static** `Record` and cannot absorb 445 dynamic models.
Add `'openrouter'` as one more `AIProviderKey` whose model list is resolved at
runtime from the cached catalogue, rather than trying to flatten the catalogue
into the static registry.

---

## 11. Phasing

**Phase 0 — multi-space foundation.** Not a gate, real work, and it is the
prerequisite for per-document routing (§2). Generalize `chatTableName` into
`spaceTableName`; add a space registry in `Config`; add
`embeddingProvider`/`embeddingModel`/`embeddingDims` to the `Document` model;
convert the 11 hardcoded `'chunks'` call sites to resolve their table from the
registry; fix `corpus-denominator.ts` and `corpus-status.ts` to iterate spaces.
Ships with a single registered space — behaviour identical to today, nothing
user-visible — which is exactly what makes it safe to land first.

**Phase 1 — read-only catalogue.** `/admin/openrouter` tab, key storage with
§6 masking, `GET /api/openrouter/models` with Redis caching, the 445-model
browser. No inference anywhere. Ships safely on its own and makes the curated-
list problem concrete.

**Phase 2 — per-master config channel.** Extend `MasterEntry` with the
`openrouter` block, push it scoped per master, enforce resolution order in §5,
verify with two masters that the allowlists genuinely differ. **No key push
yet** — structure first.

**Phase 3 — stateless roles. Start here for value.** `reranker` gets
`local-first` with `qwen/qwen3-reranker-8b` — **verified working** (§1.1), no
persistent state, no vector-space concern, and it unblocks reranking on every Mac
in the fleet. It depends on **neither Phase 0 nor the per-space work**, so it can
run in parallel with everything above and is the recommended first shippable
increment. `rlm` has no hosted counterpart (§1.1), so it stays `local-only` for
now. Key push and the §8 spend guard land here, together — the guard is not a
follow-up.

**Phase 4 — per-document routing + embedding roles.** Needs Phase 0. Query-time
fan-out across registered spaces with RRF fusion, reranker always on (§2.3), a
per-document provider selector at ingestion, and the provider shown per document
in the UI. Role-level modes for embedding: `local-first` and `cloud-only` only;
`hybrid` never offered, provider pinned per run.

**Phase 5 — `CloudProvider` interface.** Refactor Phase 3 of the RunPod spec and
this one onto the shared interface. Amend `SPEC-runpod-overflow.md`.

**Not planned:** OCR (§7).

---

## 12. Open questions

1. **How many embedding spaces should be allowed at once?** Two or three is the
   sane range (§2.3); each one adds a query embedding and a search to every
   request. Needs a hard cap in the UI, and the number should come from measuring
   fan-out latency on the real corpus, not from taste.
2. ~~Do the embedding/rerank ids resolve?~~ **Answered in §1.1** — probed live.
   Working: `qwen3-embedding-4b` (2560d), `qwen3-embedding-8b` (4096d),
   `qwen3-reranker-8b`. Dead: the 0.6b embedding and the 4b/0.6b rerankers.
   Remaining sub-question: which of the three options for `ss-embedding` (§1.1)
   the operator wants.
3. **Does `/api/v1/embeddings` honour `provider.order` / `allow_fallbacks`?**
   Currently moot — `qwen3-embedding-4b` has only DeepInfra — but it becomes
   live the moment a second provider appears. If the pin is not honoured, one
   *logical* space would quietly become several physical ones, so the §2.4
   equivalence check must be re-run
   per provider, not per model — and `allow_fallbacks: false` becomes mandatory
   for embedding calls.
4. **Key rotation.** A rotated key must reach every connected sidecar. The push
   path exists; the trigger does not.
