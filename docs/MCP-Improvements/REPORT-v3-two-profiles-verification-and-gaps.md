# MCP Report v3 — Two-Profile Build: Verification and What Is Missing

**Date:** 2026-09-03 · **Commit verified:** `59a9236` (court-lens-mcp, v1.3.6+) · **Basis:** live probes of `:3000` and `:9191` from the linked Mac, plus source read of the new `src/lib/mcp/**` tree.
**Preceded by:** v2 (connect/ask/routing), v2.1 rev 2 (two profiles). **Privacy:** synthetic queries only.

---

## 0. Answer to "can we communicate with the MCP server now?"

**Yes — the REST surface, the profile boundary, and the job machinery all work. Two things stop it from being usable: the local pipeline hangs on decompose, and the proxy has not been reloaded.** Details in §1 and §2.

| Layer | Status |
|---|---|
| `GET /api/mcp/tools?profile=local` → 20 tools, policy stamped, `providersAllowed: ["ollama"]` | ✅ |
| `GET /api/mcp/tools?profile=routed` → 32 tools; 12 routed-only (`preset_*`, `routing_explain`, `research_report`, `report_*`) | ✅ |
| Local refuses routed-only tool → `TOOL_NOT_IN_PROFILE` | ✅ |
| Local refuses cloud provider → **403 `POLICY_VIOLATION`** with a message that names the fix | ✅ |
| Execute with no `profile` → treated as local | ✅ |
| `routing_explain` → tier `deep-report`, resolved settings, `costClass`, `estimatedSeconds`, `wouldPromoteToJob` | ✅ |
| `research_evidence mode:auto` on chronology language → **promoted to job**, `jobId` returned in 124 ms | ✅ |
| `research_status` → phase, cursor, evidence delta, `elapsedMs` | ✅ |
| `research_cancel` → `cancelled: true` | ✅ |
| `GET /api/mcp/research/:id/events` → `application/x-ndjson`, replay with `seq`, routing decision as first event | ✅ |
| `research_evidence mode:fast` | ✅ (retrieval only, no LLM) |
| `research_evidence mode:deep` | ❌ **hung >5 min in `decompose`** (§1) |
| `research_start` (deep-rlm job) | ❌ **same hang; never reached retrieval** (§1) |
| Proxy `/sound-suite-local/mcp`, `/sound-suite-routed/mcp` | ❌ 404 — proxy not reloaded (§2) |
| Proxy legacy `/sound-suite/mcp` | ⚠️ live, serves **32 tools** (§2) |
| Native `/api/mcp/local`, `/api/mcp/routed` | 404 — expected (SS-1b not started) |

---

## 1. M-1 · P0 · The local pipeline hangs at decompose

Two independent calls — a sync `mode: deep` and a `deep-rlm` job — both sat in phase `decompose` for the entire observation window (5 m 10 s for the job before I cancelled it; the sync call was still open). Zero evidence produced. Meanwhile `mode: fast`, `scan_for_pattern`, and `query_case_knowledge` all returned normally, so retrieval, rerank, and the index are fine. **The block is the first Ollama generation call.**

What the code does (`src/lib/search/gather-evidence.ts:137-138, 188-196`): picks `options.model ?? LOCAL_ROUTING.deep.model ?? config.ollamaCompletionModel ?? DEFAULT_MODELS.ollama` — resolving to `qwen3.5:9b` per `routing_explain` — and calls `decomposeQuery` with the job's abort signal but **no timeout of its own**. The Ollama transport's socket timeout is 5 minutes (`ai-provider.ts:249`). So a slow or wedged generation blocks the whole pipeline for up to five minutes and then fails with nothing to show.

The readiness check that gated the tool (`shared-dependencies.ts:81-106`, `ollamaAvailable`) hits `GET /api/tags` — **reachability, not the ability to generate.** It reported `satisfied: true` throughout the hang. This is the exact gap flagged in v2.1 §A.2.

Likely causes, in order — instrument before choosing:

1. **Model thrash on one Ollama instance.** Embedding (`qwen3-embedding:0.6b`) and completion (`qwen3.5:9b`) share the host. If VRAM/RAM can't hold both, each phase evicts the other; the 9B reload alone can take a minute on a Mac, and the two concurrent decompose calls I fired would have compounded it.
2. **9B is too heavy for a JSON-constrained 512-token decompose.** This call needs a 1.5–4B instruct model; it is structured extraction, not reasoning.
3. `format: json` / structured-output path on this Ollama version stalling — check Ollama's own log for the request.

**Fix (all three, they are independent):**

- **Decompose timeout + heuristic fallback.** Wrap `decomposeQuery` in `AbortSignal.timeout(20_000)`; on timeout, fall back to the zero-LLM decomposition the chip path already uses (`deep-search.ts:217-227` splits on boolean branches; add a keyword-variant splitter for plain text) and mark `modelsUsed.decompose = 'heuristic-fallback'`. The pipeline must never block on decompose.
- **Generation smoke in readiness.** `ollamaAvailable` should, at most once per minute, send a 5-token prompt to the *configured completion model* with a 10 s budget. `ready: false` with reason `"ollama reachable but <model> did not generate within 10 s"`. The bridge already hides not-ready tools.
- **A dedicated small decompose model** in `routing-defaults.ts` (`LOCAL_ROUTING.decompose`), separate from the synthesis model, and `keep_alive` set on the embedding model so retrieval never pays a reload.

**Acceptance:** `research_evidence mode:deep` returns evidence in < 20 s on a warm host; with Ollama stopped, the tool reports `ready: false` within 60 s and `mode:deep` still returns via heuristic decomposition.

---

## 2. M-2 · P0 · Proxy not reloaded; legacy path over-serves

`~/Code/mcp-proxy/config.json` has the two new upstreams but the running daemon is the old process (your follow-up note said as much). Consequences observed:

- `/sound-suite-local/mcp` and `/sound-suite-routed/mcp` → 404.
- `/sound-suite/mcp` (the old single upstream) is alive and running the **new** synced bridge with **no `SOUND_SUITE_PROFILE`** — and lists **32 tools**, the routed set.

The second point is a Sound Suite bug, not just a stale process: `GET /api/mcp/tools` **without** `?profile=` returns all 32, while execute without `profile` defaults to local. A client on the legacy path therefore sees `research_report` and `preset_*`, calls them, and gets `TOOL_NOT_IN_PROFILE`. Also `?profile=bogus` silently maps to local (200, 20 tools) instead of rejecting.

**Fix:**
- `tools` route: missing `profile` → local; unknown value → **400**. The list and execute defaults must agree.
- Bridge: refuse to start without `SOUND_SUITE_PROFILE` (or log loudly and default to `local`). A bridge with no profile should never advertise routed tools.
- Operator: `pm2 reload mcp-proxy` (or `scripts/restart.sh`), then remove the legacy `sound-suite` upstream from `config.json` and re-register clients on the two new paths.

---

## 3. M-3 · P1 · `routed` has no cloud default, so it routes to the same hung Ollama

`routing_explain` for a report-shaped question resolved to `ollama / qwen3.5:9b / multiPass: true`. That is the code default when no provider is marked default and no preset named `default` exists (`routing-defaults.ts:40-71`). So today `research_report` in the routed profile inherits M-1 and, worse, runs multi-pass — up to nine generations — on the model that can't finish one.

**Fix:** ship a `default` preset on first run of the routed profile (or an Admin → AI Keys "default provider" selector) mapping `deep`/`deep-report`/`deep-rlm` synthesis to the configured cloud provider and keeping only `fast` on Ollama. Until then, `routed` is not usable for anything above `fast`.

---

## 4. M-4 · P1 · Progress relay is only half-wired

The events stream exists and is correct. The bridge relays job events as notifications. But:

- The **proxy** still fans out only five notification kinds; `ProgressNotificationSchema` and token→session routing (v2.1 §E.3) are not in the diff. Progress from the bridge dies at the proxy for Claude Code / Cursor. Claude Desktop (direct stdio) is unaffected.
- Not verified from a real client whether Claude Desktop renders the `message` field. Treat progress as UX polish; the cursor-based `research_status` is the load-bearing path, and it works.

---

## 5. M-5 · P1 · Security items from v2 §6 — still open, and now higher stakes

Not re-audited in full; spot-checked: `POST /api/mcp/execute` still accepts every request with no header. The routed profile now **spends API credit and sends case text to third parties on request**, which raises the cost of the open execute route from "read" to "read and spend." Nothing in this build changes v2 §6's ordering: the Cloudflare interlock (§6.2) and admin-route auth come before any remote exposure.

The new provenance row (document ids and counts only) is the right shape and will be the audit trail once auth exists.

---

## 6. M-6 · P2 · Smaller gaps

| # | Item | Where |
|---|---|---|
| a | Router regex matches bare `report` / `brief` — both filing nouns — so "the brief filed in March" auto-routes to `deep-report`. Require a verb (`write|draft|prepare|summarize`) or a determiner-less leading position. | `query-router.ts` |
| b | 12 analysis tools still at zero executions; SS-3 still open. The research tools are now exercised; the LLM analysis tools are not. | `tool-registry` stats |
| c | Two pre-existing failures in the boolean-bypass suite and six pre-existing type errors in `deep-search.ts` report streaming. Not regressions, but they mask real breakage in CI. | tests |
| d | `research_status` returns `evidence: []` and `newEvidenceCount` — fine — but no `phaseStartedAt`, so a client can't tell "slow" from "hung." Add it; it would have made M-1 visible in one poll. | `research-jobs.ts` |
| e | Bridge `logging` capability: confirmed present on the proxy's session server; **not confirmed** on the bridge's own `initialize` response. Check `bridge.mjs` advertises `logging: {}` or `notifications/message` will be dropped by strict clients. | `scripts/mcp-bridge` |

---

## 7. The path that gets Cowork the tools without any of §5

**Task 07** (same folder): register the bridge in the Claude desktop app's **Local MCP servers** panel. Servers there are proxied to linked cloud sessions through the device bridge, appearing as `mcp__remote-devices__sound-suite-local__*`. No tunnel, no domain, no OAuth — the app's own login is the auth, and nothing leaves the machine except the tool call over the link the app already maintains. Five minutes; the only unknown is whether this app version exposes stdio servers to cloud sessions, and step 4 of the task tests exactly that.

If it works, the entire v2 §7 remote-access plan becomes optional for the single-user case.

---

## 8. Ordered queue

| # | Item | Size | Unblocks |
|---|---|---|---|
| 1 | **M-1** decompose timeout + heuristic fallback + generation smoke + small decompose model | S+S+XS | every `deep*` mode in both profiles |
| 2 | **M-2** tools-route default/400; bridge refuses missing profile; reload proxy; drop legacy upstream | XS + op | correct tool lists on every client |
| 3 | **Task 07** register in Local MCP servers | op, 5 min | Cowork access |
| 4 | **M-3** `default` preset / default provider for routed | S | `research_report` |
| 5 | **M-5** v2 §6.2 interlock + admin auth (unchanged priority; listed here so it is not lost) | S | any remote plan |
| 6 | **M-4** proxy progress forwarding | S | progress in Claude Code / Cursor |
| 7 | **M-6 a, d, e** | XS each | — |
| 8 | SS-3 per-tool tests; fix the pre-existing test/type failures | M | trust in the 12 analysis tools |

Items 1 and 2 are the difference between "the architecture is in place" and "it works." Everything measured in this report says the architecture is in place.

---

## Appendix — probe log (synthetic queries)

```
GET  /api/mcp/tools?profile=local                     200  20 tools  providersAllowed:["ollama"]
GET  /api/mcp/tools?profile=routed                    200  32 tools
GET  /api/mcp/tools                                   200  32 tools   ← M-2
GET  /api/mcp/tools?profile=bogus                     200  20 tools, profile:"local"  ← M-2
POST execute {profile:local, tool:preset_list}        404  TOOL_NOT_IN_PROFILE
POST execute {tool:research_report}  (no profile)     404  TOOL_NOT_IN_PROFILE
POST execute {profile:local, research_evidence fast, provider:anthropic, model:…}
                                                      403  POLICY_VIOLATION  56 ms
POST execute {profile:routed, routing_explain}        200  tier:deep-report → ollama/qwen3.5:9b multiPass  118 ms
POST execute {profile:local, research_evidence auto, chronology language}
                                                      200  promoted → jobId  124 ms
POST execute research_status                          200  phase:decompose  (t+60 s, +142 s, +190 s, +310 s — unchanged)
POST execute {profile:local, research_evidence deep}  —    no response by t+191 s
GET  /api/mcp/research/:id/events                     200  application/x-ndjson, seq:0 routing event
POST execute research_cancel                          200  cancelled:true
POST /api/mcp/local  (JSON-RPC)                       404
POST /api/mcp/routed (JSON-RPC)                       404
:9191/sound-suite/mcp        initialize + tools/list  200  32 tools (routed set)   ← M-2
:9191/sound-suite-local/mcp                           404
:9191/sound-suite-routed/mcp                          404
```
