# MCP Report v5.1 — residual gaps closed, and what the tests found

**Date:** 2026-09-05 · **Baseline:** `19d456a` · **Source report:** `REPORT-v5-independent-verification.md`
**Task doc:** `docs/tasks/08-mcp-v5-residual-gaps.md`

All examples synthetic. No case numbers, party names, filing titles, or document text.

## Status against the v5 queue

| # | Item | Status |
|---|---|---|
| 1 | Draft backfill | ⏳ Operator — safe to run; still blocked by the permission classifier here |
| 2 | Outline model | ✅ **Fixed at the root** — the model was never wired; now admin-driven (§3) |
| 3 | Structure backfill | ⏳ Operator |
| 4 | **R-1** gate `/api/mcp/tools` | ✅ Closed — every `/api/mcp/*` route, job routes included |
| 5 | **R-4** `structuredContent` | ✅ **Not a code gap** — the installed bridge was unsynced (§1) |
| 6 | `tableMarkdown` cap; pre-cap total in `stats.caps` | ✅ |
| 7 | **M-5** execute auth | ◐ Tightened; **the v5 row-3 bypass is proven unclosable at this layer** (§4) |
| 8 | Batched rerank | Deferred, per v5 §6 |
| 9 | **SS-3** per-tool tests | ✅ 278 tests — **and they found four correctness bugs; three are fixed** (§5) |
| 10 | **R-5** proxy latency | ✅ Measured — noise (§1) |
| — | **User requirement:** MCP picks up admin-page model config | ✅ (§3) |

## Verification

- **Typecheck:** 59 errors in 15 files, **byte-identical to the pre-v4 baseline** across three rounds now.
- **Tests:** `src/lib/mcp` + `src/lib/search` + `src/app/api/mcp` + `src/lib/db` + the new admin panel suite → **914 passed, 0 failed** (46 suites). Was 579 at `19d456a`. `src/lib/ingestion` at its unchanged 63-failure baseline.
- **Lint:** clean on every new and changed file.

## 1. Two v5 findings were not what they appeared

**R-4 — `structuredContent` "still absent".** The installed bridge at `~/sound-suite-bridge/bridge.mjs`
contains zero occurrences of `structuredContent`; the repo copy shipped in `c4cee6f` contains four. The
v5 probe ran through proxy → *installed* bridge, so it measured pre-fix code. Corroborated by byte
counts: the proxy returned ~8.5 KB more than direct (JSON-RPC envelope), not the ~2× a live
`structuredContent` would produce. **Syncing the bridge closes R-4.** This also inverts v5's operator
ordering, which ranked the sync last on the grounds that "nothing verified requires it".

**R-5 — proxy slower than direct.** Three alternating samples, same synthetic `fast` query:

| run | direct | proxy |
|---|---|---|
| 1 | 16,155 ms | 18,986 ms |
| 2 | 14,472 ms | 12,937 ms |
| 3 | 19,366 ms | 14,744 ms |
| **median** | **16,155** | **14,744** |

The proxy is not slower; the spread swamps the difference. v5's single cold sample was taken during a
125-second job, exactly as its own caveat allowed. Non-finding.

## 2. Evidence caps — the last two gaps from v4.1

`tableMarkdown` is now bounded by `maxCharsPerChunk`, cut on a **row** boundary with the marker's
length reserved inside the bound, so the prefix still renders as a table. It gets its own counter,
`tablesTruncated`, rather than folding into `chunksTruncated` — v4.1 defined the latter as "returned
items whose *text* was shortened", and merging would have quietly changed what that number answers.

`stats.caps` is now `{ maxEvidence, maxCharsPerChunk, evidenceTruncated, evidenceTotalBeforeCap,
chunksTruncated, tablesTruncated }`. `evidenceTotalBeforeCap` is set unconditionally.

Truncation stays at item construction, before the count cap, so `onEvidence` streaming is bounded.
The v5 R-3 asymmetry (150 streamed / 40 returned) is unchanged and remains a documented property.
Degenerate case, stated plainly: when `maxCharsPerChunk` is smaller than the 20-char marker, the
result is a hard slice with no visible marker; nothing renders as a table at that size anyway.

## 3. The outline model was never wired — and MCP now honours the admin page

This began as the user's correction ("MCP should pick up what is set up on the admin page") and
turned into the most consequential code fix of the round.

**The bug.** `gather-evidence.ts` built the outline options as `model: llmModel ?? LOCAL_ROUTING.outline.model`.
`llmModel` is the already-resolved *decompose* model, so it always won: **the outline always ran on
the decompose model**, and `localOutlineModel()` was never called from anywhere in `src/`. Dead
code. N-3's "small model for the outline" could not take effect no matter what an operator pulled
or configured — which means v4.1's and v5's operator step "`ollama pull qwen3:1.7b`" would have done
nothing. An existing test was asserting the outline used the decompose tag: it was encoding the bug.

**Fixed.** The outline now resolves its model via `localOutlineModel(config)` independently of
decompose, falling back to the preferred tag (never the decompose model, never an exception) if the
resolver fails. Regression test stubs the two resolvers to different tags and asserts
`modelsUsed.outline` reflects the outline one.

**Admin-driven, as asked.** Before this round: the decompose model already preferred
`ai.ollamaDecomposeModel` but **no admin UI field set it**; the outline model read no admin config
at all. Now:

- New config key `ai.ollamaOutlineModel`, mirrored through `config.ts` and `/api/config`.
- Both resolvers put admin config first: outline is `config.ollamaOutlineModel` → env → preferred
  tag *only if the host reports it* → any small instruct tag on the host → decompose resolver.
  Because the outline chain ends in the decompose resolver, **pinning decompose moves both**.
- Admin → **AI Services** gains an "MCP local research models" card with **Decompose** and
  **Outline** pickers, populated from the models actually installed on the configured completion
  host, defaulting to `Auto (resolve from host)` so existing installs are unchanged. A new
  `GET /api/config?resolve=localModels` runs the real resolvers server-side (env-aware, which the
  browser cannot compute) and the card shows "Currently resolves to `<tag>`".
- A stale pin stays visible: `<tag> (not installed)` if gone from the host, `<tag> (not a text
  model)` if present but filtered — never a silent revert to Auto.

**Verified live in Chrome**, not only by RTL: the card renders on `/admin/aiservices`, both selects
present and defaulting to Auto. That live check caught what the RTL test could not, because its
mocked model list was clean: **the pickers were offering the host's OCR/vision models** as Decompose
and Outline choices. An operator pinning `minicpm-v` would have silently broken both steps, which
are constrained JSON generation. Fixed using Ollama's real capability signal — `/api/tags`
`details.families` carries a `clip` projector family on multimodal builds — rather than name
matching; it fails open (an unclassifiable model stays listed) and makes the filtering visible
("3 OCR/vision models on this host are not listed here"). Re-verified live: both pickers now offer
exactly `Auto` and `qwen3.5:9b`.

**What an operator sees today.** With both pickers on Auto, `?resolve=localModels` returns
`{"decompose":"qwen3.5:9b","outline":"qwen3.5:9b"}` — the genuine Auto path, because the host has
no small instruct model (`SMALL_DECOMPOSE_TAG` matches nothing there). The outline therefore still
runs on the 9 B and still returns `null` at 25 s. **The fix makes a better model selectable from
the admin page the moment one is installed**; it does not conjure one. Pull a small instruct tag,
then pick it — or leave Auto, which will find it.

One nuance, so the two filters are not described as one rule: the `/api/ollama/models` route drops
names containing `embedding`; the pickers additionally drop `/embed/i`. A tag like `nomic-embed-text`
reaches the general Local-model picker but not these two — intended.

## 4. Gating — R-1 closed; M-5 tightened, with a proven ceiling

**R-1.** Every `/api/mcp/*` route now runs the same `guardMcpRoute()` as execute — tools,
claude-tools, tool-health, stats, execution-history (which carries the real queries tools were
called with), tool-config on read **and** write (a write can enable a tool or lift a rate limit),
and the four job routes. `POST /api/mcp/research|report` starts a spend-capable job and was
completely unauthenticated — arguably a larger hole than R-1 itself.

**M-5 — what was learned.** The brief proposed distrusting `X-Forwarded-For` unless an operator
opted in. Built, it 401'd every loopback request. Cause, from Next's own source
(`base-server.js:576`): `req.headers['x-forwarded-for'] ??= socket.remoteAddress`. **Next injects
XFF from the socket peer on every request that lacks one.** XFF is the real peer address here, and it
is *why the gate works at all*. Consequence: a client that sends its own single value keeps it
(`??=` does not append), so a forged `XFF: 127.0.0.1` is byte-identical to a genuine loopback
request. **v5's row-3 bypass cannot be closed in a route handler.** No un-forgeable per-request
signal exists at this layer.

What was closed instead, none of it breaking loopback:

| Request | `/api/mcp/tools` | `/api/mcp/execute` |
|---|---|---|
| loopback bare | **200** | **200** |
| `XFF: <public>` | 401 | 401 |
| `XFF: 127.0.0.1` | 200 | 200 — **residual, proven unclosable here** |
| `XFF: <public>, 127.0.0.1` | 401 | 401 |
| `XFF: 127.0.0.1, <public>` *(new)* | 401 | 401 |
| `X-Real-IP: 127.0.0.1` *(new)* | 401 | 401 |
| `Forwarded: for=127.0.0.1` *(new)* | 401 | 401 |
| `Host: public.example` (raw socket) | 401 | — |
| dashboard `?profile=all` | **200**, 32 tools | — |

Rules: ≥2 XFF entries ⇒ remote (`??=` can never produce two); `X-Real-IP` or `Forwarded` present ⇒
remote (Next never injects either, no first-party caller sends them). `MCP_TRUST_PROXY=1` restores
leftmost-entry reading for a deployment genuinely behind a reverse proxy. `Via` was deliberately
excluded — a local caching layer can set it legitimately.

**Probe caveat for anyone repeating v5's method:** `fetch()` (undici) silently normalises the `Host`
header, so a `Host: public.example` probe via `fetch` gets a false 200. The Host rows above are from
raw sockets.

**Deliberately ungated:** `/api/health` — the sidecar probes it cross-host for master discovery
(`sideCar/src/lib/config.ts:376`) and the install script tells operators to curl it; gating it would
break sidecar attach.

**The standing position is unchanged and must stay in the record:** this is a browser control.
A caller that can reach the port and forges `Host: localhost:3000` still passes. Loopback binding
and the Cloudflare interlock are the real access controls. **The port is not safe to expose.**

## 5. SS-3 — the tests found what "zero executions" was hiding

278 tests across the 12 analysis tools — metadata, param validation, LLM contract, fail-closed
policy — with `completeAI` the only thing mocked so the real parse-and-retry path runs. Every
defect was pinned with an `it.failing` tripwire **paired with a sibling test asserting the current
wrong behaviour on the same fixture**, so no tripwire can go vacuous. The tripwires then served as
the acceptance criterion for the fixes.

**Ranking, and why it differs from the first read.** The parse-failure bugs (#2/#3) produce a
*false negative* — "no contradictions found" when the model returned unparseable prose. Bad. But
#1 produces a **false positive**: `detect_contradictions({})` filtered on `{caseId: undefined}`,
sent whatever the store returned to the model, and handed back a populated, confident analysis of a
scope the caller never named. A client acts on that; it cannot act on an empty array. A wrong
answer outranks a missing one.

| # | Finding | Status |
|---|---|---|
| 1 | No `validateParams` on any of the 10 LLM tools — `{}` yields a confident analysis of nothing | ✅ Fixed — generic presence check against each tool's own `inputSchema.required`, run before the tool's hook. All ten `required` arrays verified accurate. |
| 2 | `callLLMJson`'s `{_markdown: raw}` fallback becomes `{key: []}` on guarded tools — indistinguishable from a genuine negative | ✅ Fixed — throws `LLM_PARSE_ERROR` after retry; fallback survives only behind `allowMarkdownFallback: true`, default off |
| 3 | `compare_argument_structures` / `analyze_tone` return `callLLMJson` unguarded — prose yields `success: true` with the documented key absent | ✅ Fixed — key must be a non-null object or `LLM_SHAPE_ERROR` |
| 4 | No item-level validation — `["Vaughn v. Merrowfield, 1 F.3d 1"]` returns bare strings typed as citation objects | ⏳ Open — 10 tripwires still failing |
| 5 | Confidence coercion: `undefined >= 0.7` silently drops an unscored finding; `"0.9" >= 0.7` passes a string where the type says `number` | ⏳ Open — 2 tripwires still failing |

30 tripwires now pass; 12 remain `.failing` by instruction.

**Two things about fix #2 worth knowing.** First, `_markdown` is consumed by the dashboard's
`MCPResultRenderer`, so a bare throw would have changed UI behaviour; the opt-in preserves the three
dashboard search paths that legitimately render prose (decompose fallback, report-outline fallback,
evidence-outline `null` path). But the brief's premise was wrong in one respect: the dashboard's
tool explorer runs the ten analysis tools through the *same* `execute` path as MCP, so there is no
dashboard-side call site for them to opt in — **a parse failure now shows as an error in the
dashboard too**, rather than as an empty result. That is the correct outcome. The renderer's
`_markdown` branch is now unreachable for those tools; it was left in place.

Second, privacy: the error returned to the caller includes a truncated raw snippet so the failure is
diagnosable, and that snippet may contain case text. `McpError` gained a `logSafeMessage` twin
("`N` chars; response withheld from logs"); `base-tool` logs the twin and withholds the error object
so its stack cannot carry the snippet. The evidence-outline path keeps the opt-in for the same
reason — its `catch` writes a message slice into the persisted event stream. **Verified directly**,
not taken from the agent's report.

**Also found, not fixed:** a context with no `profile` bypasses the `ai-helper` guard entirely;
fail-closed currently lives only in `ToolRegistry.execute`'s default, so any caller reaching a tool
outside the registry escapes the policy. And `detect_contradictions` / `detect_privilege` are
protected against #4 purely as a side effect of their confidence filter — the other eight are not.

## 6. New findings this round

- **`/api/config` is ungated, and its plain GET returns stored API keys.** No middleware, no session
  check. Found while touching the route for the admin pickers; reported rather than fixed, as out of
  scope. This is a credential *read*, which is worse than the execute route's compute spend. **P1.**
- **A second MCP surface exists** — `src/lib/mcp/mcp-server.ts` on `MCP_PORT` (3001) has its own auth
  handling and its own tool listing. R-1 is closed on the Next.js surface only; v5 never probed 3001.
- `persist()` in the admin panel refetches then POSTs, so two rapid picks can drop the first. Minor.

## Operator actions, in order

1. **Sync the bridge and restart the proxy** — this is what closes R-4:
   `cp scripts/mcp-bridge/bridge.mjs ~/sound-suite-bridge/bridge.mjs && ~/Code/mcp-proxy/scripts/restart.sh`
   (interrupts the other upstreams the proxy hosts — pick a quiet moment).
2. **Apply the draft backfill** — `npx tsx scripts/backfill-draft-status.ts --apply`. Backup exists at
   `sound-suite.db.bak-20260905-094335`. 29 documents become `filed`, 0 drafts.
3. **Install a small instruct model, then pick it on Admin → AI Services**, or leave Auto to find
   it. Until then the outline runs on the 9 B and returns `null`. *Correction to v4.1 / v5:* pulling
   the model alone would not have helped before this round — the outline was not wired to use it.
4. **`/api/admin/structure-backfill`** for `heading_path` / `block_type` coverage.
5. **LAN dashboard users:** the whole MCP tab now 401s from `<LAN-IP>:3000`, not only execute. Set
   `MCP_API_KEYS` and send the key — `MCP_TRUST_PROXY` does not authenticate anything.
6. If a same-host reverse proxy fronts the app, set `MCP_TRUST_PROXY=1` or every request classifies
   as remote.

## Still open

- **`/api/config` exposes stored keys** — P1, new.
- **The `:3001` MCP surface** — unprobed, own auth.
- **M-5 residual** — forged single-value `XFF`/`Host` on the port; unclosable at this layer.
- SS-3 findings #4 and #5, and the absent-`profile` bypass in `ai-helper`.
- Batched rerank after fusion (needs GPU measurement).
