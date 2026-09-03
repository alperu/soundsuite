# MCP Report v2.1 (rev 2) — Two MCP Profiles: Local-Only Evidence Engine and Sound Suite as LLM Router

**Date:** 2026-09-03 · **Addendum to:** Report v2 (same folder) · **Codebase:** court-lens-mcp `v1.3.5`
**Supersedes:** v2.1 rev 1 (single local-only design). This revision splits the MCP surface into two distinct, separately-registered profiles.
**Privacy:** all examples synthetic.

---

## Part 0 — Why two profiles, and how they register

The two things you want the MCP to do have **opposite contracts**:

| | Profile **`local`** | Profile **`routed`** |
|---|---|---|
| Output | **Evidence** — structured chunks + outline, no prose | **Prose** — a finished report, plus the evidence behind it |
| Who writes | Claude Desktop (the MCP client) | Sound Suite, using the providers configured in it |
| Models | **Sidecar / Ollama only**; cloud refused, fail-closed | Any provider configured in Sound Suite, chosen per tier by a preset |
| Data leaves the machine? | **Never** | Yes, to whichever provider the preset selects |
| Cost per call | GPU time only | API spend |
| Presets | Retrieval-side knobs only | Full: provider/model/effort/thinking/multi-pass/RLM per tier, **settable on the fly** |
| Typical latency | 5–50 s | 15–120 s |

Putting both behind one tool with a `useCloud` flag invites the failure you least want: a client flips the flag, and case documents go to a cloud model without anyone deciding that. **Separate registrations make the choice explicit at connection time**, visible in the client's server list, and impossible to change mid-conversation by a tool argument.

### 0.1 Registration URLs

Native transport does not exist yet (v2 §0), so "URL" today means a proxy path, and tomorrow means a native path. Both are designed now so nothing renames later.

| | Today (via proxy) | Today (Claude Desktop, stdio) | After native transport (SS-1b) |
|---|---|---|---|
| **local** | `http://localhost:9191/sound-suite-local/mcp` | bridge with `SOUND_SUITE_PROFILE=local` | `http://127.0.0.1:3000/api/mcp/local` |
| **routed** | `http://localhost:9191/sound-suite-routed/mcp` | bridge with `SOUND_SUITE_PROFILE=routed` | `http://127.0.0.1:3000/api/mcp/routed` |

Server names as the client sees them: **`sound-suite-local`** and **`sound-suite-routed`**. Both can be registered at once; Claude then sees two tool namespaces and picks by description. (Alternatives considered: `/evidence` + `/research`, `/sidecar` + `/router`. `local`/`routed` chosen because the words name the *policy*, which is the thing the user is choosing.)

### 0.2 What "profile" means in code

One registry, two views. `GET /api/mcp/tools?profile=local|routed` filters the tool list and stamps the response with `{ profile, policy, providersAllowed }`. `POST /api/mcp/execute` takes `profile` in the body (the bridge sets it from its env), and `ToolRegistry.execute` enforces the profile's policy before any LLM call. A tool declares which profiles it belongs to in its metadata:

```ts
profiles: ['local', 'routed']          // retrieval tools — both
profiles: ['local']                    // research_evidence*
profiles: ['routed']                   // research_report*, preset_*
```

The bridge is unchanged apart from reading `SOUND_SUITE_PROFILE` and sending it — one process per profile, both stateless.

---

## Part A — Profile `local`: the evidence engine

*(unchanged in substance from rev 1; condensed)*

### A.1 Contract

Sound Suite gathers, Claude writes. The pipeline runs decompose → parallel retrieval → pattern backstop → fuse → **rerank** → **RLM rounds** → **evidence outline**, and stops where synthesis would begin. Output is `EvidenceResult` (Appendix A): ranked chunks with citation fields (`documentId`, `blockType`, `headingPath`, `speakers`, `tableMarkdown`), sub-queries, RLM notes, an outline of `sections → evidenceIds` plus `gaps`, and `modelsUsed`.

| Stage | Model | Host |
|---|---|---|
| Embedding | `qwen3-embedding:0.6b` | Ollama |
| Rerank ("reindex") | `Qwen3-Reranker-8B` | vLLM fleet role |
| Decompose | small instruct | Ollama |
| RLM rounds | `rlm-qwen3-8b` | vLLM `:8100` |
| Evidence outline (replaces multi-pass) | small instruct | Ollama |
| Synthesis | — | **none** |

### A.2 Policy: local-only, fail-closed

```ts
// src/lib/mcp/llm-policy.ts
export function enforceProvider(profile, requested) {
  if (profile === 'local') {
    if (requested && requested !== 'ollama') throw new McpError('POLICY_VIOLATION', `profile "local" refuses provider "${requested}"`);
    return 'ollama';
  }
  return requested;   // routed: resolved by the preset (Part B)
}
```

Applied at `ToolRegistry.execute` (`tool-registry.ts:109`), `ai-helper.ts:80/104`, and inside the research tools. A `localLlm` dependency check probes Ollama, `:8100/v1/models`, and the reranker; tools whose models are down report `ready: false` and the bridge hides them — they never fall back to cloud.

### A.3 Tools in `local`

`research_evidence` (sync; self-promotes to a job for `deep-rlm`), `research_start` / `research_status` / `research_result` / `research_cancel`, plus the retrieval tools `query_case_knowledge`, `scan_for_pattern`, `query_case_graph`, `retrieve_exhibit`, `search_workflows`. The eleven LLM-backed analysis tools are included **only when Ollama is up**, pinned to it.

### A.4 Pipeline changes

- Split `gatherEvidence()` out of `deepSearch()` (`deep-search.ts:1780`); UI keeps `deepSearch`.
- RLM default `rlmMaxRounds: 2` over MCP; per-round narration emitted as progress.
- Evidence outline: the multi-pass outline call (`:1263-1300`) with a JSON-only output — no section writing.
- `deep-report` tier added to `query-router.ts` (report/memo/summarize language).

---

## Part B — Profile `routed`: Sound Suite as LLM router

### B.1 Contract

The client asks a question and gets **a finished report** written by the provider Sound Suite's preset selects for that tier — the full existing deep pipeline including synthesis, multi-pass, and RLM — plus the evidence it was written from, so the client can verify or extend it. This is the dashboard's Deep Search, exposed as a tool.

### B.2 The router: tier → provider/model/effort

A preset (Part C) carries a **routing table**. The tool classifies the question (or takes an explicit `mode`), looks up the tier, and calls the pipeline with that tier's settings:

```jsonc
"routing": {
  "fast":        { "provider": "ollama",    "model": "…",               "effort": null,    "thinking": false },
  "deep":        { "provider": "anthropic", "model": "claude-sonnet-5…", "effort": "medium", "thinking": true },
  "deep-report": { "provider": "anthropic", "model": "claude-opus-5…",   "effort": "high",   "thinking": true, "multiPass": true },
  "deep-rlm":    { "provider": "anthropic", "model": "claude-sonnet-5…", "effort": "medium", "useRlm": true, "rlmMaxRounds": 4 }
}
```

Each entry is validated against the capability registry (`src/lib/ai/models.ts`) at apply time: `clampEffort` (`:213`) snaps unsupported effort levels, `temperature: false` models get it omitted, `thinking` is dropped where `caps.thinking` is false. An entry naming an unconfigured provider fails at `preset_apply`, not mid-report.

**Default routing table** ships in code (`src/lib/mcp/routing-defaults.ts`) and is what the `routed` profile uses when no preset is active: `fast → ollama`, everything else → the provider marked default in Admin → AI Keys, `effort: medium`, `thinking: true` where supported. Operators change it by saving a preset named `default`.

### B.3 Tools in `routed`

Everything in `local`, plus:

| Tool | Purpose |
|---|---|
| `research_report` | sync; full pipeline with synthesis; self-promotes to a job above ~45 s expected |
| `report_start` / `report_status` / `report_result` / `report_cancel` | async; **`report_status` returns `partialReport`** — the synthesis tokens accumulated so far — so Claude Desktop can show or build on the draft as it streams |
| `preset_list` / `preset_get` / `preset_apply` / `preset_define` / `preset_save` / `preset_delete` | Part C |
| `routing_explain` | dry run: `{ query }` → which tier the router picks and which provider/model/effort the active preset maps it to, with cost class. Lets Claude check before spending. |

`research_report` schema:

```jsonc
{ "query": "string", "caseId?": "string",
  "mode?":   "auto | fast | deep | deep-report | deep-rlm",
  "preset?": "string (saved preset id/name) | PresetObject (inline, one-shot)",
  "overrides?": { "provider?", "model?", "effort?", "thinking?", "maxTokens?", "multiPass?", "useRlm?", "rlmMaxRounds?" },
  "history?": [ { "role": "user|assistant", "content": "string" } ],
  "includeEvidence?": true, "includeThoughts?": false }
```

Precedence: `overrides` > inline `preset` > active saved preset > `default` preset > code defaults. Every result echoes the resolved settings in `routing.resolved` so nothing is silent.

### B.4 Provenance and cost logging

Every `routed` call writes to `actionLogs`: tier, provider, model, effort, tokens in/out, ms, and the `documentId`s whose text was sent to the provider. That last field matters: it is the record of which case material left the machine and to whom. `report_status` also carries a running `cost: { provider, inputTokens, outputTokens }`.

---

## Part C — Presets, on the fly

### C.1 Server-side schema (today the server treats `settings` as opaque JSON)

`SearchPreset.settings` (`prisma/schema.prisma:750`) gets a defined shape the server validates and interprets — the same fields the UI already writes (`search-interface.tsx:144-167`), plus the routing table:

```ts
interface PresetV2 {
  version: 2;
  name: string;
  // UI-level knobs (kept for parity)
  deep?: boolean; rlm?: boolean; multiPass?: boolean; thinking?: boolean;
  effort?: EffortLevel; maxTokens?: number; provider?: string; model?: string;
  includeCaseScope?: boolean; caseId?: string;
  // MCP router
  routing?: Partial<Record<'fast'|'deep'|'deep-report'|'deep-rlm', TierSettings>>;
  // retrieval side — the only part `local` honours
  retrieval?: { rerankPoolSize?: number; limitPerSubQuery?: number; rlmMaxRounds?: number; maxEvidence?: number };
}
```

Version-1 presets (current UI blobs) are read as-is and upgraded on first save.

### C.2 Tools

| Tool | Behaviour |
|---|---|
| `preset_list` | names, ids, one-line summary of routing |
| `preset_get { idOrName }` | full object |
| `preset_define { preset }` | validates an **inline** preset and returns a **session-scoped handle** (`tmp_…`, lives 1 h, never persisted) — this is "set on the fly" |
| `preset_apply { idOrName | handle }` | makes it the active preset for this MCP session |
| `preset_save { handle, name }` | persists a defined preset to `SearchPreset` |
| `preset_delete { id }` | — |

"Session" = the MCP session id the bridge already forwards (`execute/route.ts:42-47`); active preset is stored keyed by it, 1 h idle expiry. A caller can also skip all of this and pass `preset` inline on every `research_report` call.

### C.3 What `local` honours

Only `retrieval.*`. Any `routing`, `provider`, `model` in a preset applied on the `local` profile is ignored **and reported** in `routing.ignored[]` — never silently upgraded to cloud.

---

## Part D — Streaming, both profiles

MCP has no partial tool result. What works everywhere is the **job pattern**; progress notifications layer on top.

| | `local` | `routed` |
|---|---|---|
| Job tools | `research_*` | `report_*` |
| `…_status` returns | new `evidence[]` since `cursor`, phase, RLM notes, outline when ready | all of that **plus `partialReport`** (accumulated synthesis text) and `cost` |
| Progress notification `message` | `"rerank 150 → 40"`, `"rlm round 2/2"` | same, plus `"writing section 3/5"` |
| Logging notification | RLM narration (`thoughts`) | RLM narration + model thinking summary if `includeThoughts` |
| Self-promotion rule | `deep-rlm` always async | anything the router estimates > 45 s |

Event mapping from the existing NDJSON writer (`deep/route.ts:66-105`): `progress` → `notifications/progress`; `thoughts` → `notifications/message`; `token` → appended to the job's `partialReport` (routed only; dropped in local); `result` → job done; `error` → `isError`.

Job state lives on the existing `JobQueue`; HTTP surface `POST/GET/DELETE /api/mcp/{research|report}/…` plus `GET …/:id/events` (NDJSON replay + tail). Finished jobs kept 30 min.

---

## Part E — Registration, bridge, proxy

### E.1 Sound Suite

- `GET /api/mcp/tools?profile=` and `profile` on execute (Part 0.2).
- Native paths reserved now: `/api/mcp/local` and `/api/mcp/routed` — both 404 until SS-1b, then both mount the Streamable HTTP transport with the profile fixed by path.
- Docs (`public/docs/install-mcp.md`) rewritten to show exactly the two registrations below, generated from the registry.

### E.2 Bridge (`~/sound-suite-bridge/bridge.mjs`)

- `SOUND_SUITE_PROFILE` env (`local` | `routed`, default `local`); passed as `?profile=` on the catalog fetch and `profile` in the execute body; server name `sound-suite-${profile}`.
- Progress: read `_meta.progressToken`, tail `…/events`, emit `notifications/progress` and `notifications/message`; advertise `logging: {}`.
- Still stateless; run two processes.

### E.3 mcp-proxy `config.json` (Claude Code / Cursor)

```jsonc
{ "name": "sound-suite-local",  "path": "/sound-suite-local/mcp",  "type": "stdio", "command": "node",
  "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"], "cwd": "/Users/alper/sound-suite-bridge",
  "callTimeoutMs": 180000, "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "local" } },
{ "name": "sound-suite-routed", "path": "/sound-suite-routed/mcp", "type": "stdio", "command": "node",
  "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"], "cwd": "/Users/alper/sound-suite-bridge",
  "callTimeoutMs": 300000, "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "routed" } }
```

Replace the single `sound-suite` upstream. Plus the ~40-line change to forward `ProgressNotificationSchema` and route it by token to the originating session (`upstreams/*.mjs`, `routes/mcpRoute.mjs`).

### E.4 Claude Desktop

```jsonc
"sound-suite-local":  { "command": "/abs/node", "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"],
                        "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "local" } },
"sound-suite-routed": { "command": "/abs/node", "args": ["/Users/alper/sound-suite-bridge/bridge.mjs"],
                        "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "routed" } }
```

Register one or both. With only `local` registered, no cloud call is possible from that Desktop conversation regardless of what any tool argument says.

---

## Part F — Work items and where they live

| # | Item | Lives in | Profile | Size |
|---|---|---|---|---|
| 1 | Profile concept: `profiles[]` on tool metadata, `?profile=` on tools, `profile` on execute, policy enforcement at the three choke points | Sound Suite | both | S |
| 2 | `gatherEvidence` split; `EvidenceResult` | Sound Suite | local | M |
| 3 | Evidence outline (JSON-only outline call) | Sound Suite | local | S |
| 4 | `deep-report` router tier | Sound Suite | both | XS |
| 5 | Research job type + HTTP routes + events stream | Sound Suite | both | M |
| 6 | `research_*` tools (sync + async) | Sound Suite | local | M |
| 7 | `PresetV2` schema, validation, v1 upgrade; session-scoped active preset | Sound Suite | routed | M |
| 8 | `preset_*` tools; `routing_explain` | Sound Suite | routed | S |
| 9 | Router: tier → `TierSettings` resolution with capability clamping; `routing-defaults.ts` | Sound Suite | routed | S |
| 10 | `research_report` / `report_*` tools with `partialReport` and `cost` | Sound Suite | routed | M |
| 11 | Provenance logging (documentIds sent, provider, tokens) | Sound Suite | routed | S |
| 12 | Bridge: profile env + progress relay + `logging` capability | Bridge | both | S |
| 13 | Proxy: two upstreams; progress forwarding by token | mcp-proxy | both | S |
| 14 | Docs regenerated from registry with both registrations | Sound Suite | both | S |
| 15 | Tests: local refuses cloud (unit + integration); ignored-fields reported; `deep-rlm` defers; cursor monotonic; preset clamping per model; provenance row written | Sound Suite | both | M |

**Principle:** the proxy is a transport and the bridge is a forwarder. Every decision about models, presets, evidence, or jobs is Sound Suite's. The moment either of the other two knows what a preset is, there are two copies that drift.

**Sequencing.** Ship `local` first: items 1, 2, 6 (sync half) give a working local-only `research_evidence` for `fast`/`deep` through the *existing* bridge with no bridge or proxy change. Then 5 + 6 (async) + 3 + 4 for RLM and streaming. Then `routed`: 7 → 9 → 8 → 10 → 11. Bridge/proxy (12, 13) once anything async exists. Docs and tests alongside.

---

## Part G — What this does not change

- Dashboard search is untouched; profiles apply to the MCP surface only.
- v2 §6 security findings stand and come first. Two profiles behind an unauthenticated tunnel are two unauthenticated tunnels. In particular, **`routed` must never be reachable remotely without auth** — it spends API credit and sends case text to third parties on request.
- The bridge remains necessary until SS-1b; the profile paths are reserved so nothing renames when it lands.

---

## Appendix A — `EvidenceResult`

```ts
export interface EvidenceItem {
  id: string; documentId: string; text: string; score: number; rerankScore?: number;
  blockType?: 'paragraph'|'table'|'footnote'|'figure'; headingPath?: string; speakers?: string; tableMarkdown?: string;
  hits: number; source: 'retrieval'|'pattern'|`rlm-round-${number}`; rlmNote?: string;
}
export interface EvidenceResult {
  query: string;
  routing: { requested: ResearchMode; mode: ResearchMode; reason: string; confidence: number; ignored?: string[] };
  subQueries: string[]; evidence: EvidenceItem[];
  outline?: { sections: { title: string; evidenceIds: string[]; gap?: string }[]; gaps: string[] };
  rlm?: { rounds: number; toolCalls: number; notes: string[] };
  stats: { retrievals: number; chunksFused: number; rerankPool: number; ms: number; phases: Record<string, number> };
  profile: 'local'; localOnly: true;
  modelsUsed: Record<'decompose'|'rerank'|'rlm'|'outline', string>;
}
```

## Appendix B — `ReportResult` (routed)

```ts
export interface ReportResult extends Omit<EvidenceResult, 'profile'|'localOnly'|'modelsUsed'> {
  profile: 'routed';
  report: string;                         // finished prose (markdown)
  partial?: boolean;                      // true on report_status before completion
  routing: EvidenceResult['routing'] & { resolved: TierSettings; presetUsed?: string };
  cost: { provider: string; model: string; inputTokens: number; outputTokens: number };
  provenance: { documentIdsSent: string[]; provider: string };
  modelsUsed: Record<'decompose'|'rerank'|'rlm'|'outline'|'synthesis', string>;
}
```

## Appendix C — `TierSettings`

```ts
export interface TierSettings {
  provider: string; model?: string;
  effort?: 'low'|'medium'|'high'|'xhigh'|'max'; thinking?: boolean; maxTokens?: number;
  multiPass?: boolean; useRlm?: boolean; rlmMaxRounds?: number;
}
```
