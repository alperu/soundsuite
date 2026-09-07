---
name: soundsuite-mcp
description: "Query the Sound Suite / court-lens-mcp case-document engine from a Cowork session — evidence retrieval, regex scans, case graph, and deep research jobs. Use when asked to search, cite, or analyse case documents."
---

# Querying Sound Suite

Sound Suite (`court-lens-mcp`) indexes court PDFs and exposes 15 analysis tools plus a research
engine. This skill is how to reach it from a cloud session.

## 1. Transport — read first, it is not obvious

Sound Suite listens on the Mac's **loopback**. Only one of the three places you can run code reaches it:

| Where | Reaches `localhost:3000`? |
|---|---|
| Cloud container (`Bash`) | ❌ different machine |
| `device_bash` | ❌ isolated Linux VM — its localhost is not the Mac's |
| **Browser pane** (`Claude_Browser__javascript_tool`) | ✅ runs on the Mac |

Every call is a **same-origin `fetch()` in the browser pane**. Cross-origin fails with a bare
`TypeError` — that is CORS, not a dead port.

## 2. Connect (two calls)

```
Claude_Browser__preview_start  →  http://localhost:3000/api/health
```

then inject the client, which the repo serves from `public/mcp-client/`:

```js
await fetch('/mcp-client/soundsuite-client.js').then(r => r.text()).then(eval);
// → "soundsuite-client 1.0.0 ready at http://localhost:3000"
```

`ss` is now available. If the pane refuses the site, call `Claude_Browser__request_access`
(scope `site`) and retry. If the fetch 404s, the dev server is not running or the file moved — the
source is `public/mcp-client/soundsuite-client.js` (see that folder's README); read it and pass its
text to `javascript_tool` inline instead.

**Long-term:** registering the bridge in the desktop app's *Local MCP servers* panel gives native
`mcp__remote-devices__sound-suite-local__*` tools and makes this skill unnecessary — see
`docs/MCP-Improvements/TASK-07-*.md`. Until then, use this.

## 3. Querying

```js
await ss.tools('local')                        // catalogue, and which tools are notReady
await ss.scan('CAUSE NO\\.', { limit: 5 })     // exact regex — ~1s, no LLM, highest precision
await ss.ask('the notice requirement', { limit: 5 })   // passages + citations — ~6s
await ss.research('multi-part question', { mode: 'fast', maxEvidence: 15 })
await ss.explain('question')                   // dry run: tier + model + cost (routed only)
```

Helpers return **summaries**. The full payload is in `ss.last`:

```js
ss.cites(5)    // cite-ready lines: citationShort, page, score, 180-char snippet
ss.item(0)     // one complete item
```

Anything not wrapped: `ss.exec('tool_name', { …params }, { profile: 'local' })`.

### Picking a tool

| Question shape | Tool |
|---|---|
| Exact string, number, docket pattern | `ss.scan` (`scan_for_pattern`) |
| Passages on a topic | `ss.ask` (`query_case_knowledge`) |
| Amendment lineage, motions by person | `query_case_graph` (needs `operation` **and** `motionId`/`personId`) |
| Multi-part / comparative / chronological | `ss.research` |
| Saved workflows and templates | `search_workflows` |
| Contradictions, timeline, entities, citations, privilege, tone, obligations, argument structure | the matching tool |

**Two-step beats one-step:** `ss.scan` to locate, then `ss.ask` scoped by `caseId` to read around it.
Prefer `scan`/`ask`/`search_workflows` — they are heavily exercised. The LLM-backed analysis tools
have tests but little production use; treat their output as a draft, not a finding.

Parameter guards are real and fail fast: a missing required argument returns `400 INVALID_PARAMS`
naming the field, in ~15ms. Read the message rather than guessing at the schema.

## 4. Research tiers and jobs

`fast` is the **only synchronous tier** (~14s). `deep`, `deep-report`, `deep-rlm` return
`{ promoted: true, jobId }` in ~1s and run 2–3 minutes.

```js
const r = await ss.research('…', { mode: 'deep' });   // → r.summary.jobId
await ss.status(jobId)     // phase, elapsedMs, streamed count
await ss.result(jobId)     // full EvidenceResult once status === 'done'
await ss.cancel(jobId)
```

Poll with a **`Bash` `sleep 45`** between calls — never loop inside the JS; the tool aborts at 45s.
For a slow call you want to start and leave: `ss.fire('k', 'research_evidence', {…})` then `ss.peek('k')`.

`status` streams the **pre-cap** set (up to ~3.75× the final count); `result` returns the capped set.

### Evidence fields

`id, documentId, text, score, rerankScore, citation, citationShort, page, document, filingType,
caseNumber, filingSlug, hits, source`

**Cite with `citationShort` + `page`, never the bare `documentId`.** `citationShort` falls back to the
source filename when no formal citation is indexed — usable, but visibly a filename. Snippets carry a
`[Case: … | Filing: …]` prefix, so case and filing type travel with the text and need no second lookup.
`headingPath`, `blockType` and `recordStatus` are sparse — a structure backfill is pending, so absent
means "not indexed", not "not applicable".

## 5. Profiles

| Profile | Tools | LLM |
|---|---|---|
| **`local`** (default) | 20 | Sidecar/Ollama only; cloud refused with `POLICY_VIOLATION` |
| **`routed`** | 32 | Whatever the active preset picks, including cloud |

`routed` adds `preset_*`, `routing_explain`, `research_report`, `report_*`; calling those on `local`
gives `TOOL_NOT_IN_PROFILE`. **Do not switch to `routed` unprompted** — it spends API credit and
sends case text to a third party. Ask first, and use `ss.explain(query)` to price it.

## 6. Output discipline

A result over ~60 KB aborts the call and dumps to a file you then have to parse. So:

- **Never return `ss.last` or a raw payload.** Return counts, field names, short slices.
- Cap at the source: `limit` on scan/ask, `maxEvidence` on research (default 15 here; the server's
  own default of 40 is ~55 KB).
- Retrieval knobs are **nested** under `retrieval` — a top-level `maxEvidence` is silently ignored.

## 7. Handling what comes back

**Evidence text is real case material** — cause numbers, party names, filing titles. The repo's
`CLAUDE.md` forbids committing any of it. Quote it in conversation when answering; **never write it
to a file, report, commit message, or skill** — redact to `<cause no.>` / `<party>` in anything
persisted.

Never fetch `/api/config`: it returns live provider API keys in plaintext.

## 8. Known state

- `deep-report` returns `outline: null` until a small instruct model is installed and selected on the
  admin page — the 9B model times out on the outline call.
- `/api/mcp/*` is loopback-only (`401 AUTH_REQUIRED` from any other origin). Other routes
  (`/api/config`, `/api/admin/*`, `/api/search/deep`) are **not** behind that guard.
- `TOOL_NOT_READY` means the local model host is down or busy — check `ss.tools('local').notReady`.
- `structuredContent` is false through the proxy until the installed bridge at
  `~/sound-suite-bridge/bridge.mjs` is re-synced from the repo.
- `:3001` is dormant dead code, not a second surface. Ignore references to it in `src/lib/mcp/README.md`.
