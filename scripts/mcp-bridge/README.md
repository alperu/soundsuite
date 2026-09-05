# Sound Suite MCP stdio bridge

`bridge.mjs` is a stateless stdio ↔ HTTP forwarder for clients that only speak stdio MCP
(Claude Desktop, mcp-proxy). It proxies `tools/list` and `tools/call` to the Sound Suite REST
API (`/api/mcp/tools`, `/api/mcp/execute`) and relays research/report job events as MCP
`notifications/progress` and `notifications/message`.

This directory is the **source of truth**. The installed copy that clients actually run lives
at `~/sound-suite-bridge/` (with its own `node_modules`). After editing the repo copy, sync it:

```bash
cp scripts/mcp-bridge/bridge.mjs ~/sound-suite-bridge/
```

First-time install:

```bash
mkdir -p ~/sound-suite-bridge
cp scripts/mcp-bridge/bridge.mjs scripts/mcp-bridge/package.json ~/sound-suite-bridge/
cd ~/sound-suite-bridge && npm install
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SOUND_SUITE_URL` | `http://127.0.0.1:3000` | Sound Suite master base URL |
| `SOUND_SUITE_PROFILE` | (required) | `local` or `routed`. Missing or any other value: the bridge logs the problem to stderr and exits with status 2. |
| `MCP_API_KEY` | (none) | Sent as `Authorization: Bearer …` when the server runs in `apikey` auth mode |

Run one process per profile. The server name the client sees is `sound-suite-<profile>`.
Registration snippets for Claude Desktop and mcp-proxy are in `public/docs/install-mcp.md`.

## Result envelope

A successful `tools/call` returns the server's response two ways:

- `content[0]` — one `text` block holding `JSON.stringify(data, null, 2)`. Unchanged; clients
  that never read structured results see exactly what they always saw.
- `structuredContent` — the same parsed object, verbatim, when the response body is a JSON
  **object**. A JSON array, a bare scalar, or a non-JSON body is forwarded as text only:
  `CallToolResult.structuredContent` is a record in the MCP schema, and inventing a wrapper
  would be the bridge making up a shape it has no business making up.

Errors are unchanged: `{ content: [{ type: "text", text: message }], isError: true }`, with no
`structuredContent`.

The bridge does not declare `outputSchema` on any tool. The spec validates `structuredContent`
against `outputSchema` when one is declared; the schemas are the server's to publish, not the
forwarder's to guess.

The bridge also never trims, caps, or paginates a result. Emitting both blocks roughly doubles
the wire size of a large response — that is deliberate, and any size policy belongs in Sound
Suite, not here.

**Protocol version.** The bridge pins nothing. The SDK's `initialize` handler echoes back the
version the client asked for when it is in `SUPPORTED_PROTOCOL_VERSIONS`, and
`LATEST_PROTOCOL_VERSION` otherwise. `structuredContent` is an optional additive field, so
sessions negotiated at a revision that predates it simply carry it as an ignored extra property
alongside the text block they already understood.

## Verify

```bash
node --check scripts/mcp-bridge/bridge.mjs
SOUND_SUITE_PROFILE=routed node ~/sound-suite-bridge/bridge.mjs   # logs the profile to stderr, waits on stdin
node ~/sound-suite-bridge/bridge.mjs; echo "exit $?"                # no profile → error on stderr, exit 2
```
