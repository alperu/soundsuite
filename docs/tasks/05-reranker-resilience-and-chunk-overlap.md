# Reranker resilience + chunk-overlap tuning

**Status:** Proposed · **Effort:** S · **Priority:** Medium

Two small, well-scoped hardening items surfaced while mapping the retrieval stack for
[`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md). Neither
is a new capability — both tighten existing behavior — hence **S effort**.

---

## Part A — Reranker resilience under a degraded fleet

### Problem / opportunity

The cross-encoder rerank stage is a single point of latency/failure. On a cold or degraded vLLM
fleet, a rerank call can hang up to the **90-second** timeout, and the retry logic explicitly guards
against multiplying that ("Cap at 2 attempts to avoid 90s × N stalls" — `reranker.ts:199`). When all
hosts fail, the code already falls back to first-stage order (`reranker.ts:310`), which is the right
instinct — but a user-facing search can still block for the full timeout before that fallback fires,
and the degraded path isn't surfaced to the caller as a quality signal.

### What we already have

- **Timeout + retry caps:** `const timeoutMs = config.rerankTimeoutMs ?? 90_000` (`reranker.ts:166`);
  retry cap with the "90s × N" comment (`reranker.ts:199`); `AbortSignal.timeout(timeoutMs)` on the
  fetch (`reranker.ts:471`).
- **Preflight + warmup fast-fail:** cached preflight verdict (`reranker.ts:36`),
  `PREFLIGHT_TIMEOUT_MS = 1_500` (`:39`), `WARMUP_TIMEOUT_MS = 10_000` (`:40`) — so a *known-down*
  host fails fast rather than waiting 90s.
- **Graceful degrade to first-stage order:** "All hosts failed — return original order" at
  `reranker.ts:310`, with a structured `error`/`reason` channel (`reranker.ts:132`).
- **Per-GPU serialization:** `serializeRerank()` (`reranker.ts:43`), so one rerank runs at a time.
- **Lifecycle/watchdog:** `reranker-lifecycle.ts`, `reranker-watchdog.ts`.

### Proposed approach

The infra is mostly there; the gap is **bounding user-perceived latency** and **surfacing the
degraded state**. Two changes:

1. **Tiered timeout for interactive vs. batch.** A user-facing search shouldn't wait 90s. Introduce a
   shorter *interactive* `rerankTimeoutMs` (e.g. 8–12s) for the live search path, keeping 90s for
   background/batch jobs. On interactive timeout, fall back to first-stage order immediately (the
   fallback at `:310` already exists).
2. **Propagate "reranker degraded" to the UI.** The structured warning already flows
   (`deep-search.ts:691` passes an `onWarning` callback for reranker fallback). Ensure the search UI
   renders a small "results not reranked (reranker unavailable)" badge so users know answer quality
   is first-stage-only, rather than silently degrading.

### Implementation steps

1. Add `rerankInteractiveTimeoutMs` to the reranker config; thread an `interactive` flag from the
   live search route vs. batch callers; select the timeout in `rerank()` (`reranker.ts:166`).
2. Verify the existing fallback at `reranker.ts:310` fires on interactive timeout (not just on
   host-unreachable) and that it's fast.
3. Surface the degraded warning end-to-end: `onWarning` (`deep-search.ts:691`) → progress/result UI
   in `search-interface.tsx`.
4. Optional: a circuit-breaker that, after N consecutive failures, skips rerank for a cooldown window
   (reuse the preflight cache shape at `reranker.ts:36`) to avoid repeated 1.5s preflight tax.

### Risks / open questions

- **Quality vs. latency tradeoff** of a shorter interactive timeout — measure how often the
  reranker legitimately needs >12s warm vs. only when cold; tune so warm reranks never get cut off.
- **Cold-start interplay:** a short interactive timeout during model load means more first-stage-only
  answers right after a fleet restart; the watchdog warmup should mitigate.

### How to measure success

- p95 search latency when the fleet is cold/degraded drops to the interactive timeout, not 90s.
- Degraded-state badge appears in the UI whenever fallback fires (verifiable by killing the fleet).
- No increase in first-stage-only answers when the fleet is warm.

---

## Part B — Revisit chunk overlap for legal boilerplate

### Problem / opportunity

The legal splitter uses a **50-token overlap on 512-token chunks** (~10%). Legal documents carry
heavy repeated boilerplate (captions, certificates of service, signature blocks). Too little overlap
can split a holding from its reasoning or an exhibit reference from its context across a chunk
boundary; too much inflates the index and feeds the reranker near-duplicate candidates. The current
value was a reasonable default, not a measured one — worth validating now that the rest of the stack
is mapped.

### What we already have

- Default `{ chunkSize: 512, overlapSize: 50, tokenizer: 'huggingface' }` —
  `LegalTextSplitter` constructor at `src/lib/ingestion/legal-text-splitter.ts:194`.
- Overlap is applied in both sentence- and word-splitting paths (`legal-text-splitter.ts:289`–`:300`
  and `:339`–`:349`), built from the tail of the current chunk up to `overlapSize` tokens.
- Legal-structure-aware splitting (ORDER/MOTION/FINDINGS, numbered paragraphs) sits above the overlap
  logic in the same class.

### Proposed approach

Treat overlap as a tunable evaluated against retrieval quality, not a fixed default:

1. Sweep `overlapSize` (e.g. 50 / 96 / 128) and optionally `chunkSize` on a held-out set of legal
   queries with known answer spans; measure recall@K and answer completeness.
2. Consider **structure-aware overlap** — larger overlap *within* a legal section, minimal overlap
   *across* section boundaries (the splitter already detects those boundaries), so context is
   preserved where it matters without duplicating boilerplate.

### Implementation steps

1. Make `chunkSize`/`overlapSize` sweepable via the existing `ChunkConfig`
   (`legal-text-splitter.ts:194`) in an offline eval harness — no production default change yet.
2. Add the eval set (queries + gold answer spans) and a script that re-chunks a sample corpus per
   config and scores retrieval (reuse the fusion-tuning harness from
   [task 04](./04-learned-fusion-weighting.md)).
3. If a clear winner emerges, change the default; otherwise document that 50 is validated.

### Risks / open questions

- **Re-indexing cost:** changing chunking requires re-ingesting; a larger overlap grows the index.
  Quantify both before changing the default.
- **Interaction with the per-doc cap** in `query-case-knowledge.ts:391` — more overlapping chunks per
  doc may hit the cap differently; evaluate jointly.
- **Tokenizer fallback:** overlap is token-counted; confirm behavior under the simple `len/4`
  fallback when the HF tokenizer isn't present (per project memory).

### How to measure success

- Recall@K / answer-completeness improves (or is shown equal) at the chosen overlap vs. 50.
- Index size growth stays within an acceptable bound for the quality gained.
- Fewer "answer split across chunk boundary" failures on the eval set.

## References

- Cross-encoder rerank stage — analysis doc §4. Chunking — analysis doc §4 and
  [`../chunking-research.md`](../chunking-research.md).
- Internal: `src/lib/search/reranker.ts`, `src/lib/search/deep-search.ts`,
  `src/lib/ingestion/legal-text-splitter.ts`, `src/lib/mcp/tools/query-case-knowledge.ts`.
