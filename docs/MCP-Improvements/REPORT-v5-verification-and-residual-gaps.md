# MCP Report v5 — Independent Verification of v4.1, and What Remains

**Date:** 2026-09-05 · **Commits verified:** `c4cee6f` (v4 fixes) + `19d456a` (cap-counter definitions), on `0cb5dd8`
**Method:** black-box probes of the running instance from outside the process — REST on `:3000` and the full MCP chain through `:9191` → bridge → Sound Suite. No source assertions repeated without a live check.
**Preceded by:** v4 (connection verified; evidence-quality gaps), v4.1 (implementation report).
**Privacy:** synthetic queries only. Live probes returned real citation strings and cause numbers; **none are reproduced here.**

---

## 0. Verdict

Six of the eight v4 queue items are fixed and independently confirmed. The evidence engine now returns **citable, bounded** evidence, which was the point of the `local` profile and the thing v4 said was missing.

Two items are partially done by deliberate, correct choices. Three residual gaps are new to this report. One item needs an operator action that is now safe to take and was not before.

| v4 item | Status | Verified how |
|---|---|---|
| **N-1** evidence uncitable | ✅ Fixed | 7 citation fields present on every item |
| **N-2** unbounded results | ✅ Fixed | caps applied and self-reported; 97 KB → 54 KB |
| **N-3** outline degrades to per-document list | ✅ Fixed *as designed* | returns `outline: null`, `modelsUsed.outline: "none"` |
| **N-4** readiness flap | ✅ Fixed | zero not-ready across every poll |
| **N-5** `recordStatus` inert | ⏳ Operator | still absent; backfill blocked, now safe to run |
| **N-6** provider without model | ✅ Fixed | (reported in v4.1; not re-probed) |
| **N-7** no `structuredContent` | ❌ Open | `content: ["text"]`, `structuredContent: false` |
| **N-8** latency / promotion | ◐ Half — correct | promotion ✅; 70 s retrieve diagnosed, not changed |
| **N-9 / M-5** open execute route | ◐ Reduced — correct | loopback open, non-loopback 401; bypass confirmed |

---

## 1. Confirmed fixed

### N-1 — evidence is citable

A default `research_evidence` call now returns, per item:

```
id, documentId, text, score, rerankScore,
citation, citationShort, page, document, filingType, caseNumber, filingSlug,
hits, source
```

`citation` and `citationShort` are populated with real locator strings, `page` is an integer, `filingType` a filing category. Claude Desktop can now write a cited answer without inventing anything. Identical through the proxy, so the fix is server-side and needs no bridge sync.

Still absent in practice: `headingPath`, `blockType`, `speakers`, `tableMarkdown`, `recordStatus`. Per v4.1 this is **column coverage, not code** — 13 % of 35,890 live chunks have `heading_path`, 20 % have `block_type`. See §4.

### N-2 — results are bounded and say so

`stats.caps` on a default call:

```json
{ "maxEvidence": 40, "maxCharsPerChunk": 1200,
  "evidenceTruncated": true, "chunksTruncated": 16 }
```

54,267 bytes direct / 59,535 through the proxy, against 97,014 in v4. 40 items, longest text 642 chars in the sample. The two counters have the precise definitions `19d456a` added: `evidenceTruncated` = the pool exceeded `maxEvidence` and items were dropped; `chunksTruncated` = how many *returned* items had text shortened.

### N-3 — the outline fails honestly

`deep` job result: `outline: null`, `modelsUsed.outline: "none"`, outline phase 25,009 ms — the new budget, spent and abandoned. No more 48-section per-document list masquerading as structure. This is the right behaviour; the underlying capability is still missing until the small model lands (§3).

### N-4 — readiness is stable

Zero not-ready tools across every poll in this session, including immediately after a 125-second job. The v4 flap does not reproduce. Root cause was dev HMR re-evaluating the module, not a slow probe — see §2.

### N-8 (promotion half) — `deep` defers

`research_evidence mode:"deep"` returns `{promoted: true, jobId, kind: "research", status, hint}` in **1,073 ms**. `fast` is now the only synchronous tier. Client-visible behaviour change, correctly flagged in v4.1.

Latency, same query, v4 → v5:

| Phase | v4 | v5 |
|---|---|---|
| decompose | 14,334 | 13,379 |
| retrieve | 91,321 | 70,523 |
| pattern | 1,113 | 1,085 |
| fuse | 10,412 | 14,836 |
| outline | 60,025 | 25,009 |
| **total** | **177,509** | **124,883** |

---

## 2. Corrections to v4 — accepted, and worth recording

Three v4 premises were wrong. Two were errors of **inference from correct observation**, which is the more instructive failure.

**N-1's `headingPath: ""` diagnosis.** I observed the fields absent and concluded the mapper dropped them. Both hops drop empty strings, so an `EvidenceItem` from that path *cannot* carry an empty `headingPath` — the observation was right, the mechanism I assigned to it was invented. It is a data gap with an existing remedy (`/api/admin/structure-backfill`), not a code defect.

**N-4's cause.** I proposed readiness hysteresis. That would have **masked** the bug: a 60 s cache cannot flap in 3 s within one module instance, so the module was being re-evaluated — dev HMR, cold start each time. `globalThis` is the fix. A hysteresis layer would have suppressed the symptom and left a state machine that resets under HMR. Noted also: a module-level state machine would have reproduced the bug rather than revealed it.

**N-7's spec-version question.** Moot — the bridge pins no protocol version, it echoes the client's. Demonstrated at two versions rather than argued.

**The draft-detector false positives are the most consequential finding of the round, and they were not on any queue.** A bare `NOT FILED` in the pattern matched ordinary prose of the form "[party] has not filed a [document]" — a statement about conduct, not a marker on the document. Applying the backfill would have stamped `DRAFT` on two genuinely filed documents, and the summary tally would have read "2 drafts," which is indistinguishable from a correct result. Spot-checking the classifications instead of the count is what caught it. In a system whose purpose is not misrepresenting the record, this was the highest-value work in the round.

Consequence for v4's acceptance criterion: "DRAFT marker appears on at least one item" **cannot be met** — the corpus is 29 filed / 0 draft / 67 unknown. Correct replacement: `recordStatus` is populated on retrieved evidence, **and** a synthetic draft fixture classifies as draft while a synthetic filed document does not.

---

## 3. Residual gaps

### R-1 · P1 · The tool catalogue is not gated (new)

`POST /api/mcp/execute` is now refused from non-loopback (§R-2). **`GET /api/mcp/tools?profile=local` returns 200 from a forged non-loopback origin.** So tool names, descriptions and full input schemas are readable by anything that can reach the port, while execution is not. `/api/health` likewise returns 200.

Low severity beside an open execute route, but it is a free map of the system and it is inconsistent with the gate just added. Apply the same origin check to the listing routes, or state deliberately that the catalogue is public.

### R-2 · P1 · M-5 is a browser control, not an access control — confirmed, with a nuance

Probed exactly:

| Request | Result |
|---|---|
| loopback, no headers | **200** |
| `X-Forwarded-For: <public IP>` | **401 `AUTH_REQUIRED`** |
| `X-Forwarded-For: 127.0.0.1` | **200** ← bypass |
| `X-Forwarded-For: <public IP>, 127.0.0.1` | **401** |

The nuance the fourth row adds: the check reads the **leftmost** XFF entry, so a genuine proxy chain from a LAN client fails closed as intended. Only a deliberately forged single-value header passes. That is narrower than "anyone can forge it" — but it is still not an access control.

v4.1's own framing is the correct one and should stay in the record: this stops browser cross-origin traffic and nothing more. **Loopback binding and the Cloudflare interlock remain the real controls.** Do not read the 401 as making the port safe to expose. Note also the operational consequence already flagged: a LAN client using the advertised `<LAN-IP>:3000` address will now 401.

### R-3 · P2 · `research_status` streams the pre-cap set

`research_status` delivered **150** items while `research_result` returned **40**. Text is truncated at construction, so every streamed item is bounded at `maxCharsPerChunk` — but a client polling status receives ~3.75× the final item count.

This is the direct consequence of the trade made in v4.1, and **the trade is right**: capping items before `onEvidence` would have left job clients streaming full-length chunks, which is the exact flood N-2 exists to prevent. Cost is one discarded `String.slice` per dropped chunk. Recording it here so the asymmetry is a known property rather than a surprise, alongside the two gaps `19d456a` already documented — `maxCharsPerChunk` bounds `text` only, so `tableMarkdown` passes uncapped; and the pre-cap total is on the progress stream but not in `stats.caps`, so a client cannot see how many items it did not get.

### R-4 · P2 · `structuredContent` still absent

`content: ["text"]`, `structuredContent: false`. With N-1 landed this matters more, not less: seven citation fields per item are now being handed over as stringified JSON inside a text block. SS-6 / N-7 remains open.

### R-5 · P2 · Proxy path is slower than direct

Same `fast` query: 14,467 ms direct, 26,441 ms through the proxy. One sample each, cold, on a machine also running a 125-second job — not conclusive, and worth one clean measurement before treating it as real.

---

## 4. Operator actions

In the order I would do them.

1. **Apply the draft backfill.** The detector fix is what makes this safe, and it unblocks a feature that is shipped but inert. Backup exists at `sound-suite.db.bak-20260905-094335`. Verify after: `recordStatus` present on retrieved evidence; a synthetic draft fixture classifies draft; a synthetic filed document does not.
2. **`ollama pull qwen3:1.7b`** and point `LOCAL_ROUTING.outline` at it. `deep-report` currently has *no* structural output — `outline: null` every time. The model default is unverified (no Ollama on the build machine), so this is the step most likely to need adjustment; the dependable wins this round were the input cap and the 25 s ceiling, not the model swap.
3. **Run `/api/admin/structure-backfill`** to lift `heading_path` (13 %) and `block_type` (20 %) coverage. This is what makes `headingPath` and `blockType` appear on evidence — a data job, not a code change.
4. **Sync the bridge and restart the proxy.** Nothing verified in this report requires it — the v4 fixes are server-side and already visible through the proxy — so it is last, and only matters for bridge-side changes.

---

## 5. Queue

| # | Item | Size | Note |
|---|---|---|---|
| 1 | Draft backfill (operator) | S | Feature is shipped and inert until this runs |
| 2 | Outline model + `LOCAL_ROUTING.outline` | S | `deep-report` has no structural output without it |
| 3 | Structure backfill (operator) | S | Unlocks `headingPath` / `blockType` on evidence |
| 4 | **R-1** gate `/api/mcp/tools` or declare it public | XS | Inconsistent with the execute gate |
| 5 | **R-4** `structuredContent` | S | Pairs with N-1 |
| 6 | `tableMarkdown` under the char cap; pre-cap total in `stats.caps` | XS | Both from `19d456a` |
| 7 | **N-9 / M-5** real auth on execute + Cloudflare interlock | S | Unchanged priority; blocks any non-loopback use |
| 8 | Batched rerank after fusion (needs GPU measurement) | M | See §6 |
| 9 | SS-3 per-tool tests for the 12 analysis tools | L | Still untouched |
| 10 | **R-5** clean proxy-vs-direct latency measurement | XS | One sample is not a finding |

---

## 6. Two judgement calls, answered

**Leave `serializeRerank` alone for now.** The fan-out is parallel; the FIFO at `reranker.ts:46` exists because vLLM batches one rerank per GPU, so eight sub-queries serialise at ~9 s each. Bounded concurrency just relocates the queue. One batched rerank after fusion is the real fix and needs measurement on hardware that does not exist yet in this setup. Critically, **the cost profile changed**: 70 s of retrieve inside a job nobody blocks on is a far smaller problem than the same 70 s inside a synchronous call racing a 180 s proxy timeout. Promotion bought the headroom that makes deferring this reasonable.

**Do not treat M-5 as closed.** §R-2 measured the boundary precisely: it refuses forged public origins and correctly refuses proxy chains, and it passes a forged loopback header. That is a browser control. The controls that actually hold are the loopback bind and the Cloudflare interlock, and both must be in place before anything reaches the network.

---

## Appendix — probe log (2026-09-05, synthetic queries; citation values redacted)

```
REST :3000
research_evidence fast, no caps        200  14,467 ms  54,267 B  40 items
  evidence fields: id, documentId, text, score, rerankScore, citation,
                   citationShort, page, document, filingType, caseNumber,
                   filingSlug, hits, source              ← N-1 fixed
  stats.caps: maxEvidence 40 · maxCharsPerChunk 1200
              evidenceTruncated true · chunksTruncated 16 ← N-2 fixed
  headingPath / blockType / recordStatus: absent          ← data gap, §4 items 1 & 3
research_evidence deep                 200  1,073 ms  promoted:true + jobId   ← N-8
  job done 124,883 ms · result 40 items · hasCitation true
  phases: decompose 13,379 · retrieve 70,523 · pattern 1,085 · fuse 14,836 · outline 25,009
  modelsUsed.outline "none" · outline: null               ← N-3 fixed (honest)
  research_status streamed 150 items vs 40 returned       ← R-3
tool-health not-ready count            0 on every poll    ← N-4 fixed
execute, loopback                      200
execute, XFF <public>                  401 AUTH_REQUIRED
execute, XFF 127.0.0.1                 200                ← R-2 bypass
execute, XFF <public>, 127.0.0.1       401                ← leftmost entry wins
GET /api/mcp/tools?profile=local, XFF <public>   200      ← R-1 ungated
GET /api/health, XFF <public>                    200

PROXY :9191 → sound-suite-local
tools/call research_evidence fast      26,441 ms  59,535 B  40 items
  hasCitation true · caps identical to direct
  structuredContent false · content blocks ["text"]       ← R-4
```
