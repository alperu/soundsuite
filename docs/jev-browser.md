# Jev Browser: autonomous UI interaction for coding agents

How `jev-browser` is wired up for Sound Suite, what it is good for, and how the
dashboard lets it start signed in. Verified 2026-09-20 against the local
dashboard on `:3000`.

## What it is

[`@jkudish/jev-browser`](https://github.com/jkudish/jev-browser) drives a real
headless Chromium from a natural-language task. Each step it asks TypeSafe's
**Jev** model (a System One model: typed judgments, no text generation) three
questions over the current page: which element to act on (a Choice over the
page's clickable, typeable and selectable elements plus scroll/back/done),
whether the goal is met, and whether the run is stuck. Code owns the loop:
step and time budgets, stop gates, recovery when an action has no effect.

You get back the final page (text, markdown, html or an aria snapshot), a
per-step trace with confidences and the goal/stuck probabilities, console and
network errors captured along the way, token usage with estimated cost, and
optionally a screenshot.

It exposes three surfaces: an MCP server (used by Claude Code here), a CLI, and
a library export `navigate()`.

Typing is the one place a second model is involved: Jev never generates text,
so a search query or a form value comes from a small LLM you configure (or
falls back to a weak keyword heuristic).

## Install (per developer machine)

Requirements: Node.js 20 or newer, a TypeSafe API key from
`https://console.typesafe.ai/settings/keys`, optionally a key for the typing
model. On this machine the server is already registered at user scope and
`TYPESAFE_API_KEY` is exported from `~/.zshrc`.

1. Put the key where non-interactive shells see it (Claude Code spawns MCP
   servers without a login shell), for example in `~/.zshenv` or `~/.zshrc`:

   ```bash
   export TYPESAFE_API_KEY="ts_..."
   ```

2. Fetch the package once (this also downloads Playwright's Chromium):

   ```bash
   npx -y @jkudish/jev-browser --help
   ```

3. Register the MCP server. User scope makes it available in every project:

   ```bash
   claude mcp add -s user jev-browser -- npx -y @jkudish/jev-browser
   ```

   Some MCP clients filter the environment before spawning servers. If the
   server reports a missing key, pass it explicitly:

   ```bash
   claude mcp add -s user jev-browser -e TYPESAFE_API_KEY=ts_... -- npx -y @jkudish/jev-browser
   ```

4. Restart Claude Code. The tool appears as `mcp__jev-browser__jev_navigate`.

5. Give the typing model a key, or typed text will be poor. Auto-detected in
   this order: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
   `GEMINI_API_KEY`. A local model works too:

   ```bash
   export JEV_BROWSER_TYPE_BASE_URL=http://localhost:11434/v1
   export JEV_BROWSER_TYPE_MODEL=qwen2.5:7b
   ```

   Without any of these the trace shows `via keyword-heuristic` on typed
   steps; navigation-only tasks are unaffected.

Note for Claude Code's auto permission mode: its classifier refuses to run an
unfamiliar npm package or to register an MCP server on the agent's behalf.
Steps 2 and 3 are run by the developer, typed with the `!` prefix in the
session or in a terminal.

## Using it

Tool parameters: `task` and `start_url` (required), `format`
(`text` 8k chars, `markdown` 16k, `html` 1 MB, `aria` 16k), `max_chars`,
`max_steps` (default 24), `max_seconds` (default 180), `allow_typing`
(default true), `screenshot` (`final` or `none`).

Write the task as a goal with a recognisable end state, and name the page
elements the way the UI labels them. Good: "Open the Admin sidebar entry
Role Assignment and stop when the per-role machine table is visible."
The stop gates fire on the agent choosing `done`, goal probability above 0.85,
stuck probability above 0.85, or a budget.

Read the trace, not just the status. `done` and `goal_achieved` are two
independent judgments; agreement between them is what a trustworthy finish
looks like. A `stuck` status with repeated `no visible change` outcomes means
the page did not offer what the task needed (the login screen case below).

CLI equivalent, for scripts and CI:

```bash
npx -y @jkudish/jev-browser run "Open the Cases page and stop on it" http://localhost:3000/ \
  --format text --max-steps 12 --screenshot /tmp/cases.jpg
```

## Limits that matter

- **Password and file inputs are never offered** to the model, and the agent
  cannot set cookies or `localStorage`. The admin area (`/admin/*`) sits behind
  a login form, so it stops the agent cold. See the next section.
- Up to 240 interactive elements per step; denser pages are truncated and the
  state says so.
- No iframes, shadow DOM, hover-revealed menus, or keyboard-only actions.
- Next.js link prefetches show up as `request_failed HEAD ... net::ERR_ABORTED`
  in `console_events`. They are benign; do not treat them as page errors.
- Jev is calibrated, not infallible: the trace is evidence, not proof. Use
  `chrome-devtools` or `playwright` MCP when exact clicks, DevTools access, or
  the developer's signed-in Chrome are needed.

## Signing in to `/admin` with a login form

The admin dashboard authenticates with `POST /api/admin/auth/login`, which
sets an httpOnly session cookie (`src/lib/admin/auth.ts`). A browser agent can
neither type into the password field nor set that cookie. Two gates let it
start signed in without weakening the app for anyone else:

1. **Server marker file.** `src/lib/dev-mode.ts` reports `isDevMode()` as
   true only while the file `config/dev-mode` exists on that host. The file is
   gitignored, so a fresh checkout, a sidecar tarball or a public snapshot
   never has it. `/api/health` exposes the flag as `devMode`.

2. **Client fragment.** `src/components/admin/login-form.tsx` reads a URL
   fragment `#auth=<base64 of user:pass>` on load, strips it from the URL
   immediately, and honours it only when the page host is `localhost` or
   `127.0.0.1` **and** `/api/health` returns `devMode: true`. It then submits
   the same `POST /api/admin/auth/login` the form would, so password
   verification and session creation are unchanged. Fragments are never sent
   to the server.

Usage:

```
http://localhost:3000/admin/login#auth=<base64 of user:pass>
```

```bash
printf '%s:%s' "$USER_NAME" "$PASS" | base64   # produce the fragment value
touch config/dev-mode                          # enable on this machine; rm it to disable
```

Tests: `src/lib/__tests__/dev-mode.test.ts`,
`src/components/admin/__tests__/login-form.test.tsx` (local host, devMode on
and off, bad credentials) and `login-form.remote-host.test.tsx` (non-local
host never probes or signs in).

Everything outside `/admin` (cases, search, ingest, case management) has no
login and needs none of this.

## Pairing with the rest of the toolset

- `jev-browser`: autonomous "get to X and read Y" tasks, smoke checks of a
  flow, cheap exploratory navigation, returning a page as markdown.
- `chrome-devtools` / `playwright` MCP on the developer's Chrome (`:9222`,
  `./scripts/chromeMcpRun.sh`): precise interactions, console and network
  inspection, pages behind real sessions.
- [`@jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp): the same Jev
  judgments without a browser (verify a claim against evidence, rerank,
  classify, extract fields), when the input is text you already have.
