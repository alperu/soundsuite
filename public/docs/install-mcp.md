# Connect Claude / Cursor / VSCode to this MCP Server

Sound Suite exposes its tools (case search, exhibit retrieval, contradiction detection, research jobs, cited reports, …) over the **Model Context Protocol**. The server lives at:

```
{{MCP_HTTP_URL}}
```

Auth mode: **{{MCP_AUTH_MODE}}**

Sound Suite is registered as **two MCP servers**, not one. They share the same tool registry but enforce opposite policies about where your case text may go:

| | `sound-suite-local` | `sound-suite-routed` |
|---|---|---|
| What you get back | Evidence — ranked chunks plus an outline, no prose | A finished, cited report plus the evidence behind it |
| Which models run | Sidecar / Ollama on your own hardware only. Cloud providers are refused, fail-closed. | Any provider configured in Sound Suite, chosen per tier by the active preset |
| Does case text leave the machine? | **Never** | **Yes**, to whichever provider the preset selects |
| Presets | Retrieval knobs only | Full routing table, changeable on the fly |
| Providers allowed | `ollama` | `openai`, `anthropic`, `gemini`, `groq`, `grok`, `ollama` |

The policy is fixed at **registration time** by the `SOUND_SUITE_PROFILE` environment variable. No tool argument, prompt, or preset can flip a `local` session to the cloud: the server enforces the profile before any model call and refuses with `POLICY_VIOLATION`. If you only register `sound-suite-local`, nothing in that conversation can spend API credit or send text to a third party.

Register one or both. When both are present, the model sees two tool namespaces and picks by description.

> **Security:** `sound-suite-routed` spends API credit and sends case text to third parties on request. **Never expose it beyond localhost without authentication.** The registrations below bind to `127.0.0.1`.

---

## Prerequisites

1. Node.js 18 or newer (`brew install node` on macOS, [nodejs.org](https://nodejs.org/) on Windows).
2. The stdio bridge installed at `~/sound-suite-bridge/`:

   ```bash
   mkdir -p ~/sound-suite-bridge
   cp scripts/mcp-bridge/bridge.mjs scripts/mcp-bridge/package.json ~/sound-suite-bridge/
   cd ~/sound-suite-bridge && npm install
   ```

   The bridge is a stateless forwarder: it translates stdio MCP into calls to `{{MCP_HTTP_URL}}/tools?profile=…` and `{{MCP_HTTP_URL}}/execute`, and relays job progress as MCP notifications. It has no opinion about models or presets.

Bridge environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SOUND_SUITE_URL` | `http://127.0.0.1:3000` | Sound Suite master base URL |
| `SOUND_SUITE_PROFILE` | `local` | `local` or `routed`. Any other value is treated as `local`. |
| `MCP_API_KEY` | (none) | Sent as `Authorization: Bearer …` when auth mode is `apikey` |

---

## Option 1 — Claude Desktop

Open the config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add both entries under `mcpServers` (use absolute paths; Claude Desktop does not expand `~`):

```json
{
  "mcpServers": {
    "sound-suite-local": {
      "command": "node",
      "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
      "env": {
        "SOUND_SUITE_URL": "{{MASTER_URL}}",
        "SOUND_SUITE_PROFILE": "local"
      }
    },
    "sound-suite-routed": {
      "command": "node",
      "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
      "env": {
        "SOUND_SUITE_URL": "{{MASTER_URL}}",
        "SOUND_SUITE_PROFILE": "routed"
      }
    }
  }
}
```

If `node` is not on the PATH Claude Desktop inherits, put its absolute path in `command` (`which node`). Fully quit and relaunch Claude Desktop; the two servers appear under the 🔧 menu.

---

## Option 2 — Claude Code / Cursor via mcp-proxy

If you run the local mcp-proxy (a Streamable HTTP front for stdio upstreams) on `localhost:9191`, replace any single `sound-suite` upstream in its `config.json` with these two:

```json
{
  "upstreams": [
    {
      "name": "sound-suite-local",
      "path": "/sound-suite-local/mcp",
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
      "cwd": "/Users/you/sound-suite-bridge",
      "callTimeoutMs": 180000,
      "env": {
        "SOUND_SUITE_URL": "{{MASTER_URL}}",
        "SOUND_SUITE_PROFILE": "local"
      }
    },
    {
      "name": "sound-suite-routed",
      "path": "/sound-suite-routed/mcp",
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
      "cwd": "/Users/you/sound-suite-bridge",
      "callTimeoutMs": 300000,
      "env": {
        "SOUND_SUITE_URL": "{{MASTER_URL}}",
        "SOUND_SUITE_PROFILE": "routed"
      }
    }
  ]
}
```

Then point the client at the proxy:

- **Claude Code**:

  ```bash
  claude mcp add --transport http sound-suite-local  http://localhost:9191/sound-suite-local/mcp
  claude mcp add --transport http sound-suite-routed http://localhost:9191/sound-suite-routed/mcp
  ```

- **Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

  ```json
  {
    "mcpServers": {
      "sound-suite-local":  { "url": "http://localhost:9191/sound-suite-local/mcp" },
      "sound-suite-routed": { "url": "http://localhost:9191/sound-suite-routed/mcp" }
    }
  }
  ```

The proxy forwards `notifications/progress` from the bridge back to the session that started the call, so long research and report jobs show live progress.

---

## Option 3 — Any other stdio client (VSCode extensions, scripts)

Any client that can launch a stdio MCP server works with the same two commands. Example for a generic `mcpServers` array:

```json
[
  { "name": "sound-suite-local",  "command": "node", "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
    "env": { "SOUND_SUITE_URL": "{{MASTER_URL}}", "SOUND_SUITE_PROFILE": "local" } },
  { "name": "sound-suite-routed", "command": "node", "args": ["/Users/you/sound-suite-bridge/bridge.mjs"],
    "env": { "SOUND_SUITE_URL": "{{MASTER_URL}}", "SOUND_SUITE_PROFILE": "routed" } }
]
```

**Native transport.** `{{MCP_HTTP_URL}}/local` and `{{MCP_HTTP_URL}}/routed` are reserved for a native Streamable HTTP transport with the profile fixed by path. They return `404 NOT_AVAILABLE` today. When they land, the registrations above keep their names; only the `command` becomes a `url`.

---

## Which tools each profile exposes

| Tool | `local` | `routed` |
|---|---|---|
| Retrieval: `query_case_knowledge`, `scan_for_pattern`, `query_case_graph`, `retrieve_exhibit`, `search_workflows` | ✓ | ✓ |
| Analysis (ten LLM tools): `analyze_citations`, `analyze_tone`, `compare_argument_structures`, `detect_contradictions`, `detect_privilege`, `extract_argument_structure`, `extract_entities`, `extract_obligations`, `reconstruct_timeline`, `track_claim_evolution` | ✓ pinned to Ollama; hidden while Ollama is down | ✓ |
| `research_evidence` | ✓ | ✓ |
| `research_start`, `research_status`, `research_result`, `research_cancel` | ✓ | ✓ |
| `research_report` | | ✓ |
| `report_start`, `report_status`, `report_result`, `report_cancel` | | ✓ |
| `preset_list`, `preset_get`, `preset_define`, `preset_apply`, `preset_save`, `preset_delete` | | ✓ |
| `routing_explain` | | ✓ |

That is 20 tools under `local` and 32 under `routed` when everything is ready. Tools that are not ready are **omitted from the list** rather than shown disabled: the bridge only publishes tools the server reports as `ready`, re-checks the catalog every 60 seconds, and sends `tools/list_changed` when the set changes. Under `local`, every tool that calls a model (the ten analysis tools plus `research_evidence` / `research_start`) is unready while Ollama is unreachable. The analysis tools are rate-limited to 10 calls per minute.

---

## Tool reference

### Retrieval tools (both profiles)

No model is involved; these read the index directly.

- `query_case_knowledge` — semantic / hybrid / keyword search. `query` (required), `caseId`, `chatId`, `limit` (default 10), `searchMode` (`vector` | `hybrid` | `keyword`, default `hybrid`). Results carry citation fields plus `documentId`, `blockType`, `headingPath`, `speakers` and `tableMarkdown` when available.
- `scan_for_pattern` — regex search. `pattern` (required), `caseId`, `limit` (default 10). Same structure metadata as above.
- `query_case_graph` — structural lookups over the case graph. `operation` (required: `amendment-lineage` | `motions-by-person` | `related-motions`), `motionId`, `personId`, `role` (`judge` | `movant` | `respondent`), `caseScope` (array of case ids), `limit` (default 50).
- `retrieve_exhibit` — find exhibit images by description. `description` (required), `caseId`, `limit` (default 5).
- `search_workflows` — search workflows and templates. `query`, `caseId`, `category`, `tag`, `status`, `limit` (default 20).

### Analysis tools (both profiles)

Each one runs a model over documents in the index. Under `local` the model is always Ollama; under `routed` it is whichever provider the session resolves to. Required parameters in bold.

- `detect_contradictions` — **`caseId`**, `topic`, `confidence_threshold` (0–1, default 0.7), `limit`.
- `track_claim_evolution` — **`caseId`**, **`claim`**, `limit`.
- `extract_argument_structure` — **`documentId`**, `limit`.
- `compare_argument_structures` — **`documentId1`**, **`documentId2`**.
- `reconstruct_timeline` — **`caseId`**, `date_range_start`, `date_range_end` (ISO 8601), `limit`.
- `extract_obligations` — **`documentId`**, `caseId`, `limit`.
- `extract_entities` — **`documentId`**, `caseId`, `entity_types` (array), `limit`.
- `analyze_citations` — **`caseId`**, `documentId`, `limit`.
- `detect_privilege` — **`documentId`**, `caseId`, `confidence_threshold` (default 0.7), `limit`.
- `analyze_tone` — **`documentId`**, `caseId`.

### `research_evidence` (both profiles)

Gathers ranked evidence for a research question: decomposition into sub-queries, hybrid retrieval, keyword backstop, rerank, and a sections-to-evidence outline. It **never writes prose**; the client writes the answer from the evidence. Everything runs on Ollama and the sidecar under both profiles.

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string, **required** | The research question. |
| `caseId` | string | Restrict retrieval to one case. |
| `mode` | `auto` \| `fast` \| `deep` \| `deep-report` \| `deep-rlm` | Retrieval tier. `auto` (default) lets the query router choose. `fast` is one retrieval with no outline. `deep` and `deep-report` add decomposition, rerank and outline. `deep-rlm` adds recursive RLM rounds on the sidecar and **always runs as a job**. |
| `retrieval` | object | `rerankPoolSize` (default 150), `limitPerSubQuery` (default 50), `rlmMaxRounds` (default 2), `maxEvidence`. The only settings the local engine honours. |
| `history` | array of `{ role: "user" \| "assistant", content }` | Prior turns, for follow-up questions. |
| `preset` | string or object | A saved preset name or an inline preset. Only its `retrieval` section is used. |

Result: an `EvidenceResult` with `routing` (requested and chosen mode, reason, confidence, and `ignored[]` listing any provider / model / routing fields that were dropped), `subQueries`, ranked `evidence[]` items (each with `documentId`, `text`, `score`, `rerankScore`, `hits`, `source`, structure metadata), an `outline` of sections mapped to evidence ids with `gaps`, optional `rlm` stats, timing `stats`, `modelsUsed`, and `localOnly: true`. A `deep-rlm` request returns `{ promoted: true, jobId, hint }` instead; poll `research_status`.

### `research_start` / `research_status` / `research_result` / `research_cancel` (both profiles)

The asynchronous form of `research_evidence`, same parameters and same evidence-only contract.

- `research_start` — same parameters as `research_evidence`. Returns `{ jobId, kind: "research", status, startedAt }` immediately.
- `research_status` — `jobId` (required), `cursor` (integer, default 0). Returns the job view: `status` (`queued` | `running` | `done` | `error` | `cancelled`), `phase`, `evidence[]` added since `cursor`, `newEvidenceCount`, the new `cursor`, `outline` once ready, `rlmNotes[]`, `error`, `startedAt`, `updatedAt`, `elapsedMs`.
- `research_result` — `jobId` (required). Returns the complete `EvidenceResult`. Errors with `JOB_RUNNING` while the job is in progress, `JOB_CANCELLED` or `JOB_FAILED` afterwards.
- `research_cancel` — `jobId` (required). Returns `{ jobId, cancelled, status }`. `cancelled: false` means the job had already finished. Evidence already delivered stays readable through `research_status`.

Any of these answer `JOB_NOT_FOUND` once a job has been gone for 30 minutes.

### `research_report` (`routed` only)

The full pipeline with synthesis: route the question to a tier, gather evidence exactly as `research_evidence` does, then write a cited report with the provider and model the active preset maps to that tier.

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string, **required** | The research question. |
| `caseId` | string | Restrict retrieval to one case. |
| `mode` | `auto` \| `fast` \| `deep` \| `deep-report` \| `deep-rlm` | Research tier; `auto` (default) lets the router decide. |
| `preset` | string or object | Saved preset id or name, a `tmp_` handle from `preset_define`, or an inline PresetV2 object used for this call only. |
| `overrides` | object | Per-call tier settings, highest precedence: `provider`, `model`, `effort` (`low` \| `medium` \| `high` \| `xhigh` \| `max`), `thinking`, `maxTokens`, `multiPass`, `useRlm`, `rlmMaxRounds`. |
| `history` | array | Prior turns. |
| `includeEvidence` | boolean | Include the evidence items behind the report (default true). |
| `includeThoughts` | boolean | Stream model and RLM narration as thoughts (default false). |

Result: a `ReportResult`, which is an `EvidenceResult` plus `report` (the cited text), `routing.resolved` (the tier settings actually used) and `routing.presetUsed`, `cost` (`provider`, `model`, `inputTokens`, `outputTokens`, `estimated`), `provenance` (`documentIdsSent`, `provider`) and `modelsUsed` including `synthesis`. Every routed call also writes an `ActionLog` row of type `mcp-routed` recording tier, provider, model, effort, tokens, duration and the document ids whose text left the machine.

When the router expects the run to take longer than 45 seconds it self-promotes and returns `{ promoted: true, jobId, hint }`; continue with `report_status` and `report_result`.

### `report_start` / `report_status` / `report_result` / `report_cancel` (`routed` only)

- `report_start` — same parameters as `research_report`. Starts the job and returns its initial status view (`id`, `kind: "report"`, `status`, …).
- `report_status` — `jobId` (required), `cursor` (number, default 0). Same view as `research_status` plus `partialReport` (the synthesis text accumulated so far) and `cost` once known.
- `report_result` — `jobId` (required). Returns `{ ready: true, ...ReportResult }` when finished, or `{ ready: false, jobId, status, error?, partialReport? }` while running or after a failure.
- `report_cancel` — `jobId` (required). Returns `{ jobId, cancelled, status }`.

### `preset_list` / `preset_get` / `preset_define` / `preset_apply` / `preset_save` / `preset_delete` (`routed` only)

- `preset_list` — no parameters. Returns saved presets (`id`, `name`, one-line routing summary) and the preset active for this session, if any.
- `preset_get` — `idOrName` (required). Returns `{ id, storedVersion, preset }` where `preset` is a full PresetV2. Dashboard presets saved as version 1 are upgraded on read. A `tmp_` handle is also accepted.
- `preset_define` — `preset` (required, a PresetV2 object). Validates the shape and checks that every provider it names is configured (API key or Ollama host). Returns `{ handle: "tmp_…", warnings[], preset, expiresInSeconds: 3600 }`. The handle lives one hour and is never persisted. Errors with `INVALID_PRESET`.
- `preset_apply` — `idOrName` or `handle` (one required). Makes that preset the active one for the session. Returns `{ applied: { source: "temp" | "saved" | "default", ref, name }, routing, sessionId }`. The active preset expires after one hour idle.
- `preset_save` — `handle` (required), `name`, `id`. Persists a defined preset to the saved presets under `name` (defaults to the preset's own name). Pass `id` to overwrite an existing saved preset.
- `preset_delete` — `id` (required). Deletes a saved preset.

Session scope follows the `mcp-session-id` header. stdio carries no session id, so each bridge process mints its own (`bridge-<profile>-<uuid>`) at startup: one registered client = one session. Restarting the client starts a fresh session with no active preset.

### `routing_explain` (`routed` only)

A dry run that spends nothing. `query` (required), `mode`, `preset`, `overrides` (same shapes as `research_report`). Returns `{ tier, reason, confidence, resolved, presetUsed?, clamps[], costClass, estimatedSeconds, wouldPromoteToJob }`. `costClass` is `gpu-only` | `low` | `medium` | `high`.

---

## Presets and routing

A **PresetV2** is the settings blob stored on a saved search preset. The MCP surface reads two sections of it: `routing` (which provider, model and effort each tier gets — `routed` only) and `retrieval` (pool sizes and RLM rounds — honoured by both profiles). Dashboard-level knobs such as `deep`, `rlm`, `multiPass`, `thinking`, `effort`, `provider`, `model`, `caseId` are kept for parity and unknown scalar keys survive a round trip.

```json
{
  "version": 2,
  "name": "synthetic-example",
  "routing": {
    "fast":        { "provider": "ollama" },
    "deep":        { "provider": "anthropic", "model": "claude-sonnet-5", "effort": "medium", "thinking": true },
    "deep-report": { "provider": "anthropic", "model": "claude-opus-5", "effort": "high", "multiPass": true, "maxTokens": 16000 },
    "deep-rlm":    { "provider": "anthropic", "model": "claude-opus-5", "effort": "high", "useRlm": true, "rlmMaxRounds": 4 }
  },
  "retrieval": {
    "rerankPoolSize": 150,
    "limitPerSubQuery": 50,
    "maxEvidence": 60
  }
}
```

Rules the validator enforces: `version` must be `2`; tier keys are `fast`, `deep`, `deep-report`, `deep-rlm`; each tier names a known `provider`, a `model` from that provider's catalog when given, an `effort` from `low` / `medium` / `high` / `xhigh` / `max`, and positive numbers for `maxTokens` and `rlmMaxRounds`. `retrieval` accepts only `rerankPoolSize`, `limitPerSubQuery`, `rlmMaxRounds` and `maxEvidence` (other keys are dropped with a warning). Version 1 presets saved from the dashboard are upgraded when read: the flat `provider` / `model` / `effort` / `thinking` / `maxTokens` fields become the `deep`, `deep-report` (`multiPass` true unless set) and `deep-rlm` (`useRlm` true) tiers, and they are written back as version 2 on the next save.

**How a `routed` call resolves its tier settings.** The router first picks a tier (`mode`, or the query router under `auto`), then layers settings field by field in this order, highest precedence first:

1. `overrides` on the call
2. `routing[tier]` of an inline preset passed on the call (object or `tmp_` handle or saved name)
3. `routing[tier]` of the session's active preset (`preset_apply`)
4. `routing[tier]` of a saved preset named `default`, if one exists
5. Code defaults: `fast` on Ollama, every other tier on the primary provider and model from Admin → AI Services with `effort: medium`, thinking on when the model supports it, `multiPass` on `deep-report`, `useRlm` with 4 rounds on `deep-rlm`

A layer that changes `provider` without naming a `model` also discards the inherited model. The result is then **clamped** against the model capability registry: an unknown model falls back to the provider's default, `effort` is reduced to what the model supports or dropped, `thinking` is dropped when unsupported, and `maxTokens` is capped. Every clamp is reported in `clamps[]` so nothing is silent. `routing_explain` shows the whole resolution before you spend anything.

Under `local` none of this applies: every tier is pinned to Ollama, routing fields in any preset are ignored and listed in `routing.ignored[]`, and only the `retrieval` section is honoured.

---

## Long-running work: the job flow

MCP has no partial tool result, so anything that takes more than a few seconds runs as a **job**. Jobs live in memory on the master and are kept for 30 minutes after they finish.

**`local` (evidence only):**

1. `research_start { query, caseId?, mode? }` returns `{ jobId, kind: "research", status }`.
2. Loop on `research_status { jobId, cursor }`. Each call returns only the evidence added since `cursor`, the current `phase`, `rlmNotes`, and the outline once ready. Pass the returned `cursor` back next time; it is the running total and only grows.
3. When `status` is `done`, `research_result { jobId }` returns the full `EvidenceResult`. `research_cancel { jobId }` stops early.

**`routed` (report):** identical, with `report_start`, `report_status`, `report_result`, `report_cancel`. `report_status` additionally carries `partialReport`, which grows as the synthesis streams, and `cost`. `report_result` answers `{ ready: false, status }` rather than erroring while the job runs.

The synchronous forms, `research_evidence` and `research_report`, are for short questions. `research_evidence` promotes `deep-rlm` requests to a job; `research_report` promotes any run the router expects to exceed 45 seconds. Both return `{ promoted: true, jobId, hint }` in that case.

Clients that send a `progressToken` in `_meta` with the start call also receive `notifications/progress` (phase text such as "rerank" or "rlm round 2/3") and `notifications/message` (RLM narration, logger `sound-suite`) while the job runs, without polling. The bridge tails the job's event stream to produce them.

**HTTP surface** (what the bridge uses; also callable directly, `kind` is `research` or `report`):

| Method and path | Purpose |
|---|---|
| `POST {{MCP_HTTP_URL}}/{kind}` | Start a job. Body: `{ query, profile, ...tool params }`. Returns `202` with the status view. A `report` job with any profile other than `routed` is refused with `403 POLICY_VIOLATION`. |
| `GET {{MCP_HTTP_URL}}/{kind}` | List jobs for this `mcp-session-id`; `?all=1` lists every job. |
| `GET {{MCP_HTTP_URL}}/{kind}/{id}?cursor=N` | Status view with evidence from index `N`. |
| `DELETE {{MCP_HTTP_URL}}/{kind}/{id}` | Cancel. |
| `GET {{MCP_HTTP_URL}}/{kind}/{id}/result` | Final result. `409 JOB_RUNNING` while running, `410 JOB_CANCELLED` or `JOB_FAILED` afterwards. |
| `GET {{MCP_HTTP_URL}}/{kind}/{id}/events?from=N` | NDJSON event log: replays every event with `seq >= N`, then tails live events. |

Unknown kinds or job ids return `404 NOT_FOUND`.

---

## Verify

In your client, ask the model:

> List the MCP tools you have access to from sound-suite-local and sound-suite-routed.

`sound-suite-local` should show retrieval, analysis and research tools but **no** `report_*`, `preset_*` or `routing_explain` tools. `sound-suite-routed` should show all of them.

You can also probe the server directly:

```bash
curl -s "{{MCP_HTTP_URL}}/tools?profile=local"  | jq '{profile, policy, tools: [.tools[].metadata.name]}'
curl -s "{{MCP_HTTP_URL}}/tools?profile=routed" | jq '{profile, policy, tools: [.tools[].metadata.name]}'
```

Each response is stamped with `profile`, a one-line `policy` statement and `providersAllowed`. Every tool entry carries `ready` and `readyReasons`, so you can see why something is missing from a client's list.

And check the bridge on its own (it logs the profile to stderr and then waits on stdin; press Ctrl-C to exit):

```bash
SOUND_SUITE_PROFILE=routed node ~/sound-suite-bridge/bridge.mjs
```

---

## Authentication

Current mode: **{{MCP_AUTH_MODE}}**.

- **`none`** — anyone who can reach `{{MASTER_URL}}` can call the tools. Fine for a single machine or a private LAN. Not safe over the public internet, and never acceptable for `sound-suite-routed` beyond localhost.
- **`apikey`** — set `MCP_API_KEY=<your-key>` on the master. Add the same `MCP_API_KEY` to each bridge registration's `env` block; the bridge sends it as `Authorization: Bearer <key>`.
- **`oauth`** — full OAuth 2.0 flow on the standalone MCP HTTP server.

Set the mode with the `MCP_AUTH_MODE` environment variable on the master and restart.

---

## Troubleshooting

**"Connection refused" / "404 not found"** — make sure `{{MASTER_URL}}` is reachable from the machine running the bridge. Try `curl {{MASTER_URL}}/api/health` first.

**Bridge starts but the tool list is empty or short** — the server is up but tools are not ready for that profile. Check **Admin → System Health** for tool registry warnings, or read `readyReasons` in `{{MCP_HTTP_URL}}/tools?profile=<profile>`. Under `local`, every model-backed tool (analysis tools, `research_evidence`, `research_start`) disappears while Ollama is unreachable and comes back within a minute of it returning.

**`POLICY_VIOLATION`** — a `local` session asked for a non-Ollama provider, or a report job was started without the `routed` profile. Use the `sound-suite-routed` registration. Under `routed`, `preset_define` / `preset_apply` also fail early when a preset names a provider with no API key configured.

**`TOOL_NOT_IN_PROFILE`** — the tool exists but is not part of this profile (for example `report_start` from `sound-suite-local`). Use the other registration.

**`TOOL_NOT_READY`** — the tool exists but its backing model or index is not available yet. Wait, or check `readyReasons`.

**`RATE_LIMITED`** — the analysis tools allow 10 calls per minute each.

**`JOB_NOT_FOUND` / `JOB_RUNNING`** — jobs are in memory and expire 30 minutes after finishing; a master restart clears them. `JOB_RUNNING` from `research_result` means poll `research_status` a little longer.

**`INVALID_PRESET`** — read the error list: wrong `version`, unknown tier, provider not in `ollama` / `anthropic` / `openai` / `gemini` / `groq` / `grok`, model not in that provider's catalog, or an effort outside `low` … `max`.

**Claude Desktop / Cursor not picking up changes** — fully quit the app (not just the window) and relaunch. MCP server connections are established on startup.

**Wrong profile?** — the bridge prints `profile local` or `profile routed` on stderr at startup. Anything other than the literal `routed` falls back to `local`.
