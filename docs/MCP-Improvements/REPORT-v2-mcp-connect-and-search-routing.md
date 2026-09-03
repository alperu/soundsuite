# MCP Report v2 — Connecting, Asking, and Complexity-Routed Search

**Date:** 2026-09-03 · **Codebase:** Sound Suite / court-lens-mcp at `v1.3.5` (`47e09db`)
**Basis:** full source review of the public repo + live probes of the running instance on `:3000` and mcp-proxy on `:9191`
**Supersedes:** *Sound Suite + mcp-proxy — Engineering Report* (2026-08-29) and *Remote Access & OAuth Architecture* (2026-08-29) on the points where this document differs.
**Privacy:** every query, title, and identifier in this document is synthetic.

---

## 0. Where things stand (verified live, 2026-09-03)

| Claim | Status | Evidence |
|---|---|---|
| Local MCP works end-to-end (Claude Code / Cursor → proxy → bridge → Sound Suite) | ✅ **Working** | `tools/call query_case_knowledge` through `:9191` → 200, 5.4 s, citations present |
| Bridge `arguments`→`params` bug | ✅ **Fixed** | same probe; previously `INVALID_PARAMS` |
| `query_case_knowledge` latency | ✅ **4–7 s** (was 115 s) | four cold calls: 4.0 / 4.3 / 5.0 / 7.5 s |
| Native MCP endpoint (`POST /api/mcp` JSON-RPC) | ❌ **Does not exist** | 404; no `src/app/api/mcp/route.ts` |
| OAuth resource server (`/.well-known/oauth-protected-resource`) | ❌ **Does not exist** | 404; no `src/app/.well-known/` directory |
| `MCP_AUTH_MODE=oauth` protects anything | ❌ **Inert** | `POST /api/mcp/execute` → 200 with no header, and 200 with `Authorization: Bearer garbage` |
| Cloudflare tunnel integration | ⚠️ **Plumbing only, and its default ingress is unsafe** | §6 |
| Release note v1.3.4: "Claude Desktop can connect … with `MCP_AUTH_MODE=oauth`" | ❌ **Not true in source** | all of the above |

**Bottom line for the question you asked:** you can use the MCP locally today, right now, with no auth friction — because there is no auth. That is fine on loopback. It is the reason the Cloudflare tab must not be used until §6 is fixed.

---

## 1. How to connect (local, single user)

Two working paths. Both go through the stdio bridge because Sound Suite has no native MCP transport.

### 1.1 Claude Code and Cursor — via mcp-proxy (HTTP)

```bash
claude mcp add --transport http sound-suite http://localhost:9191/sound-suite/mcp
```

or in `.mcp.json` / `.cursor/mcp.json`:

```json
{ "mcpServers": { "sound-suite": { "type": "http", "url": "http://localhost:9191/sound-suite/mcp" } } }
```

Requires mcp-proxy running (`~/Code/mcp-proxy/scripts/start.sh`) with the `sound-suite` stdio upstream — already in its `config.json` with `callTimeoutMs: 180000`.

### 1.2 Claude Desktop — direct stdio (no proxy)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "sound-suite": {
    "command": "/absolute/path/to/node",
    "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"],
    "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000" } } } }
```

Use the absolute `node` path (`command -v node`) — Desktop launches with a minimal `PATH`. Quit with ⌘Q and relaunch; Desktop only connects servers at startup. Desktop's config accepts **stdio only**; a `url` entry is silently invalid.

### 1.3 Cowork / claude.ai cloud sessions

**Not possible today** and not until §6–§7 are done. Cloud sessions need a public HTTPS endpoint with OAuth; none exists. Meanwhile a Cowork session on the linked Mac can drive the local endpoint through the browser pane at `http://localhost:9191` (that is how every measurement in this document was taken), which is a workaround, not a connection.

### 1.4 What is wrong with `public/docs/install-mcp.md`

The in-app connector guide is the one piece of documentation an outside user will read, and every native-transport option in it points at a 404: `{{MCP_RPC_URL}}` resolves to `/api/mcp/rpc` (`src/app/api/docs/info/route.ts:93`), which has no route; `transport: "sse"` has no handler; the apikey section tells users to send a header nothing reads; the oauth section says the server "advertises" a flow it does not have; "Admin → MCP" is not a tab (`src/app/admin/[[...tab]]/page.tsx:8`). Replace it with §1.1–1.2 above, generated from the registry rather than hand-written (still open as SS-5).

---

## 2. How to ask questions

### 2.1 The wire contract (what the bridge does for you)

```jsonc
POST /api/mcp/execute
{ "tool": "<name>", "params": { ... }, "provider?": "...", "model?": "..." }
```

Key is **`params`** (`src/app/api/mcp/execute/route.ts:10-15`). The bridge maps MCP's `arguments` to it. `provider`/`model` override the LLM for LLM-backed tools on that one call (`:65-67`) — the bridge does not expose these yet; see §5.

### 2.2 Which tool for which question

| You want… | Tool | Required | Notes |
|---|---|---|---|
| Passages relevant to a topic, with citations | `query_case_knowledge` | `query` | `searchMode: hybrid` (default) / `vector` / `keyword`; `limit` default 10; scope with `caseId` |
| An exact string, number, date format, docket pattern | `scan_for_pattern` | `pattern` (regex) | 1–2 s; no LLM; best precision tool in the set |
| Structural graph facts — amendment lineage, motions a person appears in | `query_case_graph` | `operation` | `amendment-lineage` / `motions-by-person` / `related-motions`; bounded 50 nodes / 4 hops |
| An exhibit by description | `retrieve_exhibit` | `description` | never executed in production — treat output skeptically until SS-3 tests exist |
| Contradictions across filings | `detect_contradictions` | `caseId` | LLM; rate-limited 10/min; `confidence_threshold` default 0.7 |
| How a claim changed over filings | `track_claim_evolution` | `caseId`, `claim` | LLM |
| Argument map of one document | `extract_argument_structure` | `documentId` | LLM |
| Two documents' arguments side by side | `compare_argument_structures` | `documentId1`, `documentId2` | LLM |
| Chronology | `reconstruct_timeline` | `caseId` | LLM; `date_range_start/end` ISO 8601 |
| Deadlines / commitments | `extract_obligations` | `documentId` | LLM |
| People / orgs / dates / places | `extract_entities` | `documentId` | LLM; `entity_types` filter |
| Citation analysis | `analyze_citations` | `caseId` | LLM |
| Possibly privileged content | `detect_privilege` | `documentId` | LLM |
| Tone / language patterns | `analyze_tone` | `documentId` | LLM |
| Saved workflows and templates | `search_workflows` | — | 2 ms; the only tool with no required param |

Twelve of the fifteen have **zero production executions** (registry `stats`). They are untested, not proven. Prefer the three exercised tools (`query_case_knowledge`, `scan_for_pattern`, `search_workflows`) for anything that matters until SS-3 lands.

### 2.3 Reading a `query_case_knowledge` result

Each hit carries `documentId`, `blockType` (`paragraph|table|footnote|figure`), `headingPath`, `speakers` (transcript, `|`-delimited), `tableMarkdown`, and a score. These are the most valuable fields in the system and arrive today as a JSON string inside one text block. When you cite, cite `documentId` + `headingPath`; when the block is a table, use `tableMarkdown` rather than `text`.

### 2.4 Question patterns that work, and ones that do not

Works well:

- *"Find passages about the notice requirement for a motion to compel"* → `query_case_knowledge`, hybrid, limit 10.
- *"Every occurrence of a dollar amount over four digits"* → `scan_for_pattern` with `\$\d{1,3}(,\d{3})+`.
- *"What amended what?"* → `query_case_graph` `amendment-lineage`.
- Two-step: `scan_for_pattern` to locate, then `query_case_knowledge` scoped by `caseId` to read around it.

Does not work over MCP today:

- *"Compare how the two sides characterized the same event"* — this is a **deep search** question (decompose → parallel retrieval → rerank → synthesis). Deep search is UI-only (`src/app/api/search/deep/route.ts`); no MCP tool exposes it. An MCP client gets one flat retrieval and has to do the decomposition itself.
- *"Trace how the property claim evolved across every filing"* — this is an **RLM** question (agentic evidence gathering with tool rounds). Also UI-only.
- Anything needing a specific effort level, extended thinking, or a token budget — no tool accepts them (§4.3).

That gap is the subject of §5.

---

## 3. The search modes that exist (and what they cost)

All modes bottom out on `query_case_knowledge`. What differs is orchestration.

| Mode | Where | Pipeline | LLM calls | Retrievals |
|---|---|---|---|---|
| **Single-shot ("Ask AI")** | `src/app/api/search/ai/route.ts` | 1× `query_case_knowledge` (limit 20) + 1× `scan_for_pattern` backstop → 12 K-char context → 1 streaming generation | 1 | 2 |
| **Deep** | `src/lib/search/deep-search.ts:1780` | decompose (3–7 sub-queries, JSON-constrained, `:239-259`) → parallel `query_case_knowledge` × N (limit 50 each, `:449-505`) → pattern backstop → merge with multi-hit boost `×(1+0.15(n−1))` (`:686`) → rerank pool 150 (`:724`) → synthesis to 120 K chars (`:1002`) | 2 | N+1 (≈4–8) |
| **Deep + Multi-Pass** | `:1219-1414` | as Deep, then an **outline call** (1–8 findings sections, `:1263-1300`) and one streaming call per section | 2 + 1 + ≤8 | N+1 |
| **Deep + RLM** | `:1495-1778`, `src/lib/ai/stream-rlm.ts:440` | as Deep, then a Qwen3-8B RLM sidecar runs up to **4 tool rounds** (`maxRounds`, `stream-rlm.ts:459`) over `query_case_knowledge` + `query_case_graph` to gather *extra* excerpts, ≤8 chunks × 600 chars per call (`deep-search.ts:1430,1436`); the cloud model then writes from `sources + rlmExtras` | 2 + up to 4 RLM rounds + 1 | N+1 + ≤4×2 |
| **Compare** | `search-interface.tsx:1850` | Single-shot fanned out per provider/model | k | 2k |

**"RLM" = Recursive Language Model** — `mit-oasys/rlm-qwen3-8b-v0.1` on vLLM at `:8100` (`stream-rlm.ts:53-54`), with a 40,960-token context budget and a three-step trim defense per round (`:66-79`). **Multi-Pass** is a separate concept: the outline-then-sections report generator. They are mutually exclusive — multi-pass is disabled when RLM is on (`deep-search.ts:2071-2074`) because the forced-tool-use outline call does not stream.

The **"template"** you described for complex questions already exists: it is the Multi-Pass outline (`:1263-1300`) — a structured findings/gaps/significance/next-steps skeleton that the section calls then fill. Complexity routing in §5 maps the top tier onto it.

---

## 4. The settings, and what MCP can reach

### 4.1 UI toggles ("Search Modes" panel, `search-interface.tsx:3871-3966`)

| Toggle | Key | Default | Effect |
|---|---|---|---|
| **Auto** | `search.auto` | off | runs the query router (§4.4) and overrides Deep/RLM per query |
| **Deep** | `search.deepSearchMode` | off | routes to `/api/search/deep` |
| **RLM** | `search.useRlm` | off | enables the RLM evidence stage |
| **Compare** | `search.compareMode` | off | multi-provider fan-out |
| **Thinking** | `search.thinkingMode` | **on** | Anthropic extended thinking; also gates the Effort selector |
| **Multi-Pass** | `search.multiPass` | off | outline + per-section generation (Deep only) |
| **Tokens** | `search.maxTokens` | 2048 | 512 … 32 K |
| **Effort** | `search.effort` | medium | low / medium / high / xhigh / max, clamped per model (`src/lib/ai/models.ts:213`) |
| Preset | `search.activePresetId` | — | server-persisted bundle of all of the above (`prisma SearchPreset`, opaque JSON to the server) |

`rlmMaxRounds` is accepted by the deep route (`deep/route.ts:33,113`) but **no UI or client sends it** — always 4.

### 4.2 Server config (`src/lib/db/config.ts`)

`rerank.poolSize` 150 (admin UI exists) · `fusion.rrfK` 60 and `fusion.softBoost` 1.2 (config-only, no UI) · `ai.cacheTtl` 1h · `rerank.interactiveTimeoutMs` 30000 (doc comment says 15000 — stale) · `rlm.model/quant/maxContext`.

### 4.3 Parity table — UI vs MCP

| Capability | UI | MCP |
|---|---|---|
| Deep search | ✅ | ❌ not a tool |
| RLM | ✅ | ❌ |
| Multi-Pass | ✅ | ❌ |
| Effort | ✅ | ❌ — `ai-helper.ts:80` accepts it; **no tool passes it**; every LLM tool runs at `medium` |
| Thinking | ✅ | ❌ |
| maxTokens | ✅ | ❌ — pinned to 4096 (`ai-helper.ts:100`) |
| Preset | ✅ | ❌ |
| Auto routing | ✅ | ❌ — `classifyQueryComplexity` has zero callers outside the client component |
| `searchMode` vector/hybrid/keyword | ❌ hardcoded hybrid | ✅ — the one place MCP has *more* control |
| Provider/model override | toolbar | ⚠️ HTTP route accepts it; bridge does not forward it |

### 4.4 The query router that already exists

`src/lib/search/query-router.ts:74` — `classifyQueryComplexity(query, segments?)`. Pure string heuristic, zero latency, no LLM. Returns `{route, reason, confidence}` with routes `single-shot | deep | rlm` (`no-retrieval` declared, never returned).

Rules in priority order: relationship/evolution language (`trace`, `how did … evolve`, `over time`, `chronolog`) → **rlm** 0.8 · comparative/breadth (`compare`, `versus`, `contradict`, `across all`, `every`) → **deep** 0.75 · a cause-number pattern or quoted phrase → **single-shot** 0.85 · chips with ≤2 free words → **single-shot** 0.7 · ≤12 words with a question word or `?` → **single-shot** 0.65 · otherwise **deep** 0.4.

Its own header (`:10-13`) states the contract: it decides only when Auto is on; an explicit request is never clamped. That contract carries straight into the MCP design.

---

## 5. Can the MCP route by complexity? — Design

**Today: no.** The router is UI-only, and the tiers it routes to are not MCP tools.

**Proposed: yes, with one new tool and two small plumbing changes.** There are two LLMs in the loop — the MCP client (Claude) and Sound Suite's own — so routing should be layered, not centralised.

### 5.1 Layer 1 — let the calling model choose the tier

Claude reads tool descriptions and picks. Give it tiers to pick from and describe them by *question shape*, not by mechanism:

- `scan_for_pattern` — *"exact strings, numbers, dates, docket patterns"*
- `query_case_knowledge` — *"passages on a topic; one retrieval; fast"*
- **`research_case`** (new) — *"multi-part, comparative, or chronological questions; decomposes, retrieves in parallel, reranks, synthesizes; slow"*

A capable client will already route the majority of questions correctly from descriptions alone. This layer costs nothing.

### 5.2 Layer 2 — `research_case` routes internally with `mode: auto`

```jsonc
{
  "name": "research_case",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":      { "type": "string" },
      "caseId":     { "type": "string" },
      "mode":       { "type": "string", "enum": ["auto", "fast", "deep", "deep-report", "rlm"], "default": "auto" },
      "effort":     { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"] },
      "thinking":   { "type": "boolean" },
      "maxTokens":  { "type": "number" },
      "rlmMaxRounds": { "type": "number", "minimum": 1, "maximum": 6 },
      "returnChunksOnly": { "type": "boolean", "default": false }
    },
    "required": ["query"]
  }
}
```

Routing table for `mode: auto` — a thin extension of the existing router:

| Router route | Confidence | `research_case` executes | Cost |
|---|---|---|---|
| `single-shot` | any | `query_case_knowledge` (limit 10) → if `returnChunksOnly` return; else one synthesis call at `effort ?? low` | 1 LLM |
| `deep` | ≥ 0.6 | `deepSearch()` single-pass | 2 LLM |
| `deep` | < 0.6 ("safe middle") | `deepSearch()` single-pass, **`effort` capped at medium** | 2 LLM |
| `deep` with a report-shaped ask (`report`, `memo`, `summarize all`, `outline`) | — | `deepSearch({ multiPass: true })` — **this is the "template" path**: outline call, then per-section fills | 3 + ≤8 LLM |
| `rlm` | any | `deepSearch({ useRlm: true, rlmMaxRounds })` — skipped with a warning if the sidecar is down (`deep-search.ts:2049-2065`) | 2 + ≤4 rounds |

Explicit `mode` values bypass the router entirely — the router's own rule.

**One extension to the router:** a `deep-report` tier triggered by report-shaped language, so "complex" splits into *comparative/breadth* (deep, one synthesis) and *comprehensive/document-producing* (deep + multi-pass outline). That is the distinction you drew between a simple call and "create a template and make a different call."

### 5.3 Why the client-side LLM should not be the only router

The spec-level reason: an MCP client is a *public* client that may be any model, at any capability. A weak or terse client will call `query_case_knowledge` for a chronology question and get a shallow answer with confident citations. Layer 2 protects quality for every client; Layer 1 only helps the good ones.

### 5.4 Cost and latency guardrails inside the tool

- Return a `routing` block in every result: `{ mode_requested, mode_executed, reason, confidence, llmCalls, ms }` — lets the client learn and lets you audit auto-escalations.
- `deep` and `rlm` tiers should stream progress via MCP `notifications/progress` once the transport supports it (today it does not — the bridge is request/response). Until then, bound them: deep p95 must stay under the proxy's 180 s `callTimeoutMs`; the RLM tier at 4 rounds is the one most likely to breach it and should default to `rlmMaxRounds: 2` over MCP.
- `deepSearch` is written around streaming callbacks (`onProgress/onToken/onThoughts`, `deep-search.ts:97-119`). The tool wraps them into a non-streaming `DeepSearchResult` (`:149-183`) — `{report, sources, subQueries, searchStats, thoughts}`. Return `thoughts` only when `returnThoughts: true`; it can be 200 K chars.

### 5.5 Implementation notes (file-level)

1. **`src/lib/mcp/tools/research-case.ts`** — new `BaseMCPTool`; imports `classifyQueryComplexity` (`src/lib/search/query-router.ts`) and `deepSearch` (`src/lib/search/deep-search.ts:1780`). Register in `src/lib/mcp/tools/index.ts:18-36`.
2. **Router** — add the `deep-report` route and its regex in `query-router.ts`; extend `query-router.test.ts`.
3. **Effort/thinking/maxTokens on the existing LLM tools** — add the three fields to each `inputSchema` and pass them through to `callLLM` / `callLLMJson` (`src/lib/mcp/ai-helper.ts:80,104,158`). Plumbing exists end-to-end (`ai-provider.ts:955`); only the schema and call sites are missing.
4. **Bridge** — forward `provider`/`model` if present in `arguments` as top-level execute fields; otherwise no change. Tool-list refresh on the 60 s poll already picks up the new tool.
5. **Structured output (SS-6)** — while touching results, emit `structuredContent` alongside the text block so citation fields stop arriving stringified.

Rough size: the tool itself is ~250 lines; the router extension ~30; the schema threading ~15 lines × 11 tools. The largest cost is testing the four tiers against a real case — which is SS-3 work you need anyway.

---

## 6. Security — read before touching the Cloudflare tab

This section exists because v1.3.4's release note says remote MCP with OAuth is available, and the code says otherwise. If the Cloudflare tab is used as shipped, it publishes unauthenticated tool execution over the case corpus to the internet.

### 6.1 Findings (source-verified, then confirmed live)

| # | Finding | Where | Live check |
|---|---|---|---|
| S1 | `POST /api/mcp/execute` has **no authentication code path** | `src/app/api/mcp/execute/route.ts:17-67` — parses, checks `tool` is a string, executes | 200 with no header; **200 with `Bearer garbage`** |
| S2 | `MCP_AUTH_MODE` is read in exactly two places, both cosmetic | `api/docs/info/route.ts:94`, `components/docs-viewer.tsx:62` | — |
| S3 | The only implementation of `oauth` mode is **dormant and default-allow** — any non-empty Bearer string passes | `src/lib/mcp/mcp-server.ts:154-164`; file header `:2-9` says it is no longer started | — |
| S4 | **Default tunnel ingress publishes S1.** `^/api/mcp` is a *prefix regex*, so `/api/mcp/execute` and `/api/mcp/tools` pass through; `/.well-known/oauth-protected-resource` has no route | `src/lib/admin/cloudflare.ts:36,187-195`; comment at `:171-174` claims it is "restricted to the MCP endpoint and the OAuth discovery path" | `/.well-known/…` → 404 |
| S5 | 31 of 39 `/api/admin/*` routes have no auth | only `users`, `sessions`, `cloudflare*`, `auth/me` call `requireAdminAuth` | `ai-keys` → 200 (provider names + `configured` flag; key values not returned on GET — write path unverified), `system-info` → 200, `action-logs` → 200 |
| S6 | `/api/mcp/execution-history` is public and stores full `params` — i.e. every query string ever sent | `tool-registry.ts:152-157`, `api/mcp/execution-history/route.ts:7` | 200, records include `params` |
| S7 | `admin` vs `viewer` role is never checked — a viewer can create admins and rewrite tunnel settings | `src/lib/admin/auth.ts:74-78` returns `role`; no route reads it | — |
| S8 | Session tokens stored in plaintext; execute-route session identity is client-controlled (`mcp-session-id` header, spoofable `x-forwarded-for`), so revocation is bypassable | `src/lib/admin/auth.ts:26-35`, `session-store.ts:30-35`, `execute/route.ts:42-50` | — |
| S9 | Login has no rate limit or lockout | `api/admin/auth/login/route.ts` | — |
| S10 | Cloudflare `apiKey` / `tunnelToken` stored plaintext in the `Config` table | `cloudflare.ts:86-90` | — |

### 6.2 The one interlock to add immediately

Regardless of anything else in this document:

> **`generateCloudflaredConfig()` and the Cloudflare tab's "generate" action MUST refuse to run unless an authentication check is actually enforced on `/api/mcp/execute`.**

Not "unless `MCP_AUTH_MODE` is set" — S2 shows that variable proves nothing. The interlock should call the same guard function the execute route uses and confirm it rejects an unauthenticated request. A generated tunnel config that exposes an open execute route is the single most damaging artefact this system can produce.

### 6.3 What "local only, no auth" should mean

You said: single user, local, no need for OAuth friction. Agreed — on these terms:

1. Sound Suite binds loopback (verify `next.config` / start scripts; `:3000` on `0.0.0.0` has the same LAN exposure mcp-proxy had).
2. mcp-proxy stays loopback-only (already done).
3. `MCP_AUTH_MODE=none` is honest documentation of the state, not a security setting — say so in the docs.
4. The interlock in §6.2 exists, so the local-only posture cannot be accidentally exported.
5. The Cloudflare tab is either hidden behind the interlock or removed until §7 ships.

That is a coherent single-user design. What is not coherent is "no auth locally" *plus* a working tunnel generator.

---

## 7. If remote access is ever wanted — what actually needs building

The 2026-08-29 architecture report stands, with one correction: it assumed v1.3.4 had shipped a resource server. It had not. The list is therefore the original list, unchanged:

1. Native `POST /api/mcp` Streamable HTTP (SS-1b) — the bridge then goes away.
2. `GET /.well-known/oauth-protected-resource` returning `resource` + `authorization_servers`.
3. Bearer validation middleware on `/api/mcp` only: JWKS signature, `iss`, **`aud` = canonical MCP URI**, `exp`; 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
4. A **third-party** authorization server — `cloudflare/workers-oauth-provider` or a hosted IdP. Not the Users/Sessions tabs: those are dashboard login, and MCP tokens should not be minted from a bcrypt table with no rate limiting (S9).
5. Tunnel ingress as an **exact-path allowlist** — `/api/mcp` and `/.well-known/oauth-protected-resource` — never a prefix regex.
6. Delete `MCPServer.authenticateRequest` (S3) so the default-allow oauth stub can never be revived.

Pre-register one client and paste its ID/secret into Claude's connector Advanced settings; skip dynamic client registration.

---

## 8. Work queue

| # | Item | Size | Why this order |
|---|---|---|---|
| 1 | §6.2 interlock; hide/disable the Cloudflare tab behind it | XS | Removes the one catastrophic path. Do today. |
| 2 | Fix `install-mcp.md` to match §1; remove `/api/mcp/rpc`, sse, apikey, oauth claims | S | Every external reader is currently misled |
| 3 | Auth on `/api/admin/*` — apply `requireAdminAuth` by default, allowlist exceptions; enforce `role` | S | S5, S7 |
| 4 | Stop logging `params` to the public execution history, or gate that route | XS | S6 — query text is case-sensitive material |
| 5 | SS-3 integration tests: one per tool, real case, assert shape | L | 12 untested tools; prerequisite for trusting §5 |
| 6 | **`research_case` tool + `deep-report` router tier + effort/thinking/maxTokens plumbing** (§5) | M | The feature you asked for |
| 7 | Structured content for citations (SS-6); result size caps (SS-7) | M | Quality of what the client sees |
| 8 | Session hardening: hash stored tokens, server-derived session identity, login rate limit | M | S8, S9 |
| 9 | Native MCP transport (SS-1b) | M | Removes the bridge; prerequisite for any remote path |
| 10 | Remote access per §7 | L | Only if a real need appears |

Items 1–4 are a day. Item 6 is the interesting one and is unblocked as soon as 5 gives you a way to measure it.

---

## Appendix — Probe transcript (2026-09-03, synthetic queries only)

```
GET  /api/docs/info                              200  mcpAuthMode present
GET  /.well-known/oauth-protected-resource        404  (HTML)
GET  /.well-known/oauth-authorization-server      404  (HTML)
POST /api/mcp            (JSON-RPC initialize)    404
POST /api/mcp/rpc        (JSON-RPC initialize)    404
POST /api/mcp/execute    no auth header           200  results returned
POST /api/mcp/execute    Authorization: Bearer garbage  200  results returned
GET  /api/admin/cloudflare                        401
GET  /api/admin/users                             401
GET  /api/admin/sessions                          401
GET  /api/admin/ai-keys                           200  provider names + configured flags
GET  /api/admin/system-info                       200
GET  /api/admin/action-logs                       200
GET  /api/mcp/execution-history                   200  includes params

via mcp-proxy :9191/sound-suite/mcp
initialize                                        200  11 ms
tools/list                                        200  15 tools
tools/call query_case_knowledge (limit 3)         200  5,419 ms  isError:false
```
