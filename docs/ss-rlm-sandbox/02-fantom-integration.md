# Fantom MCP — integrating with `ss-rlm-sandbox`

**Audience:** engineers working on the Fantom MCP master. You do not need the
Sound Suite repo open; everything you must build against is specified here.

Sound Suite's half is **built and verified end to end** (2026-09-16). Fantom's
half is **not started**. This document is that half.

---

## 0. What you get, and what it costs you

**You get:** one call to a sandbox that runs the RLM loop over your codebase —
holding context as a REPL variable, chunking, grepping, recursively sub-querying
— instead of N proxy actions you build, deploy to five hosts, and keep in step.

**It costs you three things**, in dependency order:

| # | item | size | status |
|---|---|---|---|
| 1 | Declare `domain: 'code'` in your config push | ~1 line | **check it landed** (§6) |
| 2 | Expose `search_code` / `search_symbols` / `search_files` over HTTP | medium | **not started — the only real work left** |
| 3 | Send the identity + domain headers when you dial `:8101` | ~5 lines | **done — Fantom already ships these** |

Item 3 is complete on both sides as of sidecar 2.4.14 / image 0.1.2. Item 1 is
one line you may already have. **Item 2 is the remaining work**, and nothing
retrieves until it lands.

---

## 0.1 The headers say who you are AND where the request is headed

**Status: implemented both sides as of sidecar 2.4.14 / image 0.1.2.** Fantom's
three headers are read and acted on.

A request to the sandbox carries two independent facts, and they control
different things:

| | **identity** | **domain** |
|---|---|---|
| answers | **Who** is calling? | **Where** is this headed — which retrieval world? |
| canonical header | `X-SoundSuite-Master` | `X-SoundSuite-Domain` |
| Fantom alias (also accepted) | `X-FantomMCP-Master` | `X-FantomMCP-Domain` |
| value | your canonical master URL | `code` (or `legal`) |
| controls | which key, which model, **whose budget** | which **tools** get injected into the REPL |
| if missing | **409 on every call** | no tools injected — silently |

Mnemonic: **identity is about money, domain is about tools.** Both are
per-request, because one container serves both masters — neither can be a
container-wide setting.

### Why both spellings work

Fantom shipped `X-FantomMCP-*` before this side read either, and sends the
`X-SoundSuite-*` spellings alongside. Both are accepted, at every hop, so
neither master has to redeploy in lockstep with the other. That is why these are
**aliases rather than a rename**. Send both, or either — first present wins.

### The domain header is not the whole story

`domain: 'code'` in the **config push** remains the authoritative declaration
(§1). The header restates it on the unit that actually selects tools: the
container picks its REPL tool set per request, and the container can only see
headers — the stored config lives on the sidecar, which the container never
queries.

So send **both**:

- **config push** → authoritative, survives a caller that forgets the header,
  visible in `/api/status`
- **header** → what the container actually acts on

The sidecar is the one place that sees both, and **warns when they disagree**:

```
<master> claims domain "code" per-request but its config push declared "legal".
The config push is authoritative; the container will act on the header. Fix one.
```

Everywhere else that disagreement is silent, which is exactly the
confidently-wrong failure the contract exists to prevent.

---

## 1. Declare `domain: 'code'` — telling the sandbox it is for coding

### Where it goes

The `openrouter` block you **already push** over your existing master WebSocket
gains one field. This is not a new message or a new endpoint:

```ts
// your equivalent of Sound Suite's buildOpenRouterPush()
{
  apiKey: string;
  allowedModels: Record<string, { model: string; provider?: string; dims?: number }>;
  modeByRole: Record<string, 'local-only' | 'local-first' | 'cloud-only'>;
  domain: 'code',        // <- THE ONLY ADDITION
}
```

Sound Suite's equivalent line, for reference — `src/lib/gpu/fleet-router.ts:1044`:

```ts
return { apiKey: cfg.openRouterApiKey, allowedModels, modeByRole, domain: 'legal' };
```

### Exactly what happens to it

1. Arrives in the `/config` push payload, keyed by your `serverUrl`.
2. `sideCar/src/lib/virtual-inference.ts:243` runs it through `sanitizeDomain()`:

   ```ts
   function sanitizeDomain(raw: unknown): SandboxDomain | undefined {
     return typeof raw === 'string' && (VALID_DOMAINS as string[]).includes(raw)
       ? (raw as SandboxDomain)
       : undefined;
   }
   ```

   **Exact string match against `'legal' | 'code'`.** `'Code'`, `'coding'`,
   `'code '` all sanitize to `undefined` — silently, with no error returned to
   you. There is no fuzzy matching and no error surface; check
   `/api/status` to confirm it landed (§6).
3. Stored per master and persisted (`openrouter-store.ts`), so it survives a
   sidecar restart without you re-pushing.
4. Surfaced in `getOpenRouterStatus()` → visible on the sidecar's `/api/status`.

### Merge-on-partial-push — important

`virtual-inference.ts:239-243`: a push that **omits** `domain` keeps whatever you
declared last. Only an explicitly present value replaces it.

```ts
const domain = obj.domain !== undefined
  ? (sanitizeDomain(obj.domain) ?? existing?.domain)
  : existing?.domain;
```

This is deliberate — a partial config push must not silently un-declare a domain
that was working. Two consequences for you:

- You do **not** have to include `domain` in every push, only the ones that set it.
- You **cannot clear it** by sending `undefined`; and sending an invalid string
  falls back to the previous value rather than clearing it either.

### Hardcode it

Sound Suite hardcodes `'legal'` rather than exposing a toggle, and you should
hardcode `'code'`, for the same reason: which retrieval domain a codebase
operates over is a fact about the software, not an operator preference. A toggle
only creates a way to misclick legal tools onto a code caller.

**Never infer it from the port.** `:3000` and `:3848` are a deployment detail. A
master that declares no domain gets no tool injection and is treated as
undeclared — it must not default to either side, because the failure mode is
confidently wrong answers rather than an error.

### Honest status: the domain now reaches the injection point, but the tools are empty

Updated for sidecar 2.4.14 / image 0.1.2.

**What now works:** the domain travels end to end. Fantom's header is read by
the container, validated against `legal | code`, and handed to
`tools_for_domain()` — the single function that decides the REPL tool set. The
config push is stored, persisted and cross-checked against the header.

**What still does nothing:** both branches of `tools_for_domain()` return
`None`, because neither master exposes its retrieval over HTTP yet (§2).

```python
def tools_for_domain(domain):
    if domain == "legal":
        return None   # TODO: query_case_knowledge, query_case_graph
    if domain == "code":
        return None   # TODO: search_code, search_symbols, search_files
    return None       # unknown/absent: NO tools, never a default
```

So wiring your tools is now a change to **one function**, and everything feeding
it is verified. But until §2 lands the loop still reasons over the prompt it is
handed and cannot retrieve.

If you are debugging "the sandbox isn't using my tools": the domain is no longer
a plausible cause — check `/api/status` per §6, then look at whether the tools
exist at all.

Note the third branch. An unrecognised domain yields **no tools, never a
default**. Handing a code caller legal retrieval would answer confidently and
wrongly, which is worse than answering with no retrieval. The container logs
loudly when it drops a domain it does not recognise.

### Your model lives on the same per-master channel

Set `allowedModels['rlm-sandbox'] = { model: '<your choice>' }`.

This is deliberately **not** the sidecar-global `modelOverrides`, which holds one
value per sidecar and would let one master clobber the other's choice. The
sidecar resolves the model from *your* `allowedModels` when *you* are the
identified caller (§3). Sound Suite currently uses
`deepseek/deepseek-v4.1-flash`; yours is independent.

Without this entry the sidecar returns **503** with
`master <url> has not configured a model for rlm-sandbox`.

---

## 2. Expose your retrieval tools over HTTP

The `rlms` library cannot take host callables across a process boundary when the
REPL is isolated. We run `environment="local"`, so tools *can* be plain Python
callables inside the container — but those callables still have to reach **your**
data, and your data is in your master. So they become small Python functions
that POST to HTTP endpoints on you.

| | Sound Suite (`legal`) | Fantom (`code`) |
|---|---|---|
| Search | `query_case_knowledge(query, limit)` | `search_code(query, limit)` |
| Structure | `query_case_graph(entity)` | `search_symbols(name)` |
| Files | — | `search_files(pattern)` |

You already implement all three for your own RLM loop
(`src/embedding/rlmToolLoop.ts`). This is about making them reachable from the
sandbox's network namespace.

### Contract

Request:

```http
POST /api/rlm-tools/search_code
Content-Type: application/json
Authorization: Bearer <scoped token>

{"query": "...", "limit": 20}
```

Response — keep it **small and JSON**. The sandbox chunks and re-queries; it
does not need prose:

```json
{"results": [{"path": "src/x.ts", "line": 42, "snippet": "...", "score": 0.81}]}
```

### Design points to settle before building

- **Auth.** These endpoints expose codebase search. The fleet is VPN-only and
  single-tenant, but do not ship them anonymous. Decide between your existing
  Basic auth and a scoped token issued with the config push. Note the Sound Suite
  sidecar route is *currently* unauthenticated within the Docker network — that
  is a known gap on our side, not a precedent to copy.
- **Size.** An RLM issues many sub-calls. A fat response multiplies.
- **Base URL is per master.** It comes from your own declaration, not a
  hardcoded value, so a master that moves host or port changes only its own
  entry.
- **`RLM_CONTEXT_TOKENS` is resolved on our side.** It used to clamp the sandbox
  to `ss-rlm`'s 40,960 vLLM ceiling; `ResolvedRlmEndpoint.contextTokens` now
  carries the hosted model's real window.

---

## 3. Identity — which master's key gets spent

**This is the part that will fail first, and it is not optional.**

Every sidecar in this fleet carries OpenRouter keys from **both** masters.
`apiKey`, `allowedModels` and the spend are per master by design. When the
sandbox calls back for a sub-model completion, the sidecar must know who it is
acting for.

Over a WebSocket that is free — the action arrives on that master's socket. Over
HTTP there is no such context, so the sidecar **refuses**:

```json
{"error":{"message":"2 masters have OpenRouter keys on this sidecar
 (http://100.114.170.238:3000, http://100.114.170.238:3848). The caller must
 identify itself with the X-SoundSuite-Master header — refusing to guess whose
 key and budget to spend.","type":"sidecar_error","code":409}}
```

It refuses rather than picking the first because picking would spend one
master's budget on the other's model, silently and unprovably.

### What you must send

Headers on every request to the sandbox — identity, and where it is headed:

```http
POST http://<sidecar-host>:8101/v1/chat/completions
Content-Type: application/json
X-FantomMCP-Master: http://<your-master-host>:3848
X-SoundSuite-Master: http://<your-master-host>:3848
X-FantomMCP-Domain: code

{"messages":[{"role":"user","content":"..."}],"max_tokens":256}
```

This is exactly what Fantom already ships. Nothing to change — it is now read
on both hops (sidecar 2.4.14, image 0.1.2). Adding `X-SoundSuite-Domain: code`
alongside would be harmless and marginally more portable, but is not required.

**Header name:** `X-SoundSuite-Master`. Read case-insensitively on both hops, so
casing does not matter — but match this spelling so it greps.

**Value:** your canonical master URL. It must be **byte-identical** to the
`serverUrl` you use in your `/config` push, because that string is the map key
the sidecar files your config under. A trailing slash, `localhost` vs an IP, or
`https` vs `http` all resolve to a different key and return **404**, not a
fallback.

### What it travels through

Two hops read it, and both are already built:

| hop | code | what it does |
|---|---|---|
| sandbox `:8101` | `docker/rlm-sandbox/server.py` | reads it off your request, forwards it on every sub-model call it makes |
| sidecar `:8098` | `sideCar/src/app/api/v1/chat/completions/route.ts` | `req.headers.get('x-soundsuite-master')` → `resolveSandboxMaster(explicit)` → picks **your** key, **your** model, **your** budget |

It must be **per request**, not per container: one sandbox container serves both
masters, so a container-wide value would bill your traffic to us. This is why
`server.py` takes it off the incoming request rather than from an env var — an
earlier build used `SS_MASTER_URL` from the environment and every call 409'd.

Sound Suite's sender, for reference: `src/lib/ai/stream-rlm.ts` → `rlmHeaders()`,
resolving from `getCanonicalMasterUrl()` and attaching it **only** on the sandbox
path (the self-hosted vLLM server has no use for it).

### Concrete: what you write

```ts
const SANDBOX_MASTER_HEADER = 'X-SoundSuite-Master';

async function callSandbox(endpoint: string, body: unknown) {
  return fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // MUST equal the serverUrl you push in /config.
      [SANDBOX_MASTER_HEADER]: MY_CANONICAL_MASTER_URL,
    },
    body: JSON.stringify(body),
  });
}
```

That is the whole of item 3. There is no token, no signature, no handshake —
this is **identity, not authentication**. The fleet is VPN-only and
single-tenant, so the sidecar route is currently unauthenticated within the
Docker network; the header exists to route spend correctly, not to prove who you
are. Treat it as a known gap on our side rather than a pattern to copy into your
tool endpoints (§2).

### Errors you will see

| status | meaning | fix |
|---|---|---|
| **409** | Two+ masters have keys, you sent no header | Send `X-SoundSuite-Master`. The message names every candidate master. |
| **404** | The URL you sent matches no stored config | Match your `/config` `serverUrl` **exactly** — check for a trailing slash |
| **503** | Known master, but no key on file, **or** no `allowedModels['rlm-sandbox']` | Push a key; set your model (§1) |
| **502** | Upstream OpenRouter failure | Read the message — it is passed through verbatim |
| **400** | `stream: true` | Not supported; request a non-streaming completion |

The 409 body looks like this, and names both masters so it is actionable:

```json
{"error":{"message":"2 masters have OpenRouter keys on this sidecar
 (http://100.114.170.238:3000, http://100.114.170.238:3848). The caller must
 identify itself with the X-SoundSuite-Master header — refusing to guess whose
 key and budget to spend.","type":"sidecar_error","code":409}}
```

It refuses rather than picking the first, because picking would spend one
master's budget on the other's model — silently, and unprovably after the fact.

---

## 4. Files you will touch

On **your** side:

| file | change |
|---|---|
| wherever you build the OpenRouter push | add `domain: 'code'`; add `allowedModels['rlm-sandbox']` |
| your RLM entry point | send `X-SoundSuite-Master` on sandbox calls |
| new HTTP routes | `search_code`, `search_symbols`, `search_files` |
| `src/embedding/rlmToolLoop.ts` | reuse its retrieval, do not reimplement |

On **our** side — already built, listed so you can read the reference
implementation:

| file | what it shows you |
|---|---|
| `sideCar/src/app/api/v1/chat/completions/route.ts` | the endpoint your sandbox's sub-calls hit; identity resolution and refusal |
| `sideCar/src/lib/virtual-inference.ts` | `resolveSandboxMaster`, `sandboxModelFor`, `SandboxDomain`, per-master storage |
| `src/lib/ai/stream-rlm.ts` | how a master dials `:8101` and sends identity (`rlmHeaders`) |
| `docker/rlm-sandbox/server.py` | the shim, and where `custom_tools` will be wired |
| `src/lib/gpu/fleet-router.ts` | `buildOpenRouterPush()` — the push shape, incl. hardcoded `domain` |

---

## 5. Tool injection — where it plugs in

Currently **stubbed**: `server.py` passes `custom_tools=None`, so the loop
reasons over the prompt it is handed and cannot retrieve. Neither master exposes
tools over HTTP yet.

When it lands, the wiring is:

1. The sidecar knows the calling master's `domain` (you declared it in §1).
2. `server.py` receives the identity per request (§3).
3. It builds `custom_tools` as Python callables that POST to the declaring
   master's endpoints (§2).
4. `RLM(custom_tools=…)` injects them into the REPL globals.

With `environment="local"` these are ordinary callables — **not** code strings.
The code-string constraint in the original design note applies only to isolated
environments, which we do not use. If you read that note, prefer this file.

---

## 6. Verify your half

In order — each step is provable before the next, so a failure is never debugged
through two layers.

Set these once:

```bash
SIDECAR=http://10.10.20.5:8098          # any host with rlm-sandbox running
SANDBOX=http://10.10.20.5:8101
ME=http://100.114.170.238:3848          # YOUR canonical master URL
```

**1. Your `domain` landed.** This is the only way to confirm it — an invalid
value returns no error, it is just silently dropped:

```bash
curl -s $SIDECAR/api/status \
  | jq '.masters[] | select(.serverUrl=="'"$ME"'") | .virtualInference'
```

Verified live shape (this is Sound Suite's slot; yours should mirror it with
`"code"`):

```json
{
  "openrouter": "configured",
  "modeByRole": { "rlm-sandbox": "cloud-only", ... },
  "rolesWithModel": [ "embedding", "rlm-sandbox", ... ],
  "domain": "legal"
}
```

Three things to check in that one blob:

- `domain` is `"code"` — if **absent**, `sanitizeDomain()` rejected your string.
  It matches `'legal' | 'code'` exactly; check for capitals or whitespace.
- `openrouter` is `"configured"` — otherwise your key never arrived.
- `rolesWithModel` contains `"rlm-sandbox"` — otherwise you set no
  `allowedModels['rlm-sandbox']` and step 2 will return `data: []`.

Note the path is `.masters[].virtualInference.domain`, **not**
`.masters[].domain`.

**2. Identity resolves, and picks YOUR model.**

```bash
curl -s -H "X-SoundSuite-Master: $ME" $SIDECAR/api/v1/chat/completions
# 200 {"object":"list","data":[{"id":"<your model>","object":"model",...}]}
```

- `409` → header missing or the URL does not match your `/config` `serverUrl`
- `data: []` → identity is fine, but you set no `allowedModels['rlm-sandbox']`
- `404` → the URL matches no stored config at all

Run it **without** the header too. You should get a 409 naming both masters —
that proves the sidecar is distinguishing you from us rather than defaulting.

**3. A sub-model call is billed to your key.**

```bash
curl -s -X POST -H 'Content-Type: application/json' -H "X-SoundSuite-Master: $ME" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":16}' \
  $SIDECAR/api/v1/chat/completions | jq '.choices[0].message.content, .model, .usage.cost'
# "pong"   "<your model>"   0.00001…
```

`.model` echoing **your** model rather than ours is the real proof of isolation.

**4. The sandbox answers you end to end.**

```bash
curl -s -X POST -H 'Content-Type: application/json' -H "X-SoundSuite-Master: $ME" \
  -d '{"messages":[{"role":"user","content":"...SECRET=418293 buried in filler..."}],"max_tokens":256}' \
  $SANDBOX/v1/chat/completions | jq '.choices[0].message.content'
# "418293" — Sound Suite's equivalent returns in ~7s
```

**5. Your tools are reachable from the container's namespace** — not just from
your laptop. The container reaches the host via
`host.docker.internal:host-gateway`, which the sidecar sets on creation.

**6. Tool injection**, once §5 ships.

Steps 1–4 need nothing from us and can be done today. If any fails, the
container logs are one call away and require no SSH:

```bash
curl -s "$SIDECAR/api/logs?role=rlm-sandbox&tail=50" | jq -r .logs
```

---

## 7. Things that cost us time — do not repeat them

Each of these was a real failure on this fleet.

- **`type: 'vllm'` is a lie told for the container lifecycle.** The sidecar keyed
  its vLLM command builder off that type and handed our image
  `[<model-id>, '--host', …]`, so Docker exec'd the model id as a binary and every
  container died with `[FATAL tini] exec deepseek/deepseek-v4-flash failed`.
  Fixed with `ContainerDef.usesImageCmd`. If you add a role, trace what *else*
  reads its type.
- **Containers are immutable.** A container keeps the `Cmd` it was created with
  forever; pulling a corrected image changes nothing. Three hosts restart-looped
  until drift detection learned to notice a `Cmd` that should not be there.
- **A drift check that only fires when it expects *something* cannot detect a
  leftover.** The Cmd comparison was gated on `expected.Cmd` being truthy.
- **`rlms`, not `rlm`.** The PyPI distribution is `rlms`; the importable module
  is `rlm`. Checking the wrong name yields a confident, wrong "not published".
- **A blank string is not "no change".** `/admin/openrouter` wrote `''` over a
  configured sandbox model because `typeof '' === 'string'` passed the guard,
  and `resolveRlmEndpoint()` skips the whole fallback when the model is unset.
- **GHCR packages are private by default**, and there is no REST endpoint to
  change that — it is a manual UI step. A private package fails the pull with a
  401 that looks exactly like a missing image.
- **Build multi-arch.** This fleet is 3× `windows-docker-wsl2` (amd64) and 2×
  `mac-docker-ollama` (arm64). Single-arch fails on the other half as a
  container that will not start, not as a pull error.

---

## 8. Open questions — yours as much as ours

1. **Does the pattern with a general model beat the purpose-trained 8B?**
   Unknown. Only measurement answers it. Run both roles against the same
   evaluation set. **Do not retire `ss-rlm` on the strength of a design
   document.**
2. **Cost shape changes** from per-GPU-hour to per-token, and an RLM makes many
   sub-calls. Per-role daily caps exist on the OpenRouter panel; `max_budget`
   works inside the loop. Note the master currently cannot *see* sandbox spend —
   `usage` comes back zeroed (see [README](./README.md#known-defect)).
3. **Auth on the tool endpoints** (§2) is unsettled on both sides.
