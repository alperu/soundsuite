# MCP Report v4.1 — evidence quality fixes

**Date:** 2026-09-05 · **Baseline:** `0cb5dd8` · **Source report:** `REPORT-v4-connection-verified-evidence-quality.md`
**Task doc:** `docs/tasks/07-mcp-evidence-quality-v4.md`

All examples synthetic. No case numbers, party names, filing titles, or document text.

## Status against the v4 queue

| # | Finding | Status |
|---|---|---|
| 1 | N-1 citation fields on `EvidenceItem` | ✅ Fixed |
| 2 | N-2 default caps, top-level knobs, unknown-key rejection | ✅ Fixed |
| 3 | N-5 run the draft backfill | ⚠️ **Detector bug found and fixed; apply still pending** |
| 4 | N-4 readiness hysteresis | ✅ Fixed — with a better root cause than the brief assumed |
| 5 | N-3 outline model + budget, `null` over a fake outline | ✅ Fixed (model choice unverified — see caveat) |
| 6 | N-8 promote `deep` to jobs; profile the 91 s retrieve | ✅ Promotion fixed; retrieve **diagnosed, not changed** |
| 7 | N-9 / M-5 execute-route auth | ⚠️ **Reduced, not closed** — see §M-5 |
| 8 | N-6 enforce policy on raw request fields | ✅ Fixed |
| 9 | N-7 `structuredContent` | ✅ Fixed |
| 10 | Split Ollama models | Operator — out of scope |
| 11 | SS-3 per-tool tests | Not done — out of scope |

## Verification

- **Typecheck:** 59 errors in 15 files — **byte-identical to the pre-v4 baseline**. No new type errors from any stream.
- **Tests:** `src/lib/mcp` + `src/lib/search` + `src/app/api/mcp` → **579 passed, 0 failed** (39 suites), up from 456 before this round. `src/lib/ingestion` → 63 failed, exactly its pre-existing baseline (poppler/fixture failures unrelated to this work).
- **Lint:** clean on every new and changed file.

## The finding that mattered most: the draft detector had a false-positive bug

v4 item 3 said to run the backfill and verify. Spot-checking the classifications *before* writing
found that **both of the only two documents classified as `draft` were false positives.**

`NOT_FOR_FILING_RE` included a bare `\bNOT\s+FILED\b`, which matched ordinary litigation prose of
the form "*[party] has not filed a supersedeas bond*". That is a statement about what a party did,
not a marker on the document. Applying the backfill would have stamped DRAFT on two genuinely filed
documents — the exact inverse of the guard's purpose — and it would have been invisible, because the
tally simply reported "2 drafts".

`NOT FOR FILING` and `DO NOT FILE` are unambiguous document markers and are retained. The bare form
is gone, with three regression tests including the precise prose shape that triggered it.

**Revised tally: 29 filed / 0 draft / 67 unknown** across 96 documents; 29 would change.

The corpus contains **no detectable drafts**, so the v4 acceptance criterion "confirm the DRAFT
marker appears on at least one item" cannot be met — not because the guard fails, but because there
is nothing to mark. The guard's value here is the `filed` side: it makes the `recordStatus: 'filed'`
filter meaningful and stops the unconfirmed-status prompt rule from firing on those 29 documents.

**Not applied.** `--apply` was blocked by the permission classifier as a bulk DB write, and was not
worked around. The database is backed up at `prisma/data/sound-suite.db.bak-20260905-094335`.

```bash
npx tsx scripts/backfill-draft-status.ts            # dry run — shows exactly what --apply writes
npx tsx scripts/backfill-draft-status.ts --apply    # operator step
```

## N-1 · Evidence is citable again

`EvidenceItem` now carries the full citation family, mapped from the source objects that already
had it:

```
id, documentId, text, score, rerankScore?,
citation?, citationShort?, page?, document?, filingType?, volumeNumber?, caseNumber?, filingSlug?,
blockType?, headingPath?, speakers?, tableMarkdown?, recordStatus?,
hits, source, rlmNote?
```

`page` and `volumeNumber` use a finite-number test rather than truthiness, so page `0` survives.
The mapper stays lossless — no truncation — because `sourcesToEvidence` also feeds routed report
synthesis.

**A correction to the v4 report.** v4 recorded `headingPath: ""` on every item and inferred a
mapping fault. Neither half holds. The projection chain is intact at every hop
(`rowToSearchResult` → `query_case_knowledge` → `pickProvenance` → `sourceToEvidenceItem`), and an
`EvidenceItem` from this path *cannot* carry an empty `headingPath` — both `pickProvenance` and the
mapper drop empty strings. The real cause is a **data gap**: of 35,890 chunks in the live table,
only 4,737 (13%) have a non-empty `heading_path` and 7,180 (20%) have `block_type`, because they
were indexed before those columns existed. The remedy is the existing
`/api/admin/structure-backfill`, not a code change. The `""` in v4 came from a different projection
or client-side defaulting.

## N-2 · Results are bounded

- `EVIDENCE_DEFAULTS = { maxEvidence: 40, maxCharsPerChunk: 1200 }`, applied by default.
- Both knobs accepted at the **top level** as well as under `retrieval` (top level wins). Previously
  a top-level `maxEvidence` was silently ignored.
- Unknown top-level keys now throw `INVALID_PARAMS` naming the key and where it belongs.
  `STEERING_KEYS` keep their existing ignored-and-reported behaviour — they are not errors.
- `maxCharsPerChunk` is applied at the single construction point, so **streamed** evidence is
  bounded too, not only the sync return.
- `stats.caps` reports what was applied so truncation is visible.
- Bug found while scoping and fixed: `RETRIEVAL_KEYS` omitted `decomposeTimeoutMs` and
  `outlineTimeoutMs`, so both v3 timeout knobs were unreachable from tool parameters.

A counter defect caught in review: `chunksTruncated` initially counted truncations across the full
fused pool before the item cap trimmed it, so a 3-item result reported 63 truncations. Now counted
over the returned set.

## N-3 · The outline fails honestly instead of faking it

`buildEvidenceOutline` takes an options object, caps its input to the top 40 items at 400 chars
each (from 150 × 1200 — roughly 40× less prompt), enforces its own 25 s ceiling that a caller
cannot raise, and returns **`null` with a reason** instead of a per-document regrouping. The
heuristic per-document "outline" is gone: a null outline that cost 25 s is honest; a fake one that
cost 60 s is worse than nothing.

**Caveat, stated plainly:** the new small-model default `qwen3:1.7b` is **unverified**. No Ollama
host was reachable from the machine doing the work, so the model is a reasoned default, not a
measurement. `localOutlineModel()` resolves env → preferred tag if present on the host → any small
instruct tag → the decompose model, so it never regresses below today's behaviour — **but the model
swap only helps if an operator has pulled the tag.** The dependable wins are the input cap and the
ceiling. Before the next measured run: `ollama pull qwen3:1.7b` on the completion host, or set
`SS_LOCAL_OUTLINE_MODEL`.

## N-8 · Promotion fixed; the 91 s retrieve is diagnosed, not fixed

A single shared `estimateResearchSeconds` now backs both `routing_explain` and the promotion
decision, so the two cannot diverge. Cloud numbers delegate unchanged to `routed/routing.ts`, with a
parity test across all four tiers. A new local table (`fast: 15, deep: 180, deep-report: 300,
deep-rlm: 300`, from the v4 measurements) puts local `deep` over the 45 s threshold.

**Client-visible consequence:** `fast` is now the only tier `research_evidence` answers
synchronously. `deep`, `deep-report`, `deep-rlm`, and `auto` routing to deep all return a `jobId`.
That is what N-8 asked for, but it changes what a client gets back — poll `research_status`.

**Root cause of the 91 s, found:** the fan-out is genuinely parallel (`specs.map` + `Promise.all`).
The bottleneck is `src/lib/search/reranker.ts:46` — `serializeRerank` is a module-level FIFO chain,
deliberately added because vLLM batches one rerank at a time per GPU. Every sub-query reranks its
own pool, so N sub-queries produce N strictly serialised reranks: ~60 ms/doc over a ≤150-doc pool is
~9 s each, × 8 sub-queries ≈ 72–90 s. **That is a serialisation choice, not fan-out cost.** Per-
sub-query timings are now recorded, so the next run proves it at runtime: summed dispatch ms ≈ wall
clock means serialised.

Not changed this round, per scope. The fix is bounded concurrency (2–3 in flight) or a single
batched rerank after fusion — separate task, needs GPU measurement.

## N-4 · Readiness hysteresis — and the actual cause of the flap

Two consecutive failed smokes are now required before flipping to not-ready; one success recovers;
last-known-good is served in between and surfaced as `degraded` with a reason.

The brief assumed a slow probe. The real cause is better: **a 60 s cache cannot flap in 3 seconds
within one module instance**, so the module was being re-evaluated (dev HMR) and each fresh instance
hit the cold-start path. The state now lives on `globalThis`. A module-level state machine would
have reproduced the original bug.

## N-6 · Fail-closed now means fail-closed

`enforceProvider` runs on the raw `body.provider` before the registry is touched, so `local` +
`provider: "anthropic"` is a 403 `POLICY_VIOLATION` **with or without** an accompanying `model`.
The registry's overlay check remains as defence in depth. The dashboard sends `profile: 'routed'`
explicitly and is unaffected.

## N-7 · `structuredContent`

The bridge emits `structuredContent` alongside the text block when the upstream body is a JSON
object; text-only for arrays, strings, and scalars, since the SDK types the field as a record.
Errors unchanged. The text block is byte-identical to before, so clients that ignore the field do
not regress.

The bridge **pins no protocol version** — it echoes whatever the client requests from the SDK's
supported set, so there was nothing to bump. Verified empirically at `2025-06-18` and `2025-03-26`:
both negotiated the requested version and both received identical `structuredContent`.

**Cost:** the wire payload roughly doubles, since the same data ships twice. With the N-2 caps in
place the practical ceiling is ~40 × 1200 chars rather than the measured 97 KB, so the two changes
offset. Capping was deliberately **not** done in the bridge — it is a forwarder, and size policy
belongs in Sound Suite.

## M-5 · Reduced, not closed — read this before exposing anything

`/api/mcp/execute` now has an auth gate: loopback stays open by default (or the dashboard and the
bridge would break), non-loopback requires a configured API key, a malformed `MCP_AUTH_MODE` refuses
everything, and every refusal names the active mode and the fix. `MCP_AUTH_STRICT_LOOPBACK` is an
opt-in for operators who want loopback gated too (`=1` for both profiles, `=routed` for routed only).

**The limitation is structural and must not be glossed.** A Next.js route handler has no socket peer
address, so origin is inferred from `nextUrl.hostname` / `Host` / `X-Forwarded-For`. A remote caller
who forges `x-forwarded-for: 127.0.0.1` gets past that branch. This reliably stops browser-driven
cross-origin traffic and Cloudflare-tunnelled requests (a browser cannot forge `Host` at all) and
nothing more. **"Auth implemented" is not "safe to publish."** Binding to loopback and the v2 §6.2
Cloudflare interlock remain the real exposure controls.

`MCP_AUTH_MODE=oauth` still verifies no tokens on this route; remote + `oauth` requires an API key,
and the 401 says so. `mcp-server.ts`'s accept-any-Bearer behaviour was deliberately not copied —
v2 already logged it as inert.

## Verified: nothing in the running setup breaks

The chain is Claude Code → proxy `:9191` → bridge over **stdio** → Sound Suite. The proxy never
touches `/api/mcp/execute`; only the bridge makes HTTP calls, and both proxy upstreams set
`SOUND_SUITE_URL=http://127.0.0.1:3000` (checked directly). The dashboard is a same-origin browser
fetch. Current `.env` is `MCP_AUTH_MODE=none` with no keys, which normalises fine.

**One real LAN break:** `admin/server-info` advertises `http://<LAN-IP>:3000/api/mcp/execute`. A
client using that address rather than localhost now needs `MCP_API_KEYS` set server-side and the key
sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`.

## Operator follow-ups

1. **Apply the draft backfill** (`--apply`) — 29 documents become `filed`, 0 drafts. Backup exists.
2. **Sync the bridge**: `cp scripts/mcp-bridge/bridge.mjs ~/sound-suite-bridge/bridge.mjs`, then
   restart the proxy (`~/Code/mcp-proxy/scripts/restart.sh`) — it interrupts the other upstreams it
   hosts, so pick a quiet moment.
3. **`ollama pull qwen3:1.7b`** on the completion host (or set `SS_LOCAL_OUTLINE_MODEL`), otherwise
   the outline resolves back to the decompose model and N-3's model win does not materialise.
4. **Structure backfill** (`/api/admin/structure-backfill`) if `headingPath` / `blockType` coverage
   above 13% / 20% matters — that is a data gap, not a code gap.
5. **Re-measure** `deep` end to end after 2–4. The pre-fix profile was decompose 14.3 · retrieve
   91.3 · pattern 1.1 · fuse 10.4 · outline 60.0.
6. mcp-proxy commit `d36c0a1` in `~/Code/mcp-proxy` is still local and unpushed.

## Still open

- **Retrieval serialisation** (the 91 s) — diagnosed precisely, unchanged. Largest remaining win.
- **SS-3** per-tool tests for the 12 analysis tools.
- **M-5** as above: real exposure control is network-level, not this gate.
