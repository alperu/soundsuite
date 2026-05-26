# OCR Speedup Plan

Current state (observed 2026-05-26 on the running fleet): a 72-page Reporter's
Record with 21 exhibits takes **7–14 minutes** in the `exhibit-extraction`
stage. Two measured runs:

- `6bbbe532` — 25-905-CV ... Vol 3 of 3 → exhibit-extraction **10m 49s**
- `e9aaa8e9` — 24-513-CV ... Vol 3 of 3 → exhibit-extraction **13m 42s**

Per-call OCR latency is wildly variable: best 4 s, median 30–40 s, worst > 115 s.
This document enumerates the concrete bottlenecks and the fixes ranked by
impact-to-effort.

---

## Root causes (ranked by impact)

### 1. Hardcoded `concurrency: 2` in `exhibit-extractor.ts`

`src/lib/ingestion/exhibit-extractor.ts:357`:

```ts
const ocrQueue = new PQueue({ concurrency: 2 });
```

The admin home page already has an `OCR Concurrency` slider that writes to
`Config.pipeline.ocrConcurrency`. The ingestion pipeline reads it for the
`ocr-fallback` stage (`config.ts:176` → `ingestion-pipeline.ts:146,154`) but
**`ExhibitExtractor` never reads it** — the constructor doesn't take the
value, the queue size is a literal `2`.

Effect: with the slider cranked to 5, exhibit OCR still runs at 2 in-flight.

### 2. Per-attempt timeout is 120 s × 3 attempts = 6 min wasted per stuck OCR

`src/lib/ingestion/ollama-ocr-engine.ts:25`:

```ts
const TIMEOUT_MS = 120_000; // 2 min per attempt
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 3_000;  // 3s → 6s → 12s backoff
```

Worst case for a single failing exhibit: `3 × 120s + 6s + 12s + 3s = 6m 21s`.

In a 21-exhibit document, one truly stuck request blocks the whole queue
lane for 6 minutes. Real OCR latencies cluster at 5–60 s; anything past 60 s
is almost always a stuck/cold host. A 45 s per-attempt timeout would cut the
worst-case to ~2 m 30 s and free the queue to make progress on other images
sooner.

### 3. No OCR host-health watchdog

The reranker has `reranker-watchdog.ts` which marks hosts `unhealthy` after
consecutive failures and `resolveEndpoint` skips them. OCR has no equivalent —
the router keeps routing to a host that has timed out 3 times in a row.

Live evidence (2026-05-26 12:44–12:50): exhibit #7 timed out on
`mcpserver.local`, retried, the router immediately picked **the same host
again**, retried, timed out again, etc.

### 4. Sidecar `activeRequests` counter leaks

The fleet router scores hosts by `sidecarStatus.roles[role].activeRequests`.
On mac-mini that counter was observed at **4640** (live, 2026-05-26 12:57)
when the real number of in-flight requests was at most a handful.

The acquire/release pairing in the sidecar is missing a try/finally — when a
client request aborts/times out, the release call is sometimes skipped and
the counter increments forever until container restart. The router then
treats mac-mini as "permanently saturated" and skews routing toward
mcpserver, which is also saturated.

Cosmetic on its own, but it destroys the load-balancing benefit of the
multi-sidecar architecture. Fix lives in `sideCar/src/lib/handlers.ts`
around the acquire/release handlers.

### 5. Duplicate-model VRAM contention on Ollama hosts

We saw `richardyoung/olmocr2:7b-q8` (8 GB) + `minicpm-v:latest` (8 GB) both
pinned at `keep_alive: 24h` on BASWS35's Ollama (16 GB out of 24 GB locked
on different models when only one was needed). Documented in detail in the
"Master broadcasts model manifest" design discussion — see also
`sideCar/src/lib/idle-timers.ts:56-58` for the keep_alive-keyed eviction
limitation.

Effect on OCR speed: when a fresh request hits a host where the OCR model
isn't currently the hot one, Ollama has to evict another model and load
ours. Cold loads are 30–60 s — observed as the long tail of OCR latencies
(60 s–115 s in the data above).

### 6. Only 2 OCR-assigned hosts in the fleet

Even with all of the above fixed, the maximum useful parallelism is the
number of OCR-running sidecars. Today that's `Alpers-Mac-mini.local` and
`mcpserver.local`. BASWS35 was removed from rotation, BASWS34 is RLM-only,
BASWS41 has the model pulled but isn't assigned to the `ocr` role.

Assigning a third host (BASWS41 has minicpm-v and a 24 GB GPU — currently
running OCR cluster but unutilized) would immediately add 50% headroom.

---

## Proposed fixes (rank-ordered)

| # | Fix | File(s) | Effort | Expected impact |
|---|---|---|---|---|
| 1 | Wire `pipeline.ocrConcurrency` into `ExhibitExtractor` | `exhibit-extractor.ts`, `ingestion-pipeline.ts:142` | 30 min | **~halves exhibit-stage time** with current slider=5 |
| 2 | Cut per-attempt timeout to 45 s, keep 3 retries | `ollama-ocr-engine.ts:25` | 15 min | **Worst-case** per stuck OCR drops from 6 min → 2.5 min |
| 3 | OCR host-health watchdog (mirror reranker-watchdog) | new `ocr-watchdog.ts`, hook into `fleet-router.ts:resolveEndpoint` | 1 day | Router stops re-hitting failing hosts; tail latency drops |
| 4 | Sidecar acquire/release try/finally | `sideCar/src/lib/handlers.ts` | 1 day (incl. rebuild + deploy) | Load score becomes trustworthy; load-balancing actually works |
| 5 | Master broadcasts authoritative model manifest, sidecar evicts orphans | `pushModelRegistry`, sidecar config handler, `idle-timers.ts` | 2 days | Eliminates duplicate-model VRAM contention; cold-load tail disappears |
| 6 | Assign `ss-ocr` to BASWS41 (and any other GPU-capable host with minicpm-v) | `/admin/gpu` UI action | 5 min | Adds a third lane of OCR parallelism |

### Suggested ship order

1. **(today)** Ship #1 + #2 in one commit. They're tiny, self-contained,
   no sidecar deploy needed, and they directly attack the two complaints
   the user surfaced: "concurrency knob doesn't work" and "stuck at 7/21
   forever".
2. **(this week)** Ship #3. Same shape as the existing reranker watchdog,
   so the design pattern is already proven.
3. **(next sprint)** Ship #4 + #5 together since both require a sidecar
   rebuild and deploy.
4. **(operational)** Do #6 anytime — it's a config change in admin UI, not
   a code change.

---

## Concrete code sketch for #1 + #2

### `exhibit-extractor.ts`

Add `ocrConcurrency?: number` to whatever options object the extractor
already takes (or the constructor signature), default to `2` for backwards
compat:

```ts
// near line 357:
- const ocrQueue = new PQueue({ concurrency: 2 });
+ const ocrQueue = new PQueue({ concurrency: this.ocrConcurrency ?? 2 });
```

Then in `ingestion-pipeline.ts:142` pass the value down at construction:

```ts
this.exhibitExtractor = new ExhibitExtractor(
  config.publicDir || 'public',
  pdfParser,
  this.ocrEngine,
  { ocrConcurrency: config.ocrConcurrency }  // new
);
```

(`ocrConcurrency` is already part of `IngestionPipelineConfig` since the
fallback path reads it.)

### `ollama-ocr-engine.ts`

```ts
- const TIMEOUT_MS = 120_000; // 2 min per attempt
+ const TIMEOUT_MS = 45_000;  // 45s per attempt; cold-load tail beyond
+                              //  this is almost always a stuck host
```

Optionally make it configurable via Config like the preflight timeout,
but a literal 45 s is fine for v1 — adjust if real-world data shows
legitimate OCRs taking longer.

Worth adding a logger.warn on the timeout fire so future debugging can
distinguish "timed out our limit" from "host returned 5xx" — currently
both surface as the same `AbortError: aborted due to timeout`.

---

## What this does NOT solve

- **Model quality**: minicpm-v is a 7B vision model; some hard scans
  (handwriting, low contrast, court-stamp overlays) will still take
  multiple seconds even on a perfectly-warm host. The 45 s timeout is
  designed to leave plenty of headroom for legitimate work.
- **VRAM**: if you actually need olmocr2 AND minicpm-v on the same
  host, the model-manifest fix (#5) is the only correct answer — no
  client-side tuning can rescue a host that's swapping models every
  call.
- **Network**: confirmed not the bottleneck — direct probes from master
  to mac-mini Ollama return in 3 ms.
