# MCP Improvements — Implementation Report

**Date:** 2026-08-29
**Scope:** Sound Suite (this repo) + mcp-proxy (`/Users/alper/Code/mcp-proxy`) + new stdio bridge (`/Users/alper/sound-suite-bridge`)
**Basis:** "Sound Suite + mcp-proxy — Engineering Report" (2026-08-29 analysis session). Work executed by three parallel agents; findings verified in source before fixing.

---

## Executive summary

| Item | Status | Outcome |
|---|---|---|
| SS-1a — stdio MCP bridge | ✅ Shipped | All 15 tools list via MCP; smoke test passes |
| SS-2 — `query_case_knowledge` 115 s latency | ✅ Fixed | ~115 s avg → **4.8–7.1 s** measured; root cause was the **reranker pool**, not embedding cold-load |
| MP-1 — proxy bound to 0.0.0.0 | ✅ Fixed | Binds `config.host` (default `127.0.0.1`) |
| MP-2 — wildcard CORS / DNS rebinding | ✅ Fixed | Origin allowlist echo + `enableDnsRebindingProtection` |
| MP-3 — call timeout 75 s < tool latency | ✅ Fixed | `waitMs` / `callTimeoutMs` split; sound-suite gets 180 s |
| MP-4 — smoke test hardcoded endpoints | ✅ Fixed | Driven from `config.json`, per-endpoint latency |
| MP-5 — one bad config entry kills proxy | ✅ Fixed | Fail-soft validation, skip-with-warning |
| MP-6 — swallowed unhandledRejection | ✅ Fixed | `warn` level, rate-limited |
| MP-9 — 5-char admin secret accepted | ✅ Fixed | 16-char minimum on change-password |
| SS-4 — API-key auth | ⚠️ **Gap found** | The report's premise was wrong: `/api/mcp/execute` has **no auth code path at all** — see below |
| SS-8 — `rateLimitPerMinute: 0` semantics | ✅ Answered | `0` = unlimited (`tool-registry.ts:134` enforces only when `> 0`) |
| SS-3, SS-5, SS-1b, SS-6/7, MP-7/8/10 | ⏳ Not started | Queued as follow-ups (see end) |

**Action needed from the operator (2 items):**
1. **Restart mcp-proxy** — `cd /Users/alper/Code/mcp-proxy && ./scripts/restart.sh`. All proxy fixes are in the working tree but the running daemon still executes old code (restart was permission-blocked for the agent). mcp-proxy changes are also **uncommitted** — review and commit there.
2. **Decide on SS-4** — the execute route needs an auth check written before `MCP_AUTH_MODE=apikey` can mean anything (details below).

---

## 1. SS-1a — stdio bridge (shipped)

New, standalone: `/Users/alper/sound-suite-bridge/` (`bridge.mjs` + `package.json`, dep `@modelcontextprotocol/sdk ^1.0.0`, clean install, 0 vulnerabilities).

- MCP stdio server named `sound-suite`; translates `GET /api/mcp/tools` → `tools/list` and `tools/call` → `POST /api/mcp/execute` (`{"tool", "params"}` shape — **correction 2026-08-29**: the source engineering report asserted `arguments`, but `execute/route.ts:19` destructures `{ tool, params }`; the bridge shipped with `arguments`, which the route silently dropped, so every tool with a required parameter failed while `tools/list` and the no-required-args `search_workflows` stayed green. Fixed in `bridge.mjs`; verified end-to-end with a real `tools/call` returning results through proxy → bridge → REST in 5.8 s).
- Filters `config.enabled !== false && ready === true` (per SS-3 hardening; currently filters nothing — all 15 tools are enabled and ready).
- Catalog cached; served stale on fetch failure. All logging to **stderr** only.
- 60 s unref'd catalog poll emits `tools/listChanged` on diff — closes the bridge's biggest known limitation from the original report's Appendix A.
- `SOUND_SUITE_URL` (default `http://127.0.0.1:3000`) and `MCP_API_KEY` (adds `Authorization: Bearer` when set) env vars.
- **Smoke test passed**: `initialize` (protocol 2025-06-18) + `tools/list` over stdio returned exactly 15 tools.
- The proxy's existing `config.json` entry (`/sound-suite/mcp` → stdio → this bridge) now resolves; the rewritten proxy smoke test lists 15 tools through the proxy in 31 ms.

Claude Desktop config (stdio, per the original report — Desktop does not accept HTTP URLs in `claude_desktop_config.json`):

```json
{ "mcpServers": { "sound-suite": {
    "command": "node",
    "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"],
    "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000" } } } }
```

## 2. SS-2 — `query_case_knowledge` latency (fixed, ~23× faster)

**The report's ranked hypotheses were wrong.** Embedding is a warm singleton (median 0.9 s, p95 4.1 s — Ollama `qwen3-embedding:0.6b`); warm LanceDB vector search is ~1.4 s. The real cost was the **cross-encoder rerank phase**:

- The tool over-fetched a ≥200-candidate pool and sent **all of it** to the vLLM Qwen3-Reranker-8B in one `/v1/rerank` call, at ~60 ms/doc of GPU inference (log evidence: 150 docs → 9–17.6 s).
- `reranker.ts` has a module-level serializer that queues all concurrent reranks per process, and deep-search fans this tool out 2–6 wide — so callers waited on each other's reranks. Mined from 235 MB of `dashboard.log`: rerank start→completed as experienced by callers, n=253: median 45.6 s, **p95 117.2 s** — matching the registry's 115 s average exactly.
- `deep-search.ts:724-730` already sliced its own rerank pool to the config `rerankPoolSize` (150); `query_case_knowledge` never applied that knob.

**Fix** (both files auto-staged in this repo):
- `src/lib/mcp/tools/query-case-knowledge.ts` — rerank pool capped at `min(rerankPoolSize, max(limit*8, 40))`. Retrieval still fetches the full pool for RRF fusion/recall; only the cross-encoder pass shrinks. deep-search's own pipeline untouched. Permanent per-phase instrumentation added: one `[qck-timing] phase breakdown` log line per call (preprocess / embed / buildQuery / vectorSearch / chatAndSecondarySearch / rerank / hydrate / totalMs / searchMode).
- `src/lib/mcp/get-tool-registry.ts` — dev-only HMR fix: the `globalThis` registry singleton now rebuilds after a recompile. Previously, code changes to any MCP tool silently never took effect in dev until a full server restart (verified live). No-op in production.

**Measurements** (live dev server, hybrid mode, `limit: 5`, sequential):

| | total | rerank phase |
|---|---|---|
| Before (pool 200+) | 12.9 s / 21.7 s (p95 117 s under bursts) | 10.1 s / 18.5 s |
| After (pool 40) | **7.09 / 5.71 / 5.29 / 4.77 s** | 4.3 / 2.8 / 2.4 / 1.8 s |

Results verified well-formed (citations + scores present); `npx jest src/lib/mcp` 22/22 pass; `tsc --noEmit` clean on touched files.

**Acceptance vs. target**: sequential p95 is now well under 10 s. Under a 6-wide concurrent fan-out the single-GPU rerank serializer still worst-cases ~20–25 s (down from ~150 s); pushing that under 10 s needs infra (second vLLM host or vLLM-side batching), not app code. One-off LanceDB cold-cache spikes (~53 s right after a process-level rebuild) exist but warm search is consistently ~1.4 s — no ANN rebuild needed.

Note: registry `avgExecutionTimeMs` is cumulative and will decay slowly; judge the fix by the `[qck-timing]` lines.

## 3. mcp-proxy hardening (fixed, uncommitted, needs restart)

All findings confirmed at their reported locations in `/Users/alper/Code/mcp-proxy`; `node --check` clean on all six modified files; `config.json` parses.

- **MP-1** `server.mjs` — listens on `config.host` (default `127.0.0.1`).
- **MP-2** — CORS wildcard replaced with allowlist echo (loopback origins for the configured port + `config.allowedOrigins`, `Vary: Origin`, headers omitted for disallowed origins). `routes/mcpRoute.mjs` transport gets `enableDnsRebindingProtection: true` with matching `allowedHosts`/`allowedOrigins`. Verified against SDK 1.25.2 that Origin-less clients (curl, MCP CLIs) still pass.
- **MP-3** — `waitMs` (connect wait, 15 s) and `callTimeoutMs` (per-call, default 120 s) are now independent, per-upstream overridable, in both `httpUpstream.mjs` and `stdioUpstream.mjs`. `config.json`: sound-suite upstream set to `callTimeoutMs: 180000`.
- **MP-4** `test/smoke.mjs` — reads `config.json`, iterates `upstreams[].path`, reports connect/listTools/total latency per endpoint. Additionally supports a per-upstream `smokeCall` (`{name, arguments}`) that exercises a real `tools/call` and fails on `isError` — added after the `params` bridge bug showed a list-only smoke is green on transport but silent on function. sound-suite's entry calls `query_case_knowledge` with a required parameter. Run against the (old-code) daemon: sedona OK (30 tools, 9 ms), **sound-suite OK (15 tools, 31 ms — newly covered)**; fantom/axon fail only because their backends on :3848/:3847 are currently down, not a regression.
- **MP-5** — fail-soft config validation (known type, required keys, path format/uniqueness, stdio command resolvable / script exists); invalid entries warn-and-skip; exit only when zero valid upstreams remain.
- **MP-6** — `unhandledRejection` logs at `warn`, counter, rate-limited (first 5, then every 20th).
- **MP-9** — `/admin/change-password` now requires 16–256 chars. **Also rotate the current 5-char `.admin-secret` by hand.**
- README documents `host`, `waitMs`, `callTimeoutMs`, `allowedOrigins`, and fail-soft behavior.

**Post-restart verification** (from the original report's acceptance criteria):
```bash
cd /Users/alper/Code/mcp-proxy && ./scripts/restart.sh && npm run smoke
nc -vz <LAN-IP> 9191          # must refuse
curl -s -H 'Origin: https://evil.example' http://127.0.0.1:9191/sound-suite/mcp -X POST ...  # must be rejected
```

## 4. SS-4 — auth: the report's premise was wrong (gap, decision needed)

Two surfaces exist, and the one clients hit has **no auth code at all**:

- `src/lib/mcp/mcp-server.ts:139-152` (standalone `MCPServer` class) implements `apikey` correctly — `X-API-Key` checked against `config.apiKeys[]`, else 401 `AUTH_FAILED`. But **no production code constructs `MCPServer`** or feeds `MCP_AUTH_MODE` into it; only test harnesses do. `/api/docs/info` merely echoes the env var.
- `POST /api/mcp/execute` (the Next.js route everything actually calls) performs **no authentication**. Setting `MCP_AUTH_MODE=apikey` today changes nothing — no 401 anywhere on the live path.

**To actually satisfy SS-4** ("unauthenticated execute returns 401"): add an explicit check to the execute route (read `MCP_AUTH_MODE` + an `MCP_API_KEYS` env, compare `X-API-Key` or `Authorization: Bearer`, return 401 otherwise). The bridge already forwards `Authorization: Bearer ${MCP_API_KEY}` when the env var is set, so the client side is ready. Deliberately **not implemented** without a decision, since it would lock out every current caller (dashboard, deep-search, workflows) until they carry the key too — those internal call paths need auditing first.

## 5. SS-8 — answered

`rateLimitPerMinute: 0` means **unlimited**: `src/lib/mcp/tool-registry.ts:134` enforces only `if (config.rateLimitPerMinute > 0)`. `base-tool.ts` defaults to 0; the LLM-heavy tools opt into 10/min. Worth stating in the registry output when SS-5 (generated docs) lands.

## 6. Remaining queue (not started)

In the original report's priority order:

1. **SS-3** (L) — integration test per tool against a real case; disable unproven tools (12 of 15 still have zero executions). The bridge already filters on `ready`, so flipping `ready`/`enabled` immediately hides a tool from clients.
2. **SS-4 route auth** (S) — pending the decision above.
3. **SS-5** (M) — generate the connector doc from the live registry (copy mcp-proxy's `routes/docs.mjs` pattern).
4. **SS-1b** (M) — native Streamable HTTP `/api/mcp` route; the bridge validated the schemas end-to-end, so this is now low-risk.
5. **SS-6/SS-7** (M) — structuredContent mapping for citations + result size caps.
6. **MP-7/8/10** (M) — session reaping, forwarder gaps (`logging/setLevel` is advertised but not forwarded), unit tests for reconnect/crash-loop/session lifecycle.
7. **Rerank concurrency** (infra) — if p95 < 10 s must hold under 6-wide deep-search fan-out: second vLLM reranker host or vLLM-side batching.
8. **Dev-server fd/socket leak** — the long-lived dev process holds ~6,800 open fds, including ~2,700 IPv6 keep-alive sockets (likely undici connections from fleet-router's constant sidecar polling, never reaped). This is the environment behind the transient `spawn EBADF` / "Failed to generate static paths" errors on `/search/[[...path]]` during recompile churn (Next/Turbopack worker-spawn race, not app code — 39 occurrences in two bursts, self-resolved). Restart the dashboard if it recurs; chase the socket leak independently.

---

## Files changed

**This repo (auto-staged):**
- `src/lib/mcp/tools/query-case-knowledge.ts` — rerank pool cap + `[qck-timing]` instrumentation
- `src/lib/mcp/get-tool-registry.ts` — dev HMR registry rebuild
- `docs/REPORT-mcp-improvements-2026-08-29.md` — this report

**mcp-proxy (uncommitted working tree):** `server.mjs`, `routes/mcpRoute.mjs`, `routes/adminRoute.mjs`, `upstreams/httpUpstream.mjs`, `upstreams/stdioUpstream.mjs`, `test/smoke.mjs`, `config.json`, `README.md`

**New:** `/Users/alper/sound-suite-bridge/{bridge.mjs,package.json}` (not a git repo)
