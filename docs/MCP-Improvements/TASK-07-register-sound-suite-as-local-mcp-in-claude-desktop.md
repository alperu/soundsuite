# Task 07 — Register Sound Suite as a Local MCP server in the Claude desktop app

**Goal:** make the Sound Suite tools available to **Cowork cloud sessions** (like the one that wrote this) without a tunnel, a public domain, or OAuth.
**Owner:** operator (this is an app setting; an agent cannot do it).
**Time:** ~5 minutes. **Depends on:** nothing — the bridge already exists.

---

## Why this works

The Claude desktop app has a **Local MCP servers** setting ("Add and manage MCP servers that you're working on"). Servers registered there run on the Mac and are **proxied to linked cloud sessions through the device bridge**, appearing as tools named `mcp__remote-devices__<server>__<tool>`. That is the same bridge this session uses to read your folders and run the browser pane.

So the chain becomes:

```
Cowork session (cloud) ── device bridge ── Claude desktop app ── bridge.mjs (stdio) ── Sound Suite :3000
```

Nothing leaves the machine except the tool call and its result, carried over the link the app already maintains. No `:9191`, no Cloudflare, no `.well-known`, no auth code — the desktop app's login *is* the auth. This is the path the 2026-08-29 architecture report could not offer because the setting was not considered.

**Caveat, stated plainly:** "proxied through the bridge" is what the tool documentation says; whether stdio servers registered in that panel are exposed to cloud sessions on your app version has to be confirmed by doing it. Step 4 is the test.

---

## Steps

### 1. Confirm the bridge runs cleanly on its own

```bash
cd ~/Code/court-lens-mcp/scripts/mcp-bridge     # or wherever the synced copy lives
SOUND_SUITE_PROFILE=local node bridge.mjs < /dev/null; echo "exit $?"
```

You should see `[sound-suite] loaded 20 tools` on stderr and a clean exit when stdin closes. If it prints anything to **stdout**, stop — that breaks the JSON-RPC stream and the registration will fail silently.

### 2. Register two servers in the desktop app

Claude desktop → Settings → **Local MCP servers** → Add. Enter these (adjust the `node` path to `command -v node`):

| Field | `sound-suite-local` | `sound-suite-routed` |
|---|---|---|
| Name | `sound-suite-local` | `sound-suite-routed` |
| Command | `/opt/homebrew/bin/node` | `/opt/homebrew/bin/node` |
| Args | `/Users/alper/Code/court-lens-mcp/scripts/mcp-bridge/bridge.mjs` | same |
| Env | `SOUND_SUITE_URL=http://127.0.0.1:3000`<br>`SOUND_SUITE_PROFILE=local` | `SOUND_SUITE_URL=http://127.0.0.1:3000`<br>`SOUND_SUITE_PROFILE=routed` |

If the panel takes JSON instead of fields:

```json
{
  "mcpServers": {
    "sound-suite-local": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/alper/Code/court-lens-mcp/scripts/mcp-bridge/bridge.mjs"],
      "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "local" }
    },
    "sound-suite-routed": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/alper/Code/court-lens-mcp/scripts/mcp-bridge/bridge.mjs"],
      "env": { "SOUND_SUITE_URL": "http://127.0.0.1:3000", "SOUND_SUITE_PROFILE": "routed" }
    }
  }
}
```

Register **`local` only** if you want a hard guarantee that no Cowork conversation can trigger a cloud call. Add `routed` later once you have a default provider set (see Report v3, item M-4).

### 3. Restart the desktop app

Local MCP servers are spawned at app start.

### 4. Test from a Cowork session

Open (or return to) a cloud session linked to this Mac and ask:

> List the tools you have from `sound-suite-local`.

Expected: 20 tools, `research_evidence` among them, named `mcp__remote-devices__sound-suite-local__*`. Then:

> Use `scan_for_pattern` with pattern `CAUSE NO\.` and limit 3.

Expected: three hits in ~2 s. That proves the full chain. If the tools do not appear, the panel does not expose stdio servers to cloud sessions on this version — note it and fall back to the tunnel plan in Report v2 §7.

### 5. Keep the proxy registration for Claude Code / Cursor

This task is additive. Claude Code and Cursor keep using `http://localhost:9191/sound-suite-{local,routed}/mcp` once the proxy is reloaded (Report v3, item M-2).

---

## Acceptance

- [ ] `bridge.mjs` prints nothing to stdout when run standalone
- [ ] Both servers show as connected in the desktop app's Local MCP panel
- [ ] A Cowork session lists ≥ 20 tools from `sound-suite-local`
- [ ] `scan_for_pattern` returns results from a Cowork session
- [ ] With only `local` registered, a Cowork request to use `preset_list` fails with `TOOL_NOT_IN_PROFILE` (proves the profile boundary holds across the bridge)

## Notes

- The bridge mints a per-process session id; the desktop app will spawn one process per registered server, so `local` and `routed` get distinct sessions and distinct active presets. Correct.
- `research_evidence` in `deep` mode currently hangs on decompose (Report v3, M-1). Until that is fixed, use `mode: "fast"`, `scan_for_pattern`, and `query_case_knowledge` from Cowork.
