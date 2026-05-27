# MCP Usage Audit — `/search` Page

Read-only audit of every server-side path triggered by the `/search` page,
mapping which calls route through the MCP tool registry (`getToolRegistry()`
→ `registry.execute(...)`) and which bypass it.

The registry is the single funnel for: per-env enable/disable, input
validation against each tool's JSON schema, uniform error envelopes, and
execution logging via `ToolExecutionLogger`. Anything that bypasses it loses
all four guarantees.

---

## 1. Summary

- **All retrieval (vector / pattern / hybrid) goes through MCP.** Every
  search-like fetch the page triggers — `/api/search/ai`,
  `/api/search/deep`, `/api/search/semantic`, `/api/search/pattern`,
  `/api/search/unified`, and the deprecated `/api/search/haystack` (which
  forwards to `/api/search/unified`) — dispatches through
  `registry.execute('query_case_knowledge', ...)` or
  `registry.execute('scan_for_pattern', ...)`. RLM's per-round tool loop
  (`deep-search.ts:1059`) also calls the registry.
- **Three helper endpoints bypass MCP by design — and that's correct.**
  `/api/search/interpret`, `/api/search/refs/[id]`, and
  `/api/search/path-values` are metadata / autocomplete endpoints, not
  retrieval. They query Prisma directly for chip labels, ref resolution,
  and value pickers. None of the existing MCP tools cover this surface; an
  operator disabling MCP tools shouldn't break chip rendering either.
- **`/api/search/axon-generate` bypasses MCP and that's fine.** It's a
  natural-language → Axon-filter translator that calls the LLM via
  `completeAI()` — there is no MCP tool for "translate English to query
  syntax". Same reasoning as above.
- **`/api/search/chat-attachments/*` is ingestion-side and bypasses MCP.**
  Upload / delete / reindex of per-chat PDFs writes directly to
  `getChatVectorStore()` and Prisma. MCP is the query surface; ingestion
  has never been an MCP responsibility in this codebase.
- **One partial / nuanced finding.** `/api/search/ai` and `/api/search/deep`
  reach into `prisma.workflow.findMany(...)` directly to load workflow
  context (`ai/route.ts:220`, `deep/route.ts:80`) even though a
  `search_workflows` MCP tool exists (`src/lib/mcp/tools/search-workflows.ts:40`).
  This is a "should-use-MCP-but-doesn't" candidate — see §4.

---

## 2. Per-endpoint table

There are **11** route files under `src/app/api/search/`. Every one is
listed here.

| Endpoint | Handler file:line | Through MCP? | What it does / how it dispatches |
| --- | --- | --- | --- |
| `POST /api/search/ai` | `src/app/api/search/ai/route.ts:19` | **Yes** (partial) | RAG pipeline. Step 1: `registry.execute('query_case_knowledge', …)` at line 96. Step 1b: `registry.execute('scan_for_pattern', …)` at line 143. Then loads workflow context via `prisma.workflow.findMany` at line 220 (bypasses `search_workflows` MCP tool — see §4) and streams the LLM via `streamAI` / `streamRlm`. |
| `POST /api/search/deep` | `src/app/api/search/deep/route.ts:16` | **Yes** | Calls `deepSearch(query, registry, opts)` at line 92. The registry is the dispatcher for sub-queries; `deep-search.ts:277` and `:387` issue `query_case_knowledge` / `scan_for_pattern`, and the RLM round-loop at `:1059` re-enters the registry. Like `/ai`, it also reads `prisma.workflow.findMany` at line 80 for workflow context (partial; see §4). |
| `POST /api/search/unified` | `src/app/api/search/unified/route.ts:33` | **Yes** | Single retrieval endpoint that supersedes `/haystack`. Calls `registry.execute('query_case_knowledge', { …, mode: 'boolean' })` at line 60. |
| `GET /api/search/semantic` | `src/app/api/search/semantic/route.ts:4` | **Yes** | Thin wrapper. `registry.execute('query_case_knowledge', …)` at line 19. |
| `GET /api/search/pattern` | `src/app/api/search/pattern/route.ts:4` | **Yes** | Thin wrapper. `registry.execute('scan_for_pattern', …)` at line 18. |
| `POST /api/search/haystack` | `src/app/api/search/haystack/route.ts:21` | **Yes** (indirectly) | Deprecated forwarder. Builds a `query` from legacy `{filter, freetext}` and `fetch()`s `/api/search/unified` (line 45), which itself goes through MCP. Marked for removal one release after the chip composer ships. |
| `POST /api/search/interpret` | `src/app/api/search/interpret/route.ts:84` | **No** (correct) | Freetext → chip-set interpreter. Loads `personIndex` / `caseIndex` from `@/lib/legal/repo` (lines 43–58), then calls `interpretQuery(text, ctx)` (line 98) — a pure local parser. No MCP tool covers this. |
| `GET /api/search/refs/[id]` | `src/app/api/search/refs/[id]/route.ts:23` | **No** (correct) | Resolves a `@uuid` ref to a human label for chip rendering. Probes `prisma.case.findUnique`, `prisma.person.findUnique`, `prisma.document.findUnique`, `prisma.filing.findUnique` in order (lines 37, 48, 58, 68). Label-lookup; no retrieval semantics. |
| `GET /api/search/path-values` | `src/app/api/search/path-values/route.ts:67` | **No** (correct) | Picker for 2-hop path attributes (e.g. `reporterRef->displayName`). Allowlisted Prisma reads on `case` / `person` (lines 113, 137). Autocomplete-only. |
| `POST /api/search/axon-generate` | `src/app/api/search/axon-generate/route.ts:29` | **No** (correct) | English → Axon filter via Local AI (`completeAI({provider: 'ollama', …})` at line 83, retry at line 117). Validates output with `parseBooleanQuery`. No retrieval, no MCP tool fits. |
| `GET, POST /api/search/chat-attachments` | `src/app/api/search/chat-attachments/route.ts:14, 40` | **No** (ingestion) | List / upload chat-attached PDFs/images. POST writes to disk (line 75), creates a Prisma row (line 77), then fires `ingestChatAttachment` / `ingestChatImage`. Ingestion side. |
| `DELETE /api/search/chat-attachments/[id]` | `src/app/api/search/chat-attachments/[id]/route.ts:8` | **No** (ingestion) | `getChatVectorStore(chatId).deleteByDocument(id)` at line 20 + Prisma delete at line 35. |
| `GET /api/search/chat-attachments/[id]/file` | `src/app/api/search/chat-attachments/[id]/file/route.ts` | **No** (ingestion) | Streams the stored attachment bytes back. Pure file serving. |
| `POST /api/search/chat-attachments/[id]/reindex` | `src/app/api/search/chat-attachments/[id]/reindex/route.ts:15` | **No** (ingestion) | Re-runs `ingestChatAttachment` against the existing row; `getChatVectorStore` write (line 28) + Prisma update (line 37). |

> Client wiring sanity check (for the audit, not in the route count):
> `search-interface.tsx` fetches `/api/search/haystack` (line 527) and
> `/api/search/chat-attachments` (line 691) directly. The rest of the
> endpoints are reached via sibling files in the same screen:
> `search-interface.tsx:982` chooses `/api/search/semantic` vs
> `/api/search/pattern` (Direct mode); `src/lib/search/ai-search-runner.ts:150`
> hits `/api/search/ai`; `src/lib/search/deep-search-runner.ts:148` hits
> `/api/search/deep`; `src/components/search/active-token-suggestions.tsx:295`
> hits `/api/search/path-values`; `src/components/search/sample-query-panel.tsx:178`
> hits `/api/search/axon-generate`; `src/components/chat-attachments.tsx`
> hits the chat-attachment lifecycle endpoints.

---

## 3. Re-embedding / re-indexing paths

These do **not** go through MCP, and that's the intended boundary.

- `src/app/api/search/chat-attachments/route.ts:90` — POST fires
  `ingestChatAttachment` / `ingestChatImage` (in `src/lib/chat/`), which
  embed pages and write to `getChatVectorStore(chatId)`.
- `src/app/api/search/chat-attachments/[id]/reindex/route.ts:15` — re-runs
  the same ingestion path against the stored file.
- The case-side ingestion pipeline (`src/lib/ingestion/*`,
  `src/services/file-watcher.ts`, `src/services/job-queue.ts`) is the
  primary indexer. It writes to `VectorStore` directly.

This is by design. MCP tools in this codebase are exclusively query-side
(`query_case_knowledge`, `scan_for_pattern`, `retrieve_exhibit`, plus the
analysis tools enumerated in §5). There is no `index_document` MCP tool
and adding one would invert the dependency direction — the ingestion
pipeline owns the writer and would have to call back through itself.

---

## 4. Issues / recommendations

**Workflow-context loading bypasses `search_workflows`.**

`POST /api/search/ai` (`src/app/api/search/ai/route.ts:220`) and
`POST /api/search/deep` (`src/app/api/search/deep/route.ts:80`) both load
workflow content with:

```
prisma.workflow.findMany({ where: { id: { in: allWorkflowIds } }, select: { title: true, content: true } })
```

Meanwhile a `search_workflows` MCP tool is registered
(`src/lib/mcp/tools/search-workflows.ts:40`) and is currently called by
**zero** other code paths in `src/` (see §5). Whether it's the right
replacement depends on whether `search_workflows` supports
"fetch-by-id-list" — if it does, these two routes should switch over so
that admin can disable workflow injection per env and the calls show up
in execution logs. If it only supports search-by-query semantics, this is
a real gap: there is no MCP-side primitive for "load workflows by id," and
adding either a `get_workflow` tool or an `ids: string[]` input to
`search_workflows` would close it.

Marking these two endpoints **partial** in the table above.

**Everything else looks clean.** No retrieval-shaped logic is re-implemented
inline outside the registry. The bypasses for `interpret`, `refs`,
`path-values`, `axon-generate`, and the chat-attachments lifecycle are all
either metadata/autocomplete or ingestion — neither has a corresponding
MCP tool, and forcing one would be the wrong layering.

---

## 5. MCP tools and their callers

Authoritative tool list from `src/lib/mcp/tools/index.ts:17` (`getAllTools`).
Each `name:` field was verified inline in the tool's source file.

Callers below are restricted to `registry.execute('<name>', …)` invocations
across `src/` (grep on `registry.execute(`). MCP-server protocol entry
points that *dispatch by tool name* (`src/lib/mcp/mcp-server.ts:205` and
`src/app/api/mcp/execute/route.ts:43`) are dynamic — they forward whatever
the MCP client requests — so they're listed once at the end rather than
under each tool.

| Tool | Defined at | Callers in `src/` |
| --- | --- | --- |
| `query_case_knowledge` | `src/lib/mcp/tools/query-case-knowledge.ts:50` | `src/app/api/search/ai/route.ts:96`; `src/app/api/search/semantic/route.ts:19`; `src/app/api/search/unified/route.ts:60`; `src/app/draft/chat/route.ts:268` and `:338` (via `src/app/api/draft/chat/route.ts`); `src/lib/search/deep-search.ts:277` and `:1059` |
| `scan_for_pattern` | `src/lib/mcp/tools/scan-for-pattern.ts:56` | `src/app/api/search/ai/route.ts:143`; `src/app/api/search/pattern/route.ts:18`; `src/lib/search/deep-search.ts:387` |
| `retrieve_exhibit` | `src/lib/mcp/tools/retrieve-exhibit.ts:30` | None in `src/` outside the dynamic dispatchers below. Only reachable via the external MCP protocol surface. |
| `detect_contradictions` | `src/lib/mcp/tools/detect-contradictions.ts:34` | None in `src/`. |
| `track_claim_evolution` | `src/lib/mcp/tools/track-claim-evolution.ts:31` | None in `src/`. |
| `extract_argument_structure` | `src/lib/mcp/tools/extract-argument-structure.ts:31` | None in `src/`. |
| `compare_argument_structures` | `src/lib/mcp/tools/compare-argument-structures.ts:34` | None in `src/`. |
| `reconstruct_timeline` | `src/lib/mcp/tools/reconstruct-timeline.ts:33` | None in `src/`. |
| `extract_obligations` | `src/lib/mcp/tools/extract-obligations.ts:33` | None in `src/`. |
| `extract_entities` | `src/lib/mcp/tools/extract-entities.ts:34` | None in `src/`. |
| `analyze_citations` | `src/lib/mcp/tools/analyze-citations.ts:32` | None in `src/`. |
| `detect_privilege` | `src/lib/mcp/tools/detect-privilege.ts:34` | None in `src/`. |
| `analyze_tone` | `src/lib/mcp/tools/analyze-tone.ts:35` | None in `src/`. |
| `search_workflows` | `src/lib/mcp/tools/search-workflows.ts:40` | None in `src/`. (See §4 — `/api/search/ai` and `/api/search/deep` reach Prisma directly instead.) |

Dynamic dispatchers (forward by name; not counted as direct callers above):

- `src/lib/mcp/mcp-server.ts:205` — `this.registry.execute(tool, params || {})` — the HTTP MCP server (port 3001) used by external MCP clients.
- `src/app/api/mcp/execute/route.ts:43` — `registry.execute(tool, params || {}, contextOverride)` — Next-side admin/debug execute endpoint.

The 11 analysis tools (`detect_contradictions` through `search_workflows`)
have no in-codebase callers today. They're reachable only through the MCP
protocol — i.e. external agents or admin REPL. That's fine if intentional
(they're meant to be agent-facing), but worth flagging since it means
they're effectively dormant from the UI's perspective. `search_workflows`
specifically is the one that could and should be plumbed into `/api/search/ai`
and `/api/search/deep` workflow-context loading (§4).

---

## Suggested commit message

```
docs: audit MCP registry usage across /search server paths

All retrieval (/ai, /deep, /semantic, /pattern, /unified, deprecated
/haystack) dispatches through getToolRegistry().execute. Metadata
endpoints (/interpret, /refs, /path-values, /axon-generate) and the
chat-attachment ingestion lifecycle correctly bypass MCP — none have a
corresponding tool. One partial: /ai and /deep load workflow context
via prisma.workflow.findMany directly while a search_workflows MCP tool
sits unused — should be migrated. Includes the full tool→caller map.
```
