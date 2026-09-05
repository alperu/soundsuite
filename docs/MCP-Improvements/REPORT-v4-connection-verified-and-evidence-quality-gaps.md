# MCP Report v4 — Connection Verified End-to-End; Evidence Quality Is Now the Gap

**Date:** 2026-09-05 · **Commit verified:** `0cb5dd8` "draft-record guard + v3 MCP follow-up fixes"
**Basis:** live probes of `:3000` (REST) and `:9191` (proxy → bridge → Sound Suite), plus source read of `src/lib/mcp/**` and `src/lib/search/{gather-evidence,evidence-mapping}.ts`.
**Preceded by:** v3 (verification and gaps). **Privacy:** synthetic queries only; no case content reproduced.

---

## 0. Verdict

**The connection works, end to end, through both profiles.** Every V3 blocker is fixed. A real `tools/call` through the proxy returns real evidence.

What replaces them is a different class of problem: **the evidence being returned is not citable and not bounded.** `EvidenceItem` carries a `documentId` UUID and raw text, and discards the human-readable citation the retrieval layer already produces. A default call returns 97 KB in one text block. Those two things make the evidence engine hard for Claude Desktop to use well, which is the entire purpose of the `local` profile.

| Layer | V3 | V4 |
|---|---|---|
| Proxy `/sound-suite-local/mcp` · `/sound-suite-routed/mcp` | ❌ 404 | ✅ 200 — 20 and 32 tools, 12 routed-only |
| Legacy `/sound-suite/mcp` over-serving 32 tools | ⚠️ live | ✅ removed (404) |
| `tools` route default / unknown profile | ❌ 32 / silent local | ✅ 20 (local) / **400 `INVALID_PROFILE`** |
| Local pipeline `deep` | ❌ hung > 5 min at decompose | ✅ completes — decompose 14.3 s |
| `deep-rlm` job | ❌ never left decompose | ✅ completes 185.6 s, RLM 2 rounds |
| RLM sidecar actually used | ❌ `rlm: "none"` | ✅ `mit-oasys/rlm-qwen3-8b-v0.1` |
| Routed defaults | ❌ resolved to Ollama | ✅ `anthropic/claude-sonnet-5`, `preset:default` |
| Report-language regex over-matching | ❌ "the brief filed in March" → deep-report | ✅ → `fast` |
| `phaseStartedAt` on job status | ❌ absent | ✅ present |
| `tools/call` through proxy | not reachable | ✅ `query_case_knowledge` 5.9 s, `research_evidence` 14.3 s |
| Profile boundary across the bridge | untested | ✅ `preset_list` on local → `TOOL_NOT_IN_PROFILE` |
| **Evidence carries a citation** | not examined | ❌ **§2 N-1** |
| **Result size bounded** | not examined | ❌ **§2 N-2** |
| Outline produced by a model | not reached | ❌ **§2 N-3** — times out, falls back to per-document grouping |
| `recordStatus` populated | n/a (new) | ❌ **§2 N-5** — `null` on every item; backfill not run |
| M-5 security (open execute route) | open | open |

---

## 1. Confirmed working

Worth stating plainly, because it is a lot:

- **Both profiles register and separate cleanly.** `local` lists 20 tools with `providersAllowed: ["ollama"]`; `routed` lists 32 with all six providers. The 12 routed-only tools (`preset_*`, `report_*`, `routing_explain`, `research_report`) are invisible and unreachable from `local`, verified both over REST and through the proxy.
- **Fail-closed provider policy holds** on the path that matters: `provider: "anthropic"` + `model` on `local` → **403 `POLICY_VIOLATION`** in 388 ms, with a message that names the remedy.
- **The router is behaving.** "write a memo summarizing every filing…" → `deep-report` (0.8); "what did the brief filed in March say…" → `fast` (0.65). The v3 M-6a over-match is gone.
- **`routing_explain` is genuinely useful** — returns `tier`, `reason`, `confidence`, `resolved`, `clamps`, `costClass`, `estimatedSeconds`, `wouldPromoteToJob`, `presetUsed`, `defaultsSource`. A client can price a question before spending. This is better than the design asked for.
- **Job machinery works.** `deep-rlm` self-promotes (357 ms), `research_status` reports phase/cursor/`elapsedMs`/`phaseStartedAt`, the NDJSON event stream replays with `seq` from the routing decision onward, `research_result` returns the full payload, `research_cancel` cancels.
- **RLM rounds run on the sidecar.** 2 rounds, 1 tool call, and the round note is captured verbatim in `rlm.notes` — exactly the "why the RLM fetched this" signal the design wanted.

---

## 2. New findings

### N-1 · P0 · Evidence is not citable — the mapping discards the citation

`query_case_knowledge` returns, per hit:

```
text, document, page, score, citation, citationShort,
filingType, volumeNumber, caseNumber, filingSlug, documentId
```

`EvidenceItem`, as delivered to an MCP client, contains:

```
id, documentId, text, score, rerankScore, hits, source
```

**Every human-readable locator is dropped** — `citation`, `citationShort`, `page`, `filingType`, `volumeNumber`, `caseNumber`, `document`. Claude Desktop receives a UUID and a paragraph and is asked to write a citable memo from it. It cannot. It will either omit citations or invent them, and inventing them on litigation material is the worst failure this system can produce.

`evidence-mapping.ts:39-43` maps `blockType`, `headingPath`, `speakers`, `tableMarkdown`, `recordStatus` conditionally — but not the citation family, which the source objects *do* carry. Separately, the structural fields it does map are absent in practice: `headingPath` came back `""` and `blockType` `undefined` on every item sampled, and `query_case_knowledge` does not return them either for this corpus. So the v2 §2.3 claim that structure metadata reaches the caller is **not true today on either route**.

**Fix:** add the citation family to `EvidenceItem` and pass it through in `evidence-mapping.ts` (`citation`, `citationShort`, `page`, `filingType`, `caseNumber`, `document`). Separately, determine whether `headingPath`/`blockType` are unpopulated in the chunk store or dropped before the mapper — the answer decides whether that is a mapping fix or an ingestion one.

**Acceptance:** every `EvidenceItem` carries a string a person could look up, and a synthesized answer can cite without seeing a UUID.

---

### N-2 · P0 · Unbounded result size — 97 KB in one text block

`research_evidence` with `mode: "fast"` and no cap returned **80 evidence items, 97,014 characters** in a single `text` content block. That is roughly 24 K tokens for one tool call, on the *cheapest* tier.

The cap exists — `retrieval.maxEvidence` — and works (5 items → 6.5 KB). But it is **nested under `retrieval` and defaults to unbounded**, so the default behaviour of the flagship tool is to flood the caller's context. v2.1 §4.1 specified `maxEvidence: 40` and `maxCharsPerChunk: 1200` as defaults; neither is applied.

Two related sharp edges:
- A top-level `maxEvidence` (the obvious place for a model to put it) is **silently ignored** — no error, no warning, no clamp. I made this mistake myself on the first probe.
- `maxCharsPerChunk` is not implemented at all; individual chunks ran ~1,100 characters by luck, not by policy.

**Fix:** default `maxEvidence: 40` and `maxCharsPerChunk: 1200`; accept the two knobs at top level as well as under `retrieval`; reject unknown top-level properties with a clear error rather than dropping them; report the applied caps in `stats` so truncation is visible.

---

### N-3 · P1 · The outline never runs — it times out and degrades to per-document grouping

Both deep runs reported `modelsUsed.outline: "heuristic-fallback"`. The event stream says why:

> `outline failed (Ollama completion aborted by caller) — using per-document grouping (31 sections)`

The outline call burns its **full 60-second budget** and then produces one "section" per document: 48 sections for 150 items, 31 for 83. That is not an outline; it is the input list re-keyed. The `gaps` array — the single most valuable thing the outline was specified to produce ("no filing found addressing X") — came back empty both times.

So the "template" tier that motivated `deep-report` is, in practice, absent. The decompose fallback added in this commit is working as designed (14.3 s, under its 20 s budget); the outline fallback is firing every time and returning something with no structural signal.

**Fix:** the outline needs a smaller, faster model than the 9 B used for decompose — this is constrained JSON extraction over already-retrieved text, well within a 1.5–3 B instruct model. Give it its own entry in `routing-defaults.ts` (`LOCAL_ROUTING.outline`), cut the budget to 25 s, and cap the evidence it sees (top 40 by score, 400 chars each) rather than all 150. If it still fails, return `outline: null` with a reason instead of a per-document list that costs a minute and says nothing.

---

### N-4 · P1 · Ollama readiness flaps, so the research tools vanish from the catalog mid-session

Within a three-minute window, `/api/mcp/tool-health` reported `research_evidence` and `research_start` as **not ready** — "Missing required dependency: Local LLM (Ollama)" — and then, on two polls three seconds apart, reported **zero** not-ready tools. During the not-ready window those same tools had just executed successfully.

The generation smoke added for V3 M-1 is doing its job — it is detecting that Ollama cannot answer within budget — but the consequence is that the bridge (which filters on `ready`) will **drop the research tools from `tools/list` and fire `listChanged`** while a conversation is in progress. From Claude Desktop's side the tool it was about to call simply disappears.

This is the same root cause as N-3 and the 14.3 s decompose: **one Ollama host is thrashing between the embedding model and a 9 B completion model.**

**Fix:** hysteresis on the readiness signal — require two consecutive failed smokes before flipping to not-ready, and one success to recover; keep serving the last-known-good value in between. Underneath that, split the models (small decompose/outline model with `keep_alive`, embedding pinned) so the smoke stops failing. A tool that works should not disappear because the probe was unlucky.

---

### N-5 · P1 · The draft-record guard is inert — `recordStatus` is `null` on every item

The headline feature of this commit is a guard against citing never-filed drafts as filed. The plumbing is real: detector, `Document.tags.recordStatus`, a `record_status` chunk column, `EvidenceItem.recordStatus`, a `query_case_knowledge` filter, prompt rules, an amber badge.

**Every evidence item returned in every probe had `recordStatus: null`**, and `query_case_knowledge` does not return the field at all. The commit message says the backfill has not been applied, so this is expected — but the effect is worth stating: the corpus is currently 100 % "unknown," the DRAFT marker never appears, and the prompt rule that forbids asserting filed status for unconfirmed documents will, correctly, fire on *everything*. Either it is suppressing all filing assertions, or it is being ignored — and neither is the intended behaviour.

**Fix:** run the backfill (dry-run first, spot-check a known draft and a known filed document), then re-probe to confirm `recordStatus` is populated and that the DRAFT marker appears on at least one item.

---

### N-6 · P2 · `provider` without `model` is silently ignored rather than refused

`execute/route.ts:76-78` only writes `aiProvider` into the context overlay when **both** `provider` and `model` are present. `tool-registry.ts:241` then calls `enforceProvider(profile, contextOverlay?.aiProvider)`. So a `local` call carrying `provider: "anthropic"` with no `model` sees `undefined`, resolves to `ollama`, and returns **200**.

**No data leaks** — the request never reaches Anthropic; it silently runs locally. But it is fail-*soft* where the design says fail-closed, and the caller is told nothing. Enforce on the raw request fields, not the overlay.

### N-7 · P2 · Still no `structuredContent`

Results arrive as one `text` block containing stringified JSON (`content: ["text"]`, `structuredContent: false`). SS-6 remains open. With N-1 fixed this matters more, not less — citation fields should arrive as data.

### N-8 · P1 · Latency is now the ceiling

Measured, warm, sequential:

| Tier | Total | Breakdown |
|---|---|---|
| `query_case_knowledge` (proxy) | 5.9 s | — |
| `research_evidence` fast (proxy) | 14.3 s | retrieval only, no LLM |
| `deep` | **177.5 s** | decompose 14.3 · retrieve 91.3 · pattern 1.1 · fuse 10.4 · outline 60.0 |
| `deep-rlm` job | **185.6 s** | + 2 RLM rounds |

`deep` at 177 s is **inside** the proxy's 180 s `callTimeoutMs` by 2.5 seconds. It is not promoted to a job (only `deep-rlm` is), so a sync `deep` call through Claude Code will time out on any slower day. Retrieval at 91 s for 8 sub-queries is the largest single cost and was not measured in V3.

**Fix:** promote `deep` and `deep-report` to jobs above a predicted threshold (`routing_explain` already computes `estimatedSeconds` and `wouldPromoteToJob` — use the same estimate to decide), and profile the retrieve phase; 11 s per sub-query suggests the fan-out is not actually parallel, or is queueing on the reranker.

### N-9 · M-5 security — unchanged and still first

Not re-audited; spot-checked as still open. `POST /api/mcp/execute` takes every request with no authentication, and the `routed` profile now resolves to `anthropic/claude-sonnet-5` by default — so an unauthenticated caller can spend API credit and send case text to a third party. The v2 §6.2 Cloudflare interlock and admin-route auth remain the prerequisites for any exposure beyond loopback.

---

## 3. Queue

| # | Item | Size | Why here |
|---|---|---|---|
| 1 | **N-1** citation fields on `EvidenceItem` | S | Without it the evidence engine cannot produce a citable answer — this is the product |
| 2 | **N-2** default caps (40 items / 1200 chars), accept top-level knobs, reject unknown params | S | 97 KB per call is unusable in practice |
| 3 | **N-5** run the draft backfill and verify | S + op | The guard shipped; it does nothing until this runs |
| 4 | **N-4** readiness hysteresis | XS | Tools disappearing mid-conversation is worse than a slow tool |
| 5 | **N-3** small model + tighter budget for the outline; `outline: null` over a fake one | S | `deep-report` currently has no structural output |
| 6 | **N-8** promote `deep`/`deep-report` to jobs by estimate; profile the 91 s retrieve | M | 2.5 s of headroom under the proxy timeout is not headroom |
| 7 | **N-9 / M-5** execute-route auth + Cloudflare interlock | S | Unchanged priority; blocks anything non-loopback |
| 8 | **N-6** enforce policy on raw request fields | XS | Fail-closed should mean fail-closed |
| 9 | **N-7** `structuredContent` | S | Pairs with #1 |
| 10 | Split Ollama models: small decompose/outline with `keep_alive`, embedding pinned | S | Root cause under N-3, N-4, and half of N-8 |
| 11 | SS-3 per-tool tests for the 12 analysis tools | L | Still untouched |

Items 1–3 are a day's work and turn a working pipeline into a useful one. Item 10 is the infrastructure change that makes 5, 4, and part of 8 stop recurring.

---

## Appendix — probe log (2026-09-05, synthetic queries)

```
REST :3000
GET  /api/mcp/tools?profile=local            200  20 tools  providersAllowed:["ollama"]
GET  /api/mcp/tools?profile=routed           200  32 tools  6 providers
GET  /api/mcp/tools                          200  20 tools  profile:"local"        ← M-2 fixed
GET  /api/mcp/tools?profile=bogus            400  INVALID_PROFILE                   ← M-2 fixed
POST /api/mcp/local  (JSON-RPC)              404  (SS-1b not started — expected)
execute local + provider:anthropic + model   403  POLICY_VIOLATION  388 ms
execute local + provider:anthropic, no model 200  silently ran on ollama            ← N-6
execute local preset_list                    404  TOOL_NOT_IN_PROFILE
routing_explain "write a memo…"              200  deep-report 0.8 → anthropic/claude-sonnet-5, preset:default
routing_explain "the brief filed in March…"  200  fast 0.65 → ollama                ← M-6a fixed
routing_explain "trace how … evolved"        200  deep-rlm, cost:high, est 75 s, wouldPromoteToJob:true
research_evidence deep                       200  177,509 ms  8 subQ  150 evidence
   phases: decompose 14,334 · retrieve 91,321 · pattern 1,113 · fuse 10,412 · outline 60,025
   modelsUsed: decompose ollama/qwen3.5:9b · rerank Qwen3-Reranker-8B · outline heuristic-fallback
research_evidence auto (chronology)          200  promoted → jobId in 357 ms
   research_status: phase fuse @88 s, phaseStartedAt present
   research_result: done 185,648 ms · 83 evidence · rlm 2 rounds / 1 tool call
   event: "outline failed (Ollama completion aborted by caller) — per-document grouping (31 sections)"
tool-health                                  not-ready [research_evidence, research_start] → 0 → 0   ← N-4 flap
query_case_knowledge fields                  text, document, page, score, citation, citationShort,
                                             filingType, volumeNumber, caseNumber, filingSlug, documentId
EvidenceItem fields                          id, documentId, text, score, rerankScore, hits, source   ← N-1
research_evidence fast, no cap               80 items · 97,014 chars                 ← N-2
research_evidence fast, retrieval.maxEvidence:5   5 items · 6,525 chars              (cap works)
recordStatus across all probes               null                                    ← N-5

PROXY :9191
/sound-suite/mcp                             404  (legacy upstream removed)          ← M-2 fixed
/sound-suite-local/mcp    initialize+list    200  20 tools, 0 routed-only, caps incl. logging
/sound-suite-routed/mcp   initialize+list    200  32 tools, 12 routed-only
  tools/call query_case_knowledge            5,900 ms   isError:false
  tools/call research_evidence fast          14,304 ms  isError:false  97 KB text block
  tools/call preset_list (on local)          isError:true  TOOL_NOT_IN_PROFILE
```
