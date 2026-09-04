# MCP two profiles — `local` evidence engine and `routed` LLM router

**Status:** Implemented (2026-09-03) — pending operator steps below · **Effort:** L · **Priority:** High · **Source:** `docs/MCP-Improvements/REPORT-v2.1-local-evidence-engine-streaming.md`

The MCP surface is split into two separately-registered profiles with opposite contracts:

| | `local` | `routed` |
|---|---|---|
| Output | Evidence — ranked chunks + outline, no prose | A finished report plus the evidence behind it |
| Models | Sidecar / Ollama only; cloud refused, fail-closed | Any provider configured in Sound Suite, chosen per tier by a preset |
| Data leaves the machine | Never | Yes, to the provider the preset selects |
| Presets | Retrieval knobs only | Full routing table, settable on the fly |

The client picks the policy at registration time (`SOUND_SUITE_PROFILE=local|routed` on the
bridge). No tool argument can flip a `local` session to cloud.

## Principle

The proxy is a transport and the bridge is a forwarder. Every decision about models, presets,
evidence, or jobs is Sound Suite's.

## Design summary

- **Profile concept** — `ToolMetadata.profiles: McpProfile[]`. `GET /api/mcp/tools?profile=`
  filters and stamps `{ profile, policy, providersAllowed }`. `POST /api/mcp/execute` takes
  `profile` in the body. `ToolRegistry.execute` enforces the profile policy before any LLM call
  (`src/lib/mcp/llm-policy.ts`, `enforceProvider`). No `profile` → `local` (fail-closed).
- **Local evidence engine** — `gatherEvidence()` (`src/lib/search/gather-evidence.ts`) runs
  decompose → parallel retrieval → pattern backstop → fuse → rerank → RLM rounds → evidence
  outline and returns `EvidenceResult`. Never synthesises.
- **Router** — `src/lib/mcp/routed/routing.ts` resolves tier → `TierSettings` from the active preset,
  clamping against the capability registry (`src/lib/ai/models.ts`). Defaults in
  `src/lib/mcp/routing-defaults.ts`.
- **Presets v2** — `SearchPreset.settings` gains a validated shape (`PresetV2`) with `routing`
  and `retrieval` sections. v1 blobs are read as-is and upgraded on save. Session-scoped
  active preset keyed by `mcp-session-id`, 1 h idle expiry.
- **Jobs** — `src/lib/mcp/research-jobs.ts`: in-memory job store with an NDJSON event log,
  cursor-based `evidence[]` delivery, `partialReport` accumulation (routed only), 30 min TTL.
  HTTP surface `POST/GET/DELETE /api/mcp/{research|report}/…` and `GET …/:id/events`.
- **Provenance** — every routed call writes an `ActionLog` row (`logType: 'mcp-routed'`) with
  tier, provider, model, effort, tokens, ms, and the `documentId`s whose text left the machine.
- **Bridge** — reads `SOUND_SUITE_PROFILE`, sends `?profile=` / `profile`, names itself
  `sound-suite-${profile}`, relays job events as `notifications/progress` and
  `notifications/message`.

## Tool matrix

| Tool | local | routed |
|---|---|---|
| `query_case_knowledge`, `scan_for_pattern`, `query_case_graph`, `retrieve_exhibit`, `search_workflows` | ✓ | ✓ |
| ten LLM analysis tools | ✓ (pinned to Ollama, hidden when Ollama down) | ✓ |
| `research_evidence`, `research_start/status/result/cancel` | ✓ | ✓ |
| `research_report`, `report_start/status/result/cancel` | | ✓ |
| `preset_list/get/define/apply/save/delete`, `routing_explain` | | ✓ |

## Work items

| # | Item | Stream | Status |
|---|---|---|---|
| 1 | Profile concept, `?profile=`, `profile` on execute, policy at the choke points | foundation | ✅ |
| 4 | `deep-report` router tier | foundation | ✅ |
| 5 | Research job store + HTTP routes + events stream | foundation | ✅ |
| 9 | `TierSettings` types, `routing-defaults.ts` | foundation | ✅ |
| 2 | `gatherEvidence` split; `EvidenceResult` | local | ✅ |
| 3 | Evidence outline (JSON-only outline call) | local | ✅ |
| 6 | `research_*` tools (sync + async) | local | ✅ |
| 7 | `PresetV2` schema, validation, v1 upgrade; session-scoped active preset | routed | ✅ |
| 8 | `preset_*` tools; `routing_explain` | routed | ✅ |
| 9b | Router resolution with capability clamping | routed | ✅ |
| 10 | `research_report` / `report_*` tools with `partialReport` and `cost` | routed | ✅ |
| 11 | Provenance logging | routed | ✅ |
| 12 | Bridge: profile env + progress relay + `logging` capability | bridge | ✅ |
| 13 | Proxy: two upstreams; progress forwarding by token | bridge | ✅ |
| 14 | Docs regenerated with both registrations | bridge | ✅ |
| 15 | Tests | all | ✅ |
| 16 | Final docs pass: update `public/docs/install-mcp.md` (rendered at `/docs#install-mcp`) from the finished tool registry — tool matrix, schemas, job flow, presets — and verify the page renders | docs | ✅ |

## v3 follow-up round (2026-09-04)

See `docs/MCP-Improvements/REPORT-v3.1-verification-and-fixes.md`.

| # | Item | Status |
|---|---|---|
| 17 | M-1 decompose hang: timeout, heuristic fallback, readiness smoke, `phaseStartedAt` | Code ✅ · live run blocked on an unreachable embedding host |
| 18 | M-2 proxy reload + strict `?profile=` parsing (`bogus` → 400, bare → local) | ✅ |
| 19 | M-3 routed defaults resolve cloud-first from the default preset | ✅ |
| 20 | M-4 proxy progress relay by token | ✅ |
| 21 | M-5 security (v2 §6) | ⛔ open — not attempted |
| 22 | M-6a report-language regex tightened | ✅ |
| 23 | M-6b per-tool tests for the 12 analysis tools | ⚠️ not written |
| 24 | M-6c pre-existing test/type failures | ✅ |
| 25 | Draft-record guard (detector, chunk column, citations, prompts, MCP filter, UI, backfill) | ✅ code · backfill **not applied** |

## Operator follow-ups (not automated)

- **Apply the draft backfill**: `npx tsx scripts/backfill-draft-status.ts --apply` (run without a
  `DATABASE_URL` override). Until then no pre-existing document carries `recordStatus`, so the
  guard has no effect on already-indexed data.
- The mcp-proxy has been restarted with the two upstreams (`/sound-suite-local/mcp`,
  `/sound-suite-routed/mcp`); the legacy `/sound-suite/mcp` path is gone. `~/.claude.json` is
  migrated — **re-register any other client** that used the old path. The proxy change is committed
  locally in `~/Code/mcp-proxy` as `d36c0a1` and is **unpushed**.
- The installed bridge at `~/sound-suite-bridge/bridge.mjs` was synced from `scripts/mcp-bridge/bridge.mjs` (old copy kept as `bridge.mjs.bak`). Claude Desktop entries must set `SOUND_SUITE_PROFILE`.
- The embedding host `10.10.20.5:11434` is unreachable; M-1's live verification waits on it.
- The `default` preset is memoised per process — editing it needs a dev-server restart.

## Registration

Today (bridge, stdio):

```jsonc
"sound-suite-local":  { "command": "node", "args": ["~/sound-suite-bridge/bridge.mjs"],
                        "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "local" } },
"sound-suite-routed": { "command": "node", "args": ["~/sound-suite-bridge/bridge.mjs"],
                        "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "routed" } }
```

Native paths reserved: `/api/mcp/local` and `/api/mcp/routed` (404 until native transport lands).

## What this does not change

- Dashboard search is untouched; profiles apply to the MCP surface only.
- `routed` must never be reachable remotely without auth — it spends API credit and sends
  case text to third parties on request.

## Privacy

All fixtures and examples are synthetic. No case numbers, party names, or real document text.
