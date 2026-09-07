# MCP Report v6.1 — surface guard, discovery tools, true-regex scan

**Date:** 2026-09-07 · **Baseline:** `931ae89` · **Source reports:** `REPORT-v6-independent-retest.md`, `MCP-discovery-tools.md`, an operator's live regex report
**Task docs:** `docs/tasks/09-api-surface-guard-v6.md`, `10-mcp-discovery-tools.md`, `11-scan-for-pattern-true-regex.md`

All examples synthetic. No case numbers, party names, filing titles, document text, or key values.

## Status against the v6 queue

| # | Item | Status |
|---|---|---|
| 1 | **Mask `/api/config`; extend the guard past `/api/mcp/*`** | ✅ — plus a second leak (`?key=<secret>`) closed; **sidecar routes exempt, proven** (§1) |
| 2 | Sync bridge; restart proxy (R-4) | ✅ `structuredContent` verified through the proxy |
| 3 | Draft backfill | ✅ **applied** — 29 filed / 0 draft / 67 unknown in the DB |
| 4 | Small instruct model for the outline | ⏳ operator — still none on the host |
| 5 | Structure backfill | ⏳ operator |
| 6 | SS-3 #4 item-level validation, #5 confidence coercion | ✅ all 12 tripwires flipped (§3) |
| 7 | Re-measure `deep` cleanly | ✅ **the 17 % was not real** (§5) |
| 8 | Raw-socket `Host` probe | ✅ 401, with and without a forged loopback XFF |
| — | **Discovery tools** (new request) | ✅ 4 tools, `caseId`/`motionId` on evidence, graph callable for the first time (§2) |
| — | **`scan_for_pattern` true regex** (new request) | ✅ `[Uu]word` 0 → 37, fragment 0 → 37 (§4) |

## Verification

- **Typecheck:** 59 errors in 15 files — byte-identical to the baseline for the fourth round running.
- **Tests:** mcp + search + vector + db + admin + api-mcp/config/admin/search/cases + the admin panel suite → **1,106 passed, 0 failed** (61 suites). Was 914 at `931ae89`. Ingestion at its unchanged 63-failure baseline.
- **Lint:** clean on every new file. `admin-dashboard.tsx` carries 9 pre-existing `react-hooks/set-state-in-effect` errors; the three staged hunks in that file (an import and a type) are nowhere near them.
- **Independently probed by the lead, not only by the agents:** sidecar-shaped request from a non-loopback peer → `gpu-fleet` 200, `sidecars/version` 200, `health` 200; forged remote → `/api/config`, `/api/cases`, `/api/admin/system-info`, `/api/admin/ai-keys`, `/api/docs/info` all 401; loopback `GET /api/config` → **zero raw key values**, only `apiKeys: { configured, last4 }`; `?key=<secret row>` → 403.

## 1. Credential disclosure closed — and the sidecar did not break

**The leak.** `GET /api/config` returned four live provider keys in plaintext from any origin. A
second path, `GET /api/config?key=<row>`, returned a single key value directly. Both closed:

- The five `*ApiKey` fields are **removed** from the GET response (not placeholdered — the AI
  Services panel POSTs the whole config back, so any value left there would overwrite the real key).
  Replaced by `apiKeys: { <provider>: { configured, last4? } }`, the shape `/api/admin/ai-keys`
  already used. `getConfig()` is untouched, so providers still read real values server-side.
- `?key=` refuses credential-bearing rows with 403.
- POST is write-only: a key row is written only if the body carries a non-empty string; absent,
  empty, or whitespace means "leave unchanged". This also fixed a pre-existing bug — the "API key
  required" validation was checking the body alone and 400'd every save from the toolbar re-index
  and the reranking panel. Clearing a key is now an explicit act via the AI Keys panel.
- `/api/config/pipeline` GET returned the **whole** `AppConfig`; masked and gated too.

**The guard.** `guardMcpRoute()` is now a thin adapter over a route-agnostic `guardApiRoute()` with
an opt-in admin-session check; `requireApiAccess` / `requireAdminApiAccess` wrap it for non-MCP
routes. Same `decideExecuteAuth` matrix, same env knobs. Applied to `/api/config` (+ `pipeline`,
`ocr-test`), `/api/cases` GET **and** POST, `/api/search/deep`, `/api/docs/info`, and 22 admin
route files. Loopback stays permissive; a remote caller needs a signed-in admin session or an
`MCP_API_KEYS` credential.

**The sidecar — a hard requirement, and it was nearly missed.** The first cut gated
`GET /api/admin/gpu-fleet`. The sidecar calls it cross-host for master discovery
(`sideCar/src/lib/config.ts:386`) with **no credential** — `User-Agent` is its only header — so a
real sidecar on another host would have received 401 under the shipped `.env`. Caught in review,
exempted with a code comment naming the call site, and covered by a Jest regression guard so it
cannot be re-gated by reflex. Every sidecar-facing route was then re-probed with the sidecar's
exact request shape from a non-loopback peer against a baseline captured *before* any edit:

| Route | Method | remote peer, no credential | Caller |
|---|---|---|---|
| `/api/admin/gpu-fleet` | GET | **200** (exempt) | `config.ts:386` master discovery |
| `/api/admin/gpu-fleet` | POST | 401 (gated) | dashboard only — the sidecar never POSTs here |
| `/api/admin/gpu/sidecars/version`, `download` | GET | **200** (exempt) | `self-update.ts` |
| `/api/admin/gpu/sidecars/heartbeat`, `poll`, `result`, `register` | POST | 400 (exempt; empty-body validation) | `ws-client.ts` |
| `/api/health` | GET | 200 (deliberate, pre-existing) | `config.ts:376` |

Every row byte-identical to the pre-change baseline. A correction to the brief while checking:
`/api/masters`, `/api/status`, `/api/embeddings` are the *sidecar's own* endpoints, not master
routes — they never existed under `src/app/api/` and were never at risk.

**Deliberately left open**, with reasons: `POST /api/admin/auth/login|logout` (must be reachable
to obtain a session); `POST /api/admin/action-logs` (append-only audit sink written by *non-admin*
case pages — a tunnel user there has no session, and gating the write would silently stop them
logging their own activity; GET/DELETE — the disclosure side — are gated). **Out of scope, recorded:**
`/api/cases/[id]/**` (14 routes incl. `upload`, `parse`, `rescan`).

**Privacy fix in passing:** a real-format cause number was found in a docblock in
`src/app/api/cases/route.ts` and replaced with the `00-0000-XX` placeholder. It had been in tracked
source — and therefore git history — until this round.

## 2. Discovery tools — the surface is callable without prior knowledge

Every scoped tool required a UUID and the surface handed out almost none. Retrieval returned the
docket number; the tools wanted the database id. The SS-3 #1 fix was correct but turned a silent
wrong answer into a hard block with no supported way to obtain the argument.

**Item 1 — `caseId` on every evidence item.** It was a **row column all along**: LanceDB chunks
carry `case_id`, `rowToSearchResult` already mapped it to `metadata.caseId`, and it was simply never
projected. Routed through `ChunkProvenance` / `pickProvenance`, so `deep-search.ts`'s four
construction sites picked it up with zero edits — the approach that file's own docblock argues for.
`motionId` where resolvable: `(filingId, page ∈ [startPage, endPage])`, **one** batched
`motion.findMany` per call, narrowest-range-wins tie-break, best-effort. Live: **40/40 evidence
items carry `caseId`, 17/40 `motionId`.** `scan_for_pattern` needed the same projection — without it
23/40 pattern-sourced items had no `caseId`.

**Four tools**, all `local`, no LLM, single query: `list_cases` (exact-`caseNumber` fast path),
`list_motions` (`hasAmendments`), `list_people` (`roles`, derived `motionCount`), and
`resolve_reference` — ranked candidates across kinds with `matchedOn` and `confidence`,
`ambiguous: true` when the top two are within 0.15, computed **before** the limit slice so
`limit: 1` still reports it. It never collapses to one answer. Local profile: **20 → 24 tools.**

A scoring inversion was caught in review: a `??` chain let a `caseNumber` *substring* at 0.7
suppress an *exact* `name` match at 0.9 on the same row. For a tool whose entire output contract is
the confidence, that is the tool publishing a number it does not hold. Fixed — max across matching
fields wins, field priority only as the tie-break — with tests for both.

**`query_case_graph` is callable for the first time** — `amendment-lineage` seeded from an
evidence-carried `motionId` returns 200. Two live zero-counts were **checked corpus-wide and are
data, not code**: no motion in this corpus has a child, `amendsId`, or `supersedesId`; and no
`Person` is linked to any `Motion` (all 20 have `motionCount: 0`). The graph is verified
*callable*, not verified *productive*, until that data is populated.

## 3. SS-3 #4 and #5 — the last twelve tripwires

**Item-level validation**, one shared validator in `ai-helper.ts` fed by a declarative `*_SHAPE`
per tool. The rule, applied identically in all ten: empty list → genuine negative; non-empty list
with **every** item malformed → `LLM_SHAPE_ERROR`; **some** malformed → bad items dropped and
`stats: { itemsDropped, warnings[] }` added as a top-level sibling, **present only when something
was lost** — its absence is the "nothing dropped" signal. Filling missing arrays with `[]` was
deliberately rejected as the same false negative #2/#3 removed. One judgement call, recorded rather
than overridden: a good finding with no `page` locator is dropped visibly rather than returned with
`page: null`. Warnings carry field names and counts only, never model text — pinned by a test.

**Confidence**: number → itself; numeric string → number; anything else → `null`. A `null` score is
**never a drop reason** — the item is kept and flagged. Scored items below threshold are still
filtered (pinned, so the keep-unscored rule cannot silently disable the filter). **Published type
change:** `confidence` is `number | null` on four tools.

The tests were made trustworthy, not just green: the item-shape tripwires would pass on *any*
failure — including a `TypeError` from inside the new validator — so each inverted sibling pins
`LLM_SHAPE_ERROR` and exactly one model call; the confidence tripwires would pass if the item were
dropped (the exact bug), so the siblings assert it is *kept* with `null`. The new redaction test
proves its own detector is not vacuous: `JSON.stringify(new Error(text))` is `"{}"`, so a naive
check could never see a leak through `err.message` — the detector special-cases `Error` and the
suite asserts the logger received the redacted twin and exactly `{ code }` as its object argument.

## 4. `scan_for_pattern` — a real regex scan

Full detail in `REPORT-scan-for-pattern-true-regex.md`. The tool was FTS recall bounded by
literal-keyword extraction with the regex as a post-filter; any pattern whose literals were not whole
index tokens got zero candidates and **returned `[]` silently** — on litigation material, "the record
does not contain this". Now: a bounded full-text scan (~1–2 s over ~36k chunks, 10 s time box,
`caseId`-scoped) when no whole-token keyword survives or FTS returns nothing; `strategy`,
`candidatePool`/`scanned`, and `warnings[]` on every result so recall is never silent; cursor
pagination (the 60 cap was **client-supplied**); catastrophic patterns rejected with `INVALID_REGEX`
before any scan. Dashboard search paths deliberately stay on FTS. Live: `[Uu]word` 0 → 37,
mid-word fragment 0 → 37, 4-page pagination with no overlap or gap.

## 5. The `deep` re-measure — v6's 17 % was noise

Two back-to-back runs of the same synthetic query, same caps:

| | run 1 | run 2 |
|---|---|---|
| total | 192.0 s | 61.9 s |
| decompose | 12.3 s | **20.0 s — hit its timeout, heuristic fallback** |
| retrieve | **141.6 s** | 10.6 s |
| pre-cap pool | 150 | 48 |
| outline | 25.0 s (`null`) | 25.0 s (`null`) |

Retrieve varied **13×**. Run 2's decompose timed out under load (the M-1 fallback working as
designed), produced fewer sub-queries, and so a third of the serial rerank work. Retrieve time is
roughly *sub-queries × serial rerank* and swings with whatever else the box is doing; v5's 70 s and
v6's 55 s were samples from that distribution, not a trend. The durable fix remains the batched
rerank after fusion — still deferred pending GPU measurement.

## Operator notes

- **Loopback is unchanged.** A dashboard on `localhost:3000` needs no session and no key.
- **LAN or Cloudflare-tunnel dashboard access** now needs a signed-in admin session (`/admin/login`;
  the cookie covers `/api/config`, `/api/cases`, `/api/search/deep`, `/api/docs/info`, and the gated
  `/api/admin/*`) **or** an `MCP_API_KEYS` credential sent as `Authorization: Bearer` / `X-API-Key`.
- **Sidecars need no change.** Discovery and fleet reporting answer without a credential from any origin.
- `GET /api/config` no longer returns key values. External tooling reading `openaiApiKey` etc. off
  it must switch to `apiKeys.<provider>.configured`.
- Clearing a provider key by blanking the Settings field no longer works (blank = keep). Use the
  AI Keys panel.
- `MCP_AUTH_STRICT_LOOPBACK=routed` now also makes `POST /api/search/deep` refuse loopback — a
  routed, money-spending call. An operator who set that knob for MCP will find dashboard deep search
  401s.
- Outline model: still `null` — install a small instruct model and pick it on Admin → AI Services.
- Structure backfill (`/api/admin/structure-backfill`) for `headingPath`/`blockType` coverage.

## Still open

- **M-5 residual** — forged single-value `XFF`/`Host` on the port; proven unclosable in a route
  handler. Loopback bind + Cloudflare interlock remain the real controls.
- The `:3001` MCP surface (`mcp-server.ts`) — own auth, never probed.
- `/api/cases/[id]/**` — 14 routes, ungated, out of scope this round.
- Absent-`profile` bypass in `ai-helper` — one `CURRENT BEHAVIOUR` test left in place deliberately.
- `scan_for_pattern` caveats (`strategy`/`warnings`) not surfaced in the dashboard renderer.
- Graph data: no amendment links, no Person↔Motion links in the corpus.
- Batched rerank after fusion.
