# PLAN — Search Presets, Left Panel, Chat Continuity, Opus/Sonnet 5, UI Lockup Fix

Date: 2026-08-11. Sources: three research agents (presets/left-panel design, chat-continuity
diagnosis with live-browser verification, UI-lockup performance diagnosis). No code changed yet.

## Corrected problem statements

1. **"Changing the model resets the chat" — false as stated.** The model select
   (`src/components/search-interface.tsx:2100`/`:2162`) is a bare setter; verified live that
   switching model and provider leaves the conversation intact. What actually blanks the chat:
   - **Deep / Compare toggles** (`search-interface.tsx:2215`, `:2237`) call `router.push` into a
     different route segment (`/search/ai` → `/search/ai/deep`) → **full component remount** →
     every `useState` resets and `currentSessionId` mints `session-${Date.now()}`. Toggling back
     does NOT restore turns (verified: DOM subtree torn down, `isConnected:false`). The
     module-scoped runners still hold the turns, but the mirror effects gate on
     `s.sessionId === currentSessionId` (`:1001`, `:1036`) and the new id never matches.
   - **Case scope change** (`handleCaseFilterChange`, `:1336-1346`) deliberately clears all turn
     state and mints a new session.
   - **Provider change** (`handleProviderChange`, `:1332`) silently rewrites the model to
     `models[0]` of the new provider — chat survives but the model changes under the user.
   - Secondary: single-shot and deep turns live in two arrays rendered mutually exclusively
     (`:2436` vs `:2464`), so even without the remount a Deep toggle *hides* the other history.

2. **UI lockup during active search — client-side, confirmed.** Per streamed token:
   - Full `react-markdown` re-parse of the entire accumulated answer
     (`search-interface.tsx:2574`; runners append per-token in
     `src/lib/search/deep-search-runner.ts:307-313`, `ai-search-runner.ts:259-265`) → O(N²).
   - Forced synchronous reflow: effect at `:1483-1493` reads `scrollHeight` + `scrollTo` on every
     `streamingAnswer` change, unthrottled.
   - Identity churn: `:990-995` and `:1002-1009` rebuild `progressLog`/`deepTurns` arrays on every
     emit, defeating `React.memo` on `AIResultCard`.
   - `reactStrictMode: true` doubles render cost in dev.
   - Ruled out with evidence: remote reranker (HTTP), bounded LanceDB queries, no sync SQLite in
     the search path, proper async NDJSON stream reads.
   - Discriminating test while frozen:
     `curl -s --max-time 3 -o /dev/null -w "%{http_code} %{time_total}\n" http://localhost:3000/api/health`
     — prompt response confirms browser-only; hang implicates the Node event loop (then check
     in-process `TransformersEmbeddingProvider`, `.env EMBEDDING_PROVIDER="transformers"`).

## Workstream A — UI lockup fix (smallest, do first)

Batch token emission in both runners: in `handleEvent`
(`deep-search-runner.ts:264-322`, `ai-search-runner.ts:252-277`), accumulate `event.text` and
`emit()` on a ~50–100 ms timer / rAF instead of per token. One edit per runner; fixes all three
confirmed causes at once. Optional follow-ups: render the live streaming tail as plain text
(markdown only on completion), move `progressLog`/`turns` mirroring off the token path.

### Amendment 2026-08-11 (implemented): OpenAI failures + model catalogs

The reported "OpenAI errored on the effort setting" had a different root cause: effort was
never sent to OpenAI — the 400 was `max_tokens` ("use 'max_completion_tokens' instead") plus
non-default temperature on reasoning models, confirmed from the app's own log. Implemented:
`AIModelCaps` per-model capabilities in `models.ts` (tokenParam, effort list + param name,
temperature, maxTokensCap), `shapeOpenAICompatParams()` used by both OpenAI-compatible builders
(streaming + buffered fallback), effort threaded to OpenAI/xAI as clamped `reasoning_effort`,
catalog refresh (OpenAI → GPT-5.6 Sol/Terra/Luna + GPT-5.5; Grok → 4.5/4.3; Groq → current
production models), key test via `models.list()` (immune to catalog drift), client model
fallback + effort clamp effect, capability-driven Effort selectors, stale defaults bumped
(ai-helper, document-summarizer). Tests: `src/lib/ai/__tests__/model-caps.test.ts` (11 passing).
Note: `reasoning_effort` as the Chat Completions param name is per docs; verify with one live
OpenAI search.

## Workstream B — Opus 5 + Sonnet 5 in the model picker

Model ids: `claude-opus-5`, `claude-sonnet-5`.
1. Catalog `src/lib/ai/models.ts:41` — add both entries (also covers server allow-list;
   `api/search/ai/route.ts:69` and `api/search/deep/route.ts:45` validate against it).
2. **Blocker:** `isAdaptiveOpus` in `src/lib/ai/ai-provider.ts:320-323` — add
   `claude-opus-5` and `claude-sonnet-5` prefixes, else non-default temperature goes on the wire
   and every request 400s (same failure the Fable 5 commit fixed).
3. `isAdaptiveThinkingModel` in `src/lib/search/deep-search.ts:853-855` — add both, else
   high-effort deep search can return a blank report.
4. Export shared `supportsAdaptiveEffort(model)` from `models.ts`; use at
   `search-interface.tsx:2276` and `draft-chat-panel.tsx:1134` (4th duplication of the list).
Notes: Thinking toggle is a no-op on Opus 5 (thinking on by default; code only ever omits the
`thinking` block, never sends `disabled`). Verify with one message per model.

## Workstream C — Chat continuity (chat works regardless of model/mode)

1. Make chat state survive remounts: move `aiTurns`, `deepTurns`, `currentSessionId` to
   module scope beside the runners (pattern already used; comment at `:974-978`), component
   subscribes. Alternative (unvalidated): drop `router.push` on Deep/Compare, use a query param
   with `router.replace`. Persist `currentSessionId` so mirror guards match after real reloads.
2. Unify turn rendering into one ordered list keyed by per-turn `mode` (replaces `:2436`/`:2464`
   branch). Requires stable turn ids — `deleteTurn` (`:1570-1586`) indexes by position today.
3. Case scope: remove the clears in `handleCaseFilterChange`; scope becomes per-turn metadata.
   (Preset apply must confirm before ever routing through the old destructive path.)
4. Per-turn metadata in the history format: `ChatTurn` (`src/lib/chat/history-service.ts:8-27`)
   gains `provider`, `model`, `mode`, settings blob; stamp at submit time, not persist time
   (today `:1553-1554` relabels every earlier turn on save — live data-integrity bug). Serialize
   both turn arrays; session-level fields become "most recent" hints.
5. Per-turn model badge on assistant turns (`AIResultCard` already receives `turn.result` with
   model/provider; replayed turns need step 4).
6. Replay fix: restore `sources` for regular-AI turns in `loadSession` (`:1894`).
Backend: no changes needed — model/settings are already per-request (`:1395-1450`), history is
plain `{role,content}[]`. Risk: `maxTokens` is one persisted value; long history under a
large-context model can overflow a smaller one (no per-model trimming today). Compare mode writes
multiple `aiTurns` per query (`:1700`) — schema must allow one-query-to-many-models.

## Workstream D — Settings tab in the right panel + presets

**REVISED 2026-08-11 per user direction.** The original proposal (move
Workflows/History/Bookmarks/Docs to the left aside) is DROPPED — never implemented. What the
user wants instead: move the top-toolbar controls ("all that": provider picker, model picker,
case scope, Auto/Deep/RLM/Compare/Thinking/Multi-Pass toggles, Tokens, Effort) **into the right
panel as a new FIRST tab, positioned left of Workflows**. The right panel tab order becomes:
**Settings | Workflows | History | Bookmarks→Presets | Docs | Haystack** (tab strip at
`search-interface.tsx:~3592`, persisted as `search.infoTab`).

- New "Settings" tab: vertical stack of the same controls the toolbar renders today (the three
  duplicated toggle blocks make this the moment to extract ONE shared settings component used
  by both toolbar and tab — or move them entirely into the tab and slim the toolbar down to
  New Chat + active-preset name). Decide with the user whether the top toolbar keeps a compact
  summary (preset name + model) or disappears.
- Presets stay in the plan but live beside Settings in the right panel: the existing Bookmarks
  stub (`:3622-3630`, empty state already says "Saved presets will appear here") becomes the
  Presets tab. Save-current-settings button sits in the Settings tab.
- Right aside width: current 200–400 clamp is tight for a full settings stack — raise max to
  ~480 in `use-resizable-columns.ts` and bump the persist key so stale widths don't pin it.
- Left aside (Tools nav) is untouched.

Preset model (`SearchPreset`): id, name, version:1, timestamps, settings = provider, model,
auto/deep/rlm/compare/thinking/multiPass, maxTokens, effort, `includeCaseScope` (**default
false** — case scope is the destructive setting; explicit checkbox + warning), `caseId?`,
`compareSelections?` (**required when compare:true**, else submit errors).

Storage: IndexedDB via existing `@/lib/indexed-db` — keys `search.presets`,
`search.defaultPresetId`, `search.activePresetId`. Per-browser; if multi-device is needed later,
swap accessor for an API route mirroring `history-service.ts`. Show active preset name in the
toolbar with a "modified" dot when live settings diverge.

`applyPreset` guards:
1. Never call `handleProviderChange` (overwrites model) — set provider then model directly.
2. Never call `handleCaseFilterChange` unless `includeCaseScope` && user confirms.
3. Hydration race: `usePersistedState` (`:200-217`) late-reads can silently revert an early
   apply — gate apply on hydration-complete or use the monotonic-token pattern (`:1800`).
4. Validate Ollama models installed at apply time (fallback like `:1308-1309`).

## Implementation order

1. **A** — token batching (unblocks usable streaming; tiny diff).
2. **B** — Opus 5 / Sonnet 5 (independent; ship + verify per model).
3. **C1–C2** — remount-proof chat state + unified turn list (prereq for preset switching mid-chat).
4. **C3–C6** — per-turn metadata, badges, replay fixes.
5. **D step "extract settings object"** — `getCurrentSettings()` / `applySettings()` next to
   `handleNewChat` (`:1777`); no behavior change.
6. **D** — preset storage/CRUD + Presets tab.
7. **D** — Settings tab (first tab, left of Workflows) hosting the toolbar controls + presets
   tab + column-hook width bump (own commit; revertible independently).

Out of scope: reducer/context refactor of the 4,504-line `search-interface.tsx`.
