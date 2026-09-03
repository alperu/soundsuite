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
| `SOUND_SUITE_PROFILE` | `local` | `local` or `routed`. Anything else is treated as `local` (fail-closed). |
| `MCP_API_KEY` | (none) | Sent as `Authorization: Bearer …` when the server runs in `apikey` auth mode |

Run one process per profile. The server name the client sees is `sound-suite-<profile>`.
Registration snippets for Claude Desktop and mcp-proxy are in `public/docs/install-mcp.md`.

## Verify

```bash
node --check scripts/mcp-bridge/bridge.mjs
SOUND_SUITE_PROFILE=routed node ~/sound-suite-bridge/bridge.mjs   # logs the profile to stderr, waits on stdin
```
