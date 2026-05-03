# Connect Claude / Cursor / VSCode to this MCP Server

Sound Suite exposes its tools (case search, exhibit retrieval, contradiction detection, …) as a **Model Context Protocol** server at:

```
{{MCP_HTTP_URL}}
```

Auth mode: **{{MCP_AUTH_MODE}}**

There are two ways to connect:

1. **HTTP / SSE transport** — for clients that natively support remote MCP servers (Cursor, modern Claude Desktop, ChatGPT desktop).
2. **stdio bridge** — for clients that only speak stdio (older Claude Desktop, custom scripts). Use the `mcp-remote` proxy.

---

## Option 1 — Cursor

Cursor supports remote MCP servers natively. Open your project's `.cursor/mcp.json` (or the global one at `~/.cursor/mcp.json`) and add:

```json
{
  "mcpServers": {
    "sound-suite": {
      "url": "{{MCP_RPC_URL}}",
      "transport": "sse"
    }
  }
}
```

Restart Cursor. The Sound Suite tools (`query_case_knowledge`, `retrieve_exhibit`, `scan_for_pattern`, …) appear in the Tools panel.

---

## Option 2 — Claude Desktop (HTTP, modern)

If you have Claude Desktop ≥ 1.x with remote MCP support, open the config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "sound-suite": {
      "url": "{{MCP_RPC_URL}}"
    }
  }
}
```

Restart Claude Desktop. New tools appear under the 🔧 menu.

---

## Option 3 — Claude Desktop (stdio bridge, legacy)

For older Claude Desktop builds that only support stdio, use **`mcp-remote`** to bridge stdio ↔ HTTP:

### macOS / Linux

```json
{
  "mcpServers": {
    "sound-suite": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "{{MCP_RPC_URL}}"
      ]
    }
  }
}
```

### Windows (PowerShell)

```json
{
  "mcpServers": {
    "sound-suite": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "mcp-remote@latest",
        "{{MCP_RPC_URL}}"
      ]
    }
  }
}
```

If `npx` isn't on your PATH, install Node.js first (`brew install node` on macOS, [nodejs.org](https://nodejs.org/) on Windows).

---

## Option 4 — VSCode (Continue extension)

Continue's MCP support uses HTTP. Edit `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "sound-suite",
      "url": "{{MCP_RPC_URL}}"
    }
  ]
}
```

---

## Verify

In your client, ask the model:

> List the MCP tools you have access to from sound-suite.

You should see at least: `query_case_knowledge`, `retrieve_exhibit`, `scan_for_pattern`, `analyze_citations`, `extract_entities`, `reconstruct_timeline`, `detect_contradictions`.

You can also probe the endpoint directly:

```bash
curl -s {{MCP_HTTP_URL}}/tools | jq '.tools[].name'
```

---

## Authentication

Current mode: **{{MCP_AUTH_MODE}}**.

- **`none`** — anyone who can reach `{{MASTER_URL}}` can call the tools. Fine for a private LAN setup. Not safe over the public internet.
- **`apikey`** — set `MCP_API_KEY=<your-key>` on the master and pass `Authorization: Bearer <key>` from the client (clients that don't support custom headers will need a small proxy).
- **`oauth`** — full OAuth 2.0 flow (Claude Desktop and Cursor handle this automatically when the server advertises it).

Change the auth mode in **Admin → MCP** (or set `MCP_AUTH_MODE` env var on master and restart).

---

## Troubleshooting

**"Connection refused" / "404 not found"** — make sure `{{MASTER_URL}}` is reachable from the machine running the MCP client. Try `curl {{MASTER_URL}}/api/health` first.

**"Tools list empty"** — the server is up but no tools are registered. Check **Admin → System Health** for tool registry warnings.

**Cursor/Claude not picking up changes** — fully quit the app (not just close window) and relaunch. MCP server connections are established on startup.
