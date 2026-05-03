# TODO: Connect SoundSuite to the Claude-in-Word plugin

## Context

The Claude plugin running inside Microsoft Word lets users add **remote MCP connectors** — HTTPS endpoints that speak the official MCP protocol (JSON-RPC 2.0 over Streamable HTTP/SSE, per `modelcontextprotocol.io`). When a user is drafting a brief in Word, Claude can call connector tools to pull facts from outside systems.

SoundSuite already has 14 high-value tools (`query_case_knowledge`, `retrieve_exhibit`, `scan_for_pattern`, `analyze_citations`, `extract_entities`, `reconstruct_timeline`, `detect_contradictions`, etc.) but exposes them via a **custom REST API** (`POST /api/mcp/execute` with `{tool, params}` body), not the MCP wire protocol. The Word plugin will not connect to this as-is.

Goal: add a thin, MCP-spec-compliant HTTPS endpoint on top of the existing `ToolRegistry`, plus the deployment + auth pieces needed for the Word plugin to reach a user's local SoundSuite instance.

## Approach

Three pieces, in order of risk:

### 1. MCP-spec adapter (new code)

Add a single Next.js route `src/app/api/mcp/rpc/route.ts` that handles the MCP JSON-RPC 2.0 surface and delegates to the existing registry:

| MCP method        | Behavior                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `initialize`      | Return `protocolVersion`, `capabilities: { tools: {} }`, `serverInfo`.   |
| `tools/list`      | Map `ToolRegistry.list()` → `{ name, description, inputSchema }[]`.      |
| `tools/call`      | Call `ToolRegistry.execute(name, args)`; wrap result in MCP `content[]`. |
| `notifications/*` | No-op (acknowledge).                                                     |

Streamable HTTP transport requirements:
- Accept `POST` with JSON body (single request) **and** support `text/event-stream` `Accept` header — when set, respond as SSE so server-initiated messages and progress notifications are possible. For phase 1, a single SSE frame containing the JSON-RPC response is enough; full streaming can come later.
- Honor `Mcp-Session-Id` header for session continuity (generate on `initialize`, echo back).
- Return JSON-RPC errors with proper `code`/`message` (re-map existing `TOOL_NOT_FOUND` etc. to MCP standard codes).

Reuse:
- `src/lib/mcp/tool-registry.ts` — already has `list()`, `execute(name, params)`, `isEnabled()`, schemas per tool via `BaseMCPTool`.
- `src/lib/mcp/tools/base-tool.ts` — `inputSchema` is already JSON Schema; pass through unchanged.
- Auth helper from `src/lib/mcp/mcp-server.ts` (`authenticateRequest`) — extract into `src/lib/mcp/auth.ts` so both the legacy REST route and the new RPC route share it.

### 2. Public HTTPS reachability

The Word plugin runs in Anthropic's cloud; SoundSuite runs on the user's machine (`localhost:3000`). The connector URL must be HTTPS and publicly reachable. Two supported paths, picked at config time:

1. **Cloudflare Tunnel (recommended default)** — `cloudflared tunnel --url http://localhost:3000` gives a stable HTTPS URL. Document setup; add a `scripts/tunnel.sh` helper that prints the resulting MCP URL: `https://<tunnel>/api/mcp/rpc`.
2. **Self-hosted domain** — for users who already run SoundSuite behind their own reverse proxy on `soundsuite.<theirdomain>`.

No code change for either; just docs + script. Important: behind a tunnel, `Access-Control-Allow-Origin` and the `Mcp-Session-Id` header must pass through.

### 3. Auth for Word plugin

Word plugin's "Add custom connector" UI accepts a Bearer token. Use the existing `MCP_AUTH_MODE=apikey` path: user generates an API key in the Settings UI, pastes it as the Bearer token in Word.

- Reuse `authenticateRequest()` (after extraction in step 1).
- Add a "MCP Connector" panel under existing Settings → MCP page (file: `src/app/settings/mcp/` — find or create) with: connector URL field (auto-filled from tunnel script output), generate/rotate API key, copy-paste instructions for Word.

### 4. Tool curation (config flag, not code split)

All 14 tools are useful, but the Word-drafting flow most needs: `query_case_knowledge`, `retrieve_exhibit`, `scan_for_pattern`, `analyze_citations`, `extract_entities`, `reconstruct_timeline`, `detect_contradictions`. The `ToolRegistry` already supports per-tool enable/disable via `Config` table — surface this in the same Settings panel so the user picks which tools the Word plugin sees. No tool-code changes.

## Files to modify / create

- **New** `src/app/api/mcp/rpc/route.ts` — JSON-RPC 2.0 endpoint, SSE-capable.
- **New** `src/lib/mcp/jsonrpc.ts` — request parsing, error mapping, SSE framing helper.
- **Refactor** `src/lib/mcp/mcp-server.ts` — extract `authenticateRequest` → `src/lib/mcp/auth.ts`; legacy server keeps importing it.
- **New** `scripts/tunnel.sh` — wrapper around `cloudflared` that prints the connector URL.
- **Modify** Settings MCP page (locate via `src/app/settings/`) — connector URL display, API key rotation, tool picker.
- **Docs** `docs/word-plugin.md` — step-by-step user setup.

## Verification

1. **Spec compliance** — run `npx @modelcontextprotocol/inspector https://<tunnel>/api/mcp/rpc` with the API key; confirm `initialize`, `tools/list`, and a `tools/call` to `query_case_knowledge` round-trip cleanly.
2. **Word plugin end-to-end** — in Word, add the connector with the tunnel URL + API key; in a draft document, ask Claude "what does the Smith case say about negligence?"; confirm a `query_case_knowledge` call shows up in `/api/mcp/execution-history` and that returned snippets land in the Word draft.
3. **Auth negative path** — call `/api/mcp/rpc` without the Bearer token; expect JSON-RPC error with HTTP 401.
4. **Tool gating** — disable `detect_privilege` in the Settings panel; confirm `tools/list` no longer returns it.
5. **Existing REST surface** — verify the dashboard still works (the legacy `/api/mcp/execute` route is untouched).
