# public/mcp-client

Browser-pane client used by Cowork / Claude sessions to query the Sound Suite
MCP surface. Paired with the `soundsuite-mcp` skill.

Lives under `public/` so Next.js serves it — the pane loads it in one line
instead of pasting 11 KB of JavaScript into the model's context every session.
**This is the single source of truth. Edit here.**

Served at: `http://localhost:3000/mcp-client/soundsuite-client.js`

## Why a browser client and not a Python script

Sound Suite listens on this Mac's loopback. A cloud session can execute code in
three places, and only one of them can reach it:

| Where | Reaches `localhost:3000`? |
|---|---|
| Cloud container (`Bash`) | no — different machine |
| `device_bash` | no — isolated Linux VM; its localhost is not this Mac's |
| Desktop app browser pane | **yes** — runs on this Mac |

So the client is JavaScript executed in the pane. A Python wrapper placed
anywhere the session can write would have no route to port 3000.

## Loading it

Point the browser pane at `http://localhost:3000/api/health`, then:

```js
await fetch('/mcp-client/soundsuite-client.js').then(r => r.text()).then(eval);
// -> "soundsuite-client 1.0.0 ready at http://localhost:3000"
```

`ss` and `window.__ss` are then available.

This served copy only works at the `:3000` origin — a page at `:9191` cannot
fetch across to `:3000` (CORS). To drive the proxy / JSON-RPC surface, read this
file and inject its text inline, then use `ss.mcp('sound-suite-local')`.

## Quick reference

```js
await ss.tools('local')                       // catalogue + notReady
await ss.scan('CAUSE NO\\.', { limit: 5 })    // exact regex, ~1s, no LLM
await ss.ask('question', { limit: 5 })        // passages + citations, ~6s
await ss.research('question', { mode: 'fast', maxEvidence: 15 })
ss.cites(5)                                   // cite-ready lines from ss.last
ss.item(0)                                    // one full item from ss.last

// slow work (deep tiers run ~2 min; the JS tool aborts at 45s)
ss.fire('r1', 'research_evidence', { query: '…', mode: 'deep' })
ss.peek('r1')
```

`ss.last` holds the full payload of the most recent call — helpers return
summaries so a result never exceeds the tool's ~60 KB output cap.

## The skill

The `soundsuite-mcp` skill that drives this client lives at **`skills/soundsuite-mcp/SKILL.md`**
in the repo root — deliberately *outside* `public/`, since anything under `public/` is web-served
and the skill documents which routes lack auth.

Install it into a Claude Code / Cowork session:

```bash
mkdir -p ~/.claude/skills
cp -r skills/soundsuite-mcp ~/.claude/skills/
```

Keep it in step with the live skill — if it is edited in the app, re-copy its `SKILL.md` here; if
this copy is edited, re-propose it in a session so the saved skill matches. **Do not trust a
"byte-identical as of this commit" note** (one used to live here): such a claim keeps reading as true
after it stops being so. Compare them: `sha256sum skills/soundsuite-mcp/SKILL.md
~/.claude/skills/soundsuite-mcp/SKILL.md`.

## Privacy

Evidence text is real case material. Quote it in conversation; never write it to
a file, report, or commit message.

`/api/config` no longer returns key values — it returns `apiKeys: { <provider>:
{ configured, last4 } }` and refuses `?key=<row>` with 403. (It did leak plaintext
keys; that was fixed 2026-09-07.) There is still no reason to fetch it; the one
useful read is `?resolve=localModels`.

## History

Earlier copies at `claudeDesktopClient/` and `public/soundsuite-client.js` have
been removed. This folder is the only home.
