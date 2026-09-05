# MCP evidence quality — v4 fixes

**Status:** Implemented (2026-09-05) — operator steps pending · **Effort:** M · **Priority:** High · **Source:** `docs/MCP-Improvements/REPORT-v4-connection-verified-evidence-quality.md`

v3 closed the connection problems. The pipeline runs end to end through both profiles. What v4
found is that **the evidence coming out of it is not citable and not bounded**, which defeats the
purpose of the `local` profile: a client cannot write a citable memo from a UUID and a paragraph,
and a 97 KB single-block response floods the caller's context.

## Findings addressed

| # | Finding | Stream |
|---|---|---|
| N-1 | `EvidenceItem` drops the entire citation family the retrieval layer already produces | A |
| N-2 | No default caps; `maxEvidence` only honoured under `retrieval`; top-level knobs silently ignored; `maxCharsPerChunk` unimplemented | A |
| N-3 | Outline burns its 60 s budget every run and degrades to per-document grouping; `gaps` always empty | B |
| N-8 | `deep` at 177.5 s sits 2.5 s under the proxy timeout and is never promoted to a job; retrieve is 91 s | B |
| N-4 | Ollama readiness flaps, so research tools vanish from `tools/list` mid-conversation | C |
| N-6 | `provider` without `model` bypasses the policy choke point and runs locally with a 200 | C |
| N-9 / M-5 | `POST /api/mcp/execute` is unauthenticated while `routed` defaults to a cloud model | C |
| N-7 | Results arrive as one stringified-JSON text block; no `structuredContent` | D |
| N-5 | Draft-record guard inert — backfill never applied | lead |

Also found while scoping: **`RETRIEVAL_KEYS` in `research-params.ts` omits `decomposeTimeoutMs`
and `outlineTimeoutMs`**, so the two timeout knobs added in v3 are unreachable from tool
parameters. Stream A fixes this.

## Binding contracts between streams

File ownership is exclusive — no stream edits another stream's files.

**A — evidence contract.** Owns `research-types.ts`, `evidence-mapping.ts`,
`research/research-params.ts`, `tools/research-evidence.ts`, `search/gather-evidence.ts`,
`presets/preset-schema.ts`.

- Extends `EvidenceItem` with the citation family, all optional:
  `citation`, `citationShort`, `page`, `document`, `filingType`, `volumeNumber`,
  `caseNumber`, `filingSlug`.
- Adds `RetrievalSettings.maxCharsPerChunk`.
- Exports `EVIDENCE_DEFAULTS = { maxEvidence: 40, maxCharsPerChunk: 1200 }` from
  `research-types.ts`.
- `gather-evidence.ts` calls the outline as
  `buildEvidenceOutline(evidence, query, subQueries, outlineOptions)` where
  `outlineOptions: { timeoutMs, model, maxItems, maxCharsPerItem }` comes from
  `LOCAL_ROUTING.outline` (stream B's). A treats a `null` return as "no outline".
- Imports `estimateResearchSeconds` from `research/estimate.ts` (stream B's) for the promotion
  decision in `research-evidence.ts`.

**B — outline and latency.** Owns `search/evidence-outline.ts`, `mcp/routing-defaults.ts`,
`research/estimate.ts` (new), and retrieve-phase instrumentation inside `search/deep-search.ts`.

- Adds `LOCAL_ROUTING.outline = { model, timeoutMs: 25_000, maxItems: 40, maxCharsPerItem: 400 }`.
- `buildEvidenceOutline` accepts the options object and returns `EvidenceOutline | null` — `null`
  with a reason on the event stream, never a per-document re-keying of the input.
- Creates `estimateResearchSeconds(mode, opts): { estimatedSeconds: number; wouldPromoteToJob: boolean }`,
  extracted from whatever `routing_explain` computes today so both callers share one estimate.

**C — policy and health.** Owns `mcp/shared-dependencies.ts`, `app/api/mcp/execute/route.ts`,
`mcp/tool-registry.ts`, `mcp/llm-policy.ts`.

- Readiness hysteresis: two consecutive failed smokes before flipping to not-ready, one success to
  recover, last-known-good served in between.
- `enforceProvider` is applied to the **raw request fields**, not the context overlay, so
  `provider` without `model` is refused rather than silently run locally.
- Auth on `/api/mcp/execute` — see the stream brief for the shape.

**D — bridge.** Owns `scripts/mcp-bridge/bridge.mjs`, its README, `public/docs/install-mcp.md`.

- Emits `structuredContent` alongside the text block when the tool result is JSON.

## Out of scope this round

- SS-3 per-tool tests for the 12 analysis tools (queue item 11, size L).
- Splitting the Ollama models (queue item 10) — infrastructure, operator-side.

## Privacy

All fixtures and probe examples synthetic. No case numbers, party names, or real document text.

## Outcome (2026-09-05)

All four streams landed. See `docs/MCP-Improvements/REPORT-v4.1-evidence-quality-fixes.md`.

| Finding | Status |
|---|---|
| N-1 citation family on `EvidenceItem` | ✅ |
| N-2 caps, top-level knobs, unknown-key rejection, `RETRIEVAL_KEYS` gap | ✅ |
| N-3 outline capped + 25 s ceiling + `null` over a fake outline | ✅ (model default unverified) |
| N-4 readiness hysteresis on `globalThis` | ✅ (real cause was dev-HMR module re-eval, not a slow probe) |
| N-6 policy on raw request fields | ✅ |
| N-7 `structuredContent` | ✅ (payload doubles; N-2 caps offset it) |
| N-8 promotion via shared estimator | ✅ — `fast` is now the only synchronous tier |
| N-8 the 91 s retrieve | Diagnosed only: `reranker.ts:46` `serializeRerank` FIFO, ~9 s × 8 sub-queries |
| N-5 backfill | Detector false-positive fixed; **apply still pending** (29 filed / 0 draft / 67 unknown) |
| N-9 / M-5 auth | Reduced, not closed — loopback detection is a heuristic, not a boundary |

Verification: typecheck byte-identical to baseline; 579 tests pass across mcp/search/api-mcp
(was 456); ingestion at its 63-failure baseline; lint clean.
