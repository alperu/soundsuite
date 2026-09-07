# MCP Report v6 — Every v5 / v5.1 Claim Re-Tested Independently

**Date:** 2026-09-07 · **Commit under test:** `931ae89` (unchanged since v5.1) · **Method:** black-box
probes from outside the process — REST on `:3000`, full MCP chain through `:9191` → bridge → Sound Suite.
Every row below was executed, not read.
**Preceded by:** v5 (independent verification), v5.1 (residual gaps closed).
**Privacy:** synthetic queries only. Live probes return real citation strings; none are reproduced here.

---

## 0. Verdict

**v5.1's claims hold up under independent testing. 24 of 25 testable assertions reproduce exactly.**
The one I could not reproduce is a probe-method limitation v5.1 itself documented, not a disagreement.

Two things changed since v5 that were not claimed and are worth recording: **`deep` got 17 % faster**
(124.9 s → 103.2 s, entirely in the retrieve phase), and **`evidenceTotalBeforeCap` now makes the R-3
streaming asymmetry visible to a client** rather than leaving it as tribal knowledge.

The material gap is unchanged and is not an MCP gap: **`/api/config` returns four live provider API
keys in plaintext and is not behind the `/api/mcp/*` guard.** It is reachable from any origin that can
reach the port.

---

## 1. Gating matrix — v5.1 §4, reproduced row for row

Seven of nine rows are testable with `fetch`. All seven match.

| Request | `/api/mcp/tools` | `/api/mcp/execute` | v5.1 said | Match |
|---|---|---|---|---|
| loopback bare | **200** (20 tools) | **200** | 200 / 200 | ✅ |
| `XFF: <public>` | 401 `AUTH_REQUIRED` | 401 | 401 / 401 | ✅ |
| `XFF: 127.0.0.1` | **200** | **200** | 200 / 200 — residual | ✅ |
| `XFF: <public>, 127.0.0.1` | 401 | 401 | 401 / 401 | ✅ |
| `XFF: 127.0.0.1, <public>` | 401 | 401 | 401 / 401 | ✅ |
| `X-Real-IP: 127.0.0.1` | 401 | 401 | 401 / 401 | ✅ |
| `Forwarded: for=127.0.0.1` | 401 | 401 | 401 / 401 | ✅ |
| `Host: public.example` (raw socket) | — | — | 401 | ⚪ not testable via `fetch` |
| dashboard `?profile=all` | **200**, **32 tools** | — | 200, 32 | ✅ |

The `Host` row is unverifiable from the browser pane for exactly the reason v5.1 gives: `fetch`
(undici) normalises the `Host` header, so a forged value never reaches the server. v5.1 flagged this
caveat for anyone repeating v5's method; I hit it, which is corroboration of the caveat rather than
of the row. **Anyone re-testing that row needs a raw socket.**

The `XFF: 127.0.0.1` residual reproduces exactly as documented. v5.1's explanation is the right one
and should stay in the record: Next injects `x-forwarded-for` from the socket peer via `??=`, so a
forged single value is byte-identical to a genuine loopback request. **There is no un-forgeable
per-request signal at this layer.** This is a browser control, not an access control.

### Newly gated routes — all confirmed

| Route | loopback | `XFF: <public>` |
|---|---|---|
| `/api/mcp/tools` | 200 | 401 |
| `/api/mcp/claude-tools` | 200 | 401 |
| `/api/mcp/tool-health` | 200 | 401 |
| `/api/mcp/stats` | 200 | 401 |
| `/api/mcp/execution-history` | 200 | 401 |
| `/api/mcp/tool-config` | 200 | 401 |
| `POST /api/mcp/research` | — | **401** |
| `POST /api/mcp/report` | — | **401** |

R-1 is closed properly — not just the catalogue but the two job-start routes, which v5.1 rightly
calls "arguably a larger hole than R-1 itself" since they start spend-capable work.

### Still outside the guard

| Route | `XFF: <public>` | Note |
|---|---|---|
| `/api/health` | 200 | **Deliberate** — sidecar master discovery. Documented, correct. |
| **`/api/config`** | **200** | **Four live provider API keys, plaintext. §4.** |
| `/api/docs/info` | 200 | low |
| `/api/admin/system-info` | 200 | DB counts, worker state |
| `/api/admin/ai-keys` | 200 | provider names + configured flags |
| `/api/admin/action-logs` | 200 | user activity |
| `POST /api/search/deep` | 200 | **reads case documents and calls an LLM** |

The guard is scoped to `/api/mcp/*` by design (`guardMcpRoute`). That is a defensible boundary for
the MCP work, but it means the largest exposures now sit outside it — see §4.

---

## 2. SS-3 finding #1 — fixed, verified on all ten tools

v5.1's highest-ranked defect: `detect_contradictions({})` filtered on `{caseId: undefined}` and
returned a confident, populated analysis of a scope the caller never named. A false positive, which
outranks a false negative because a client can act on it.

Every one of the ten LLM-backed tools now refuses an empty parameter object, naming the missing field:

| Tool | Response to `{}` |
|---|---|
| `detect_contradictions` | `400 INVALID_PARAMS: caseId is required` |
| `track_claim_evolution` | `400 INVALID_PARAMS: caseId is required` |
| `analyze_citations` | `400 INVALID_PARAMS: caseId is required` |
| `reconstruct_timeline` | `400 INVALID_PARAMS: caseId is required` |
| `extract_entities` | `400 INVALID_PARAMS: documentId is required` |
| `detect_privilege` | `400 INVALID_PARAMS: documentId is required` |
| `analyze_tone` | `400 INVALID_PARAMS: documentId is required` |
| `extract_obligations` | `400 INVALID_PARAMS: documentId is required` |
| `extract_argument_structure` | `400 INVALID_PARAMS: documentId is required` |
| `compare_argument_structures` | `400 INVALID_PARAMS: documentId1 is required` |

Ten for ten. `query_case_graph` behaves the same way — `operation` without `motionId` returns
`400 INVALID_PARAMS: motionId is required for operation 'amendment-lineage'` in ~16 ms.

Findings #2 and #3 (`LLM_PARSE_ERROR`, `LLM_SHAPE_ERROR`) cannot be black-box tested without forcing
a malformed model response; they are covered by the 30 passing tripwires. **#4 and #5 remain open by
instruction** — 12 tripwires still failing — and they matter to a caller: item-level validation is
absent, so `analyze_citations` can return bare strings typed as citation objects, and confidence
coercion means an unscored finding is silently dropped while a string `"0.9"` passes a numeric gate.
That is now in the skill.

---

## 3. Evidence caps, streaming, and latency

### Caps — v5.1 §2 confirmed, six fields present

A `fast` call with `maxEvidence: 12, maxCharsPerChunk: 800`:

```json
{ "maxEvidence": 12, "maxCharsPerChunk": 800, "evidenceTruncated": true,
  "evidenceTotalBeforeCap": 79, "chunksTruncated": 7, "tablesTruncated": 0 }
```

`evidenceTotalBeforeCap` is set unconditionally, and `tablesTruncated` is a separate counter rather
than folded into `chunksTruncated` — both exactly as specified. Keeping them separate was right:
`chunksTruncated` answers "how many items had their *text* shortened", and merging would have
quietly changed what that number means.

### R-3 asymmetry — unchanged, but now visible

Deep job, `maxEvidence: 15`: **150 items streamed** via `research_status`, **15 returned** by
`research_result`, with `evidenceTotalBeforeCap: 150` in the result. The asymmetry is a documented
property of truncating text at item construction (which bounds `onEvidence`) while capping count
after. **The v5.1 addition is that a client can now see the number it did not get**, which was the
open half of this gap. Text remains bounded per item throughout, so the stream is never unbounded —
only longer than the final set.

### Latency — better than v5, and the proxy is not slower

| Phase | v5 (`124,883 ms`) | v6 (`103,169 ms`) |
|---|---|---|
| decompose | 13,379 | 12,921 |
| retrieve | 70,523 | **54,821** |
| pattern | 1,085 | 1,119 |
| fuse | 14,836 | 9,227 |
| outline | 25,009 | 25,057 |

A 17 % improvement, concentrated in retrieve. Nothing in v5.1 claims this, so it is either warm cache
or contention that was present during v5's run — worth one clean re-measure before treating it as a
real gain.

**R-5 confirmed a non-finding.** Same synthetic query, same caps: **direct 12,906 ms, proxy
12,543 ms** — the proxy was marginally *faster*. v5's single cold sample was taken during a
125-second job, exactly as its own caveat allowed.

### The outline still returns `null` — and v5.1 explains why correctly

`modelsUsed.outline: "none"`, `outline: null`, outline phase 25,057 ms (the full budget, spent).

`GET /api/config?resolve=localModels` returns `{"decompose":"qwen3.5:9b","outline":"qwen3.5:9b"}` —
precisely what v5.1 predicted for the genuine Auto path on a host with no small instruct model. The
v5.1 fix made the outline model independently resolvable and admin-selectable; it does not conjure a
model. **`deep-report` will have no structural output until a small instruct tag is pulled.**

v5.1's §3 also corrects v4.1 and v5 on a point worth preserving: the operator step "`ollama pull
qwen3:1.7b`" as previously written **would have done nothing**, because `gather-evidence.ts` resolved
the outline model as `llmModel ?? LOCAL_ROUTING.outline.model` and `llmModel` — the already-resolved
decompose model — always won. `localOutlineModel()` was dead code. Pull *and then select*, or leave
Auto now that Auto can actually find it.

### `structuredContent` — R-4 still open on the installed bridge

Proxy `tools/call`: `structuredContent: false`, `content: ["text"]`. Direct REST is unaffected.
The byte delta is +1,753 (18,152 proxy vs 16,399 direct) — the JSON-RPC envelope, not the ~2× a live
`structuredContent` would produce. **This confirms v5.1 §1: the installed bridge at
`~/sound-suite-bridge/bridge.mjs` is still pre-fix.** The repo copy has the fix. The operator step
has not been run.

---

## 4. The one material gap — `/api/config`

Probed for shape only; **no key values were read into context or reproduced anywhere.**

```
GET /api/config                          → 200
GET /api/config  (XFF: <public>)         → 200      ← not behind the MCP guard
```

Four fields classify as live plaintext secrets by prefix and length: `openaiApiKey` (164 chars),
`claudeApiKey` (108), `geminiApiKey` (53), `groqApiKey` (56). No masking, no gate.

This is worse than an open execute route in kind, not just degree: execute leaks *from* the corpus,
whereas this hands over credentials that can be used anywhere, against billing you own, with no
connection to this machine. It was found incidentally during v5-era probing and reported unfixed.

**It is P1 and it is live now.** Two independent fixes, both small: mask on read (return
`configured: true` and last-4, as `/api/admin/ai-keys` already does), and extend the origin guard
past `/api/mcp/*` to `/api/config`, `/api/admin/*` and `/api/search/deep`.

---

## 5. Scoreboard

| Claim | Source | Result |
|---|---|---|
| Gating matrix, 7 testable rows | v5.1 §4 | ✅ all match |
| `Host: public.example` → 401 | v5.1 §4 | ⚪ needs raw socket; `fetch` normalises Host |
| `XFF: 127.0.0.1` unclosable at this layer | v5.1 §4 | ✅ reproduces; explanation sound |
| Job routes gated | v5.1 §4 | ✅ both 401 |
| `?profile=all` → 32 tools | v5.1 §4 | ✅ |
| `/api/health` deliberately ungated | v5.1 §4 | ✅ 200, documented reason |
| R-1 every `/api/mcp/*` gated | v5.1 §4 | ✅ 6 routes + 2 job routes |
| SS-3 #1 fixed on all 10 tools | v5.1 §5 | ✅ 10/10 named-field refusals |
| SS-3 #4, #5 open | v5.1 §5 | ✅ still open, and caller-visible |
| `stats.caps` six fields | v5.1 §2 | ✅ |
| `tablesTruncated` separate counter | v5.1 §2 | ✅ |
| R-3 asymmetry unchanged | v5.1 §2 | ✅ 150 / 15, now visible via `evidenceTotalBeforeCap` |
| R-5 proxy latency a non-finding | v5.1 §1 | ✅ proxy marginally faster |
| R-4 needs bridge sync | v5.1 §1 | ✅ still `false`; bridge unsynced |
| Outline resolves to 9B, returns null | v5.1 §3 | ✅ both confirmed |
| `?resolve=localModels` endpoint | v5.1 §3 | ✅ returns both tags |
| `/api/config` open with live keys | v6 §4 | ❌ **unfixed, P1** |

---

## 6. Queue

| # | Item | Size | Why here |
|---|---|---|---|
| 1 | **Mask `/api/config`** and extend the guard past `/api/mcp/*` | S | Live credential disclosure |
| 2 | Sync `~/sound-suite-bridge/bridge.mjs`; restart proxy | op | Closes R-4 |
| 3 | Draft backfill | op | Feature shipped and inert; detector fix makes it safe |
| 4 | Pull a small instruct model, select it on Admin → AI Services | op | `deep-report` has no structural output without it |
| 5 | Structure backfill | op | `headingPath` / `blockType` sparse |
| 6 | SS-3 #4 item-level validation, #5 confidence coercion | M | 12 tripwires; both produce wrong values, not errors |
| 7 | Re-measure `deep` cleanly | XS | Is the 17 % real or warm cache? |
| 8 | Raw-socket probe for the `Host` row | XS | Only unverified row in the matrix |

Item 1 is the only one that is not an operator step or a known-open test, and it is the one with
consequences outside this machine.

---

## Appendix — probe log (2026-09-07, synthetic queries)

```
GATING (/api/mcp/tools | /api/mcp/execute)
  loopback bare                     200 n=20 | 200
  XFF <public>                      401 AUTH_REQUIRED | 401
  XFF 127.0.0.1                     200 n=20 | 200          ← residual, as documented
  XFF <public>, 127.0.0.1           401 | 401
  XFF 127.0.0.1, <public>           401 | 401
  X-Real-IP 127.0.0.1               401 | 401
  Forwarded for=127.0.0.1           401 | 401
  ?profile=all                      200 n=32

NEWLY GATED (loopback → XFF <public>)
  claude-tools 200→401 · tool-health 200→401 · stats 200→401
  execution-history 200→401 · tool-config 200→401
  POST research →401 · POST report →401

OUTSIDE THE GUARD (XFF <public>)
  /api/health 200 (deliberate) · /api/config 200 ← 4 plaintext keys
  /api/docs/info 200 · /api/admin/system-info 200
  /api/admin/ai-keys 200 · /api/admin/action-logs 200
  POST /api/search/deep 200

SS-3 #1 — empty params, all ten LLM tools
  400 INVALID_PARAMS naming caseId / documentId / documentId1   (10/10)
  query_case_graph: 400 "motionId is required for operation 'amendment-lineage'" (16 ms)

CAPS / STREAMING / LATENCY
  fast, maxEvidence 12: 12,906 ms · 16,399 B · 12 items
    caps {12, 800, truncated true, totalBeforeCap 79, chunks 7, tables 0}
  proxy same query:     12,543 ms · 18,152 B · 12 items · structuredContent false
  deep job: promoted 822 ms → done 103,169 ms
    streamed 150 (pre-cap) vs returned 15 · evidenceTotalBeforeCap 150
    phases decompose 12,921 · retrieve 54,821 · pattern 1,119 · fuse 9,227 · outline 25,057
    modelsUsed.outline "none" · outline null · hasCitation true
  GET /api/config?resolve=localModels → {"decompose":"qwen3.5:9b","outline":"qwen3.5:9b"}
```
