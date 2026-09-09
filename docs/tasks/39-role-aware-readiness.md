# Role-aware readiness — populate the mechanism that exists, retire the global

**Status:** Proposed · **Effort:** S–M · **Priority:** P1 · **Created:** 2026-09-09
**Report:** [`../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md`](../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md)
**Unblocks:** [task 30](./30-mcp-parity-and-fleet-visibility.md) Part 3 · [task 38](./38-interactive-embedding-budget.md)

Field names and code citations only. No case data.

## Problem

MCP readiness for the `local` profile is **one cached boolean derived from a completion-only probe**,
applied to every LLM tool regardless of which of six roles it actually needs.

`tool-registry.ts:60`:

```ts
ollamaUp = r.reachable && r.generates
```

That probe (`shared-dependencies.ts:197-252`) does `GET /api/tags` at 3 s plus a 5-token
`POST /api/generate` smoke at 10 s against the **completion** host, cached 60 s with 2-strike
hysteresis. **Embedding, OCR, code-embedding, reranker and RLM liveness are never checked anywhere on
the MCP surface.**

### The measurement that proves the consequence

Observed independently, and it matches the source exactly: `ss.tools('local').notReady` read `[]`
while the retrieval path hung, **and** `[]` while it was healthy. Ollama could generate throughout,
so every tool reported ready — including tools depending on a vLLM role that was `exited`.

**`notReady` is not a weak signal; it is an uninformative one.** It answers a question nobody asked
("can the completion host generate?") in a field that reads as "is this tool usable?".

## What this actually costs today — traced end to end

`query_case_knowledge` with the embedding host **stopped**, settled from source:

| `searchMode` | Outcome |
|---|---|
| **`hybrid`** (the default, `query-case-knowledge.ts:188`) | **Silent degrade.** Embed throws → caught at `:245` → `pushWarning({ source: 'embedding', host, reason: 'embed-failed', … })` at `:251-256` → falls through to keyword/FTS at `:276`. **The caller gets a successful result with the vector leg missing.** |
| `vector` | Hard error — `:261-264` rethrows as `EMBEDDING_UNAVAILABLE` |

**And the readiness gate never fires in either case.** `query_case_knowledge` declares
`category: 'search'` (`:103`) → `toolNeedsLlm` is false (`tool-registry.ts:156`); it overrides no
`getDependencies()`, so `base-tool.ts:84-86` returns `[]`. **`isToolReady` returns `{ ready: true }`
with the embedding host down.**

That is this task's thesis, demonstrated: the tool most dependent on the embedding role is the one
the readiness system says the least about.

**The silent degrade is the more serious half, and readiness alone does not fix it.** A search tool
returning fewer results because its vector leg vanished — with no error, and success in the envelope
— is the same defect this series has spent thirteen reports removing, relocated from *completeness
claims* to *recall*. Whether that `pushWarning` reaches the MCP response at all, or stops at the
deep-search boundary, is unsettled and is item 10 below. It is the same question
[task 22](./22-rerank-observability.md) item 9 asks about the rerank `warn('degraded', …)`.

**Timing, so the failure is not merely silent but slow:** three attempts, each preceded by a 1.5 s
preflight that fails fast on a refused connection → **floor ≈ 10–14 s**. The upper bound is
`resolveEndpoint`'s acquire walk across every registered sidecar at 15 s per POST
(`fleet-router.ts:203`, `:1050-1133`) before throwing at `:1143` — roughly **N × 15 s per attempt**
with N unreachable sidecars. So [task 38](./38-interactive-embedding-budget.md) §2's ~370 s is not
just a lower bound; **its shape is wrong** — the real ceiling scales with fleet size, not with
Ollama's constants alone.

## The fix is smaller than it looks — the mechanism already exists

An earlier framing held that `category: 'search'` was being overloaded to encode dependencies, and
that a new way to express them was needed. **That was wrong.** A per-tool dependency mechanism is
already wired end to end and already used:

| Piece | Where |
|---|---|
| `ToolDependency { key, label, required, check(): Promise<boolean> }` | `tool-types.ts:65-74` |
| `getDependencies()` — *"override to declare"* | `tools/base-tool.ts:83-86` |
| `refreshDependencies()` — runs every check in parallel, caches | `tool-registry.ts:108-133` |
| `dependencyStatus: Map<toolName, {…, satisfied}[]>` | `tool-registry.ts:47` |
| `isToolReady()` — already fails on an unsatisfied required dep **with a specific reason** | `tool-registry.ts:167-172` |

About nine tools already override it, with an established helper-factory convention:
`detect-contradictions.ts:87` → `[llmProviderDependency(), vectorStoreDependency()]`;
`research-evidence.ts:150` → `[localLlmDependency()]`; likewise `track-claim-evolution`,
`reconstruct-timeline`, `detect-privilege`, `extract-obligations`,
`compare-argument-structures`, `analyze-tone`.

**What blocks it is that the global is applied on top, unconditionally** —
`tool-registry.ts:175-180`:

```ts
if (profile === 'local') {
  const tool = this.tools.get(toolName);
  if (tool && this.toolNeedsLlm(tool) && !this.ollamaUp) {
    reasons.push(ollamaUnavailableReason(this.ollamaState));
  }
}
```

A tool that declared its roles correctly today would **still** be blocked by a completion probe that
says nothing about vLLM. So this task is: **declare roles through the existing mechanism, and delete
the second gate.** `notReady` then becomes correct for free, since it is already computed from
`!x.ready`.

## Probe targets, per runtime

| Runtime | Roles | Probe | Note |
|---|---|---|---|
| Ollama | embedding 11434, completion 11435, ocr 11436, code-embedding 11437 | `/api/tags` + `/api/ps` | the sidecar already does this (`sideCar/src/lib/ollama-api.ts:82`) |
| vLLM | reranker 8099, rlm 8100 | `GET /v1/models` | **no `/api/ps` equivalent** — `sideCar/src/lib/state.ts:412` says so verbatim; sidecar infers liveness from `nvidia-smi` PID attribution |

**A shared Ollama answers on 11434 regardless of role.** This is encoded, not folklore —
`fleet-router.ts:601,606,611` rewrite host-runtime Ollama roles to `port: 11434`. It must never be
reported as drift.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building** (this repo's standing rule — four premises of v12 and three of v14 were refuted this way). Re-verify `tool-registry.ts:47,108-133,167-172,175-180` and `tool-types.ts:65-74` still read as above. | ☑ done 2026-09-09 — all confirmed, **plus two corrections: see items 6 and 11.** Also settled: the `ollamaUp` gate is scoped to `profile === 'local'` only (`:176`), and `refreshDependencies` (`:118-133`) turns a **thrown** check into `satisfied = false` — so a role check must never let a fault escape. |
| 2 | Add a `roleDependency(role: FleetRoleName)` factory beside the existing `…Dependency()` helpers. **Done** (`shared-dependencies.ts`), with two deviations from the spec above, both deliberate: the key is `fleetRole:<role>` (namespaced so it cannot collide with a config-key dependency), and **`required` defaults to `false`** — see item 6. | ☑ done 2026-09-09 |
| 3 | **Source the check from fleet state the master already holds, do not re-probe.** Confirmed: **nothing under `src/lib/mcp/` reads fleet state today** — grep for `fleet-router\|status-cache\|resolveEndpoint\|getFleetStatus\|getSidecarStatus` returns **zero hits**. The two modules to import are `@/lib/gpu/fleet-router` (`getFleetStatus()`, `resolveEndpoint(role)`, type `GpuRole`) and `@/lib/gpu/status-cache` (`getSidecarStatus(url)`, `isSidecarConnected(url)`, type `CachedSidecarStatus`). Both are server-only and already import prisma, so they are safe for `src/lib/mcp/` — but **must never reach the admin client bundle**, the same constraint that forced `model-capabilities.ts` to exist as a leaf module (`:5-8`). A second probe would duplicate a cache one import away and the two would drift. | ☑ done 2026-09-09 — sourced from `findSidecarsWithRole` + `getAllSidecarStatuses` via a **dynamic** `await import()` inside `check()`, matching the `prisma` convention in the same file and keeping the server-only module off any static import path. |
| 4 | ~~Establish the cache TTL before gating on it.~~ **Answered — it is fresh enough.** Sidecars **push** their full `/status` to the master every **5 s** (`sideCar/src/lib/ws-client.ts:46 HEARTBEAT_INTERVAL = 5_000`, fired at `:973` HTTP / `:1061-1084` WS), landing in `status-cache.ts` as `CachedSidecarStatus` — per-role `status`, `loadedModels`, `config.port`, `gpuOnly`, `gpuReady`, `vram.perRole`, `idleTimeouts`. **Capability knowledge is inbound and continuous, not something the master polls.** Record the 5 s cadence in the check's comment so the next reader does not re-derive it. | ☑ settled |
| 5 | ~~Declare roles on the tools that need them.~~ ⚠️ **Correction — this item is largely unbuildable as written, and declaring it anyway would be wrong.** See "Role need is per-call, not per-tool" below. `query_case_knowledge` is **removed** from this item; the reranker and RLM declarations are **deferred** to the per-call mechanism. What survives is the unconditional subset only. | ☐ reshaped |
| 6 | **Retire the global — but not before the replacement proves liveness.** ⚠️ **Correction: this item as originally written would have caused a regression.** `llmProviderDependency` (`shared-dependencies.ts:15-38`) checks **credential presence, not liveness** — a bare `OLLAMA_HOST` in the environment satisfies it with Ollama stopped. `ollamaUp = r.reachable && r.generates` (`tool-registry.ts:60`) is therefore currently the **only** thing proving an analysis tool can actually run. Deleting the branch today would turn all nine non-`search` tools green against a dead Ollama — the same defect as the silent degrade, pointed the other way. **Precondition:** `roleDependency('completion')` must prove *reachable && generates*, and be `required: true`, before the global comes out. **And note the semantic shift:** `ollamaReadiness()` probes a **single** configured host, so preserving its guarantee fleet-side means *some host serving the role* generates — not *the configured host* does. That is a different check, not a port of the existing one. | ☐ blocked on stage 2 |
| 7 | **Do not let a role probe hang a readiness call.** Bounded per-host timeout; a host that does not answer is `unknown`, not `down`. | ☐ |
| 8 | Fix the doc drift found in passing: `tool-registry.ts:220` commented *"cached 30 s"*; the constant is **60 s**. | ☑ done 2026-09-09 — comment now names `OLLAMA_PROBE_CACHE_MS` so the two cannot drift again. |
| 9 | Tests: a tool with an unsatisfied role dep is `notReady` **with that role named**; a tool needing only embedding is **ready** while completion is down; the previous behaviour (everything ready while a vLLM role is exited) is asserted **gone**. | ☐ |
| 10 | **Decide what a silent degrade owes the caller**, and verify the existing signal reaches them. `query_case_knowledge` already calls `pushWarning({ source: 'embedding', reason: 'embed-failed' })` (`:251-256`) before falling through to keyword-only — but whether that warning survives to the MCP response is **unsettled**. Trace it. If it does not surface, a caller cannot distinguish a thin result from a degraded one. Same question as [task 22](./22-rerank-observability.md) item 9. | ☑ **done 2026-09-09 — traced: it does NOT reach an MCP caller. `pushWarning` is a dead channel there, for two independent reasons. Replaced with an in-band `retrieval` + `warnings` block on the result. See §"Item 10 settled" below.** |
| 11 | **`GpuRole` omits `rlm` *and* `code-embedding`** (`fleet-router.ts:153`) — the original wording under-counted by one. **Correction: this is no longer a prerequisite.** `findSidecarsWithRole(role: string, …)` takes a bare `string`, so role dependencies are expressible today without widening the union; consolidating `GpuRole` / `ROLE_PORTS` / `stream-rlm.ts` is its own change with its own blast radius, and is **deferred out of this task**. The original reasoning follows, still accurate: it is why `stream-rlm.ts:195-246` cannot use `resolveEndpoint` and walks `fleet.sidecars` by hand instead, matching `containers.rlm.status === 'running'` and skipping synthetic images. Adding `rlm` to the type is a prerequisite for expressing an RLM role dependency at all — and is the same omission as the missing `rlm` entry in `ROLE_PORTS` ([task 30](./30-mcp-parity-and-fleet-visibility.md) amendment (b)). | ☐ |

## Staging — why this ships in two commits

Declaring role dependencies is **additive**. Retiring `ollamaUp` **changes behaviour for nine
tools**. Bundling them would make a routing regression indistinguishable from a readiness regression,
so they are separate:

**Stage 1 (done, 2026-09-09) — earn the signal.** `roleDependency()` ships with `required: false`.
`isToolReady` only blocks on `dep.required && !dep.satisfied`, so an advisory dependency surfaces
role state in `dependencyStatus` and can be compared against reality across real degradations
**without gating anything**. This task's whole premise is that the current readiness signal is
uninformative; a replacement that is trusted before it is observed would repeat that mistake with a
new mechanism.

**Stage 2 — flip to `required: true`, then delete the global**, in that order, with item 6's
liveness precondition met first.

### The three-outcome rule

`checkRoleAvailability` returns `available` / `unavailable` / **`unknown`**, and `unknown` never
refuses. Two outcomes would be wrong in two distinct ways, both of which fail *closed* on healthy
systems:

| Situation | Two-outcome result | Correct |
|---|---|---|
| No sidecar has ever reported (single-box install) | role "down" → every tool blocked | `unknown` |
| Role served by a directly-configured host (`ai-provider.ts:431,940`) rather than a sidecar | role "down" while it works | `unknown` |
| Fleet cache read throws | `refreshDependencies` catches → `satisfied = false` → "down" | `unknown` |

This is the repo's own **"`UNREPORTED` is not `down`"** rule (`docs/mcp/README.md` §3, [task
30](./30-mcp-parity-and-fleet-visibility.md) amendment (c)) applied to its own readiness check. The
vLLM roles (`reranker`, `rlm`) have **no** direct-host path, so they are not rescued into `unknown`
by a configured Ollama host — asserted in the tests.

**A running-but-cold role is `available`.** `vram.perRole[role].loaded` is preferred over
`containers[role].status` for the *basis string* — status carries the synthetic `'running'` that
host-Ollama and DMR roles get without a probe — but absence of residency is not a reason to refuse,
because Ollama loads on demand.

## Role need is per-call, not per-tool — and `ToolDependency` cannot say that

Item 5 assumed each tool has a fixed set of roles. **It does not.** Verified 2026-09-09:

**`query_case_knowledge`** (`query-case-knowledge.ts:241,261`) reaches the embedding role on
`searchMode` `vector` and `hybrid`, and **never** on `keyword`:

| `searchMode` | Touches embedding? | Behaviour when embedding is down |
|---|---|---|
| `keyword` | **no** | unaffected |
| `vector` | yes | **already fails loudly** — throws coded `EMBEDDING_UNAVAILABLE` (`:262-266`), which the dashboard turns into configure-a-provider guidance |
| `hybrid` (**default**) | yes | **silently degrades** to keyword/FTS (`:251-256` warning → `:276` fallthrough) and returns success |

So a static `roleDependency('embedding')` on this tool would be wrong on two of three modes: it
**over-refuses** `keyword`, which needs nothing from the fleet, and adds nothing to `vector`, which
already fails with a better error than a generic `notReady`. It would convert a working call into a
refusal — a *new* wrong answer, not a fix for the old one.

**The one mode that is actually broken — `hybrid` — is broken in a way readiness cannot express.**
The tool is genuinely ready; the *call* degraded. That belongs at the degrade site (item 10), not in
`isToolReady`.

## Item 10 settled — `pushWarning` is a dead channel on the MCP path

Traced 2026-09-09. **The warning does not reach a caller of `query_case_knowledge`,** for two
independent reasons — either alone is sufficient, so wiring one without the other would fix nothing:

1. **Nothing ever supplies `pushWarning` on an MCP-facing context.** It is optional on
   `ToolExecutionContext` (`tool-types.ts:122`). The production context is built at
   `get-tool-registry.ts:107-112` with exactly four fields — `vectorStore`, `embeddingProvider`,
   `database`, `logger` — and no warning sink. The only overlay,
   `api/mcp/execute/route.ts:139-145`, adds `aiProvider` / `aiModel` / `sessionId` only.
   `mcp-server.ts:205` calls `registry.execute(tool, params)` with no context argument at all.
   So `context.pushWarning?.(…)` in the embed-failure catch is an **optional call on `undefined`** —
   a no-op that compiles, runs, and discards the fact.
2. **There is no field to carry it even if it were supplied.** `ToolExecutionResult`
   (`tool-types.ts:129-135`) is `{success, data, error, errorCode, executionTimeMs}`.
   `BaseMCPTool.execute` (`base-tool.ts:228-274`) never reads warnings off the context, and
   `mcp-server.ts:222` / `execute/route.ts:167` send `result.data` alone.

**Denominator.** The channel is not dead everywhere. `deep-search.ts:509` — via
`executeParallelSearches` — is the **sole** supplier of `pushWarning`, for in-process sub-query
dispatch. So the correct claim is *"the warning reaches deep-search's collector and no MCP caller."*
Even there it is transient: `gather-evidence.ts:274-276` converts each warning into an
`emit('warning', …)` progress event and stores it on **nothing**, so it is absent from
`EvidenceResult` too. No response object in the repo carried it.

### What was built instead

The signal now travels **in-band on the result**, which `mcp-server.ts:222` serialises verbatim:

```ts
retrieval: {
  searchModeRequested, searchModeEffective,   // 'hybrid' → 'keyword' on embed failure
  vectorSearchApplied,                        // false when the query was never embedded
  rerankApplied, rerankSkipReason, rerankPoolIn,
}
warnings: string[]                            // [] when healthy
```

`warnings[]` matches the field name and contract `scan_for_pattern` already uses, rather than
inventing a third vocabulary for the same idea. The `pushWarning` call at `:251` is **kept** — it
still feeds the deep-search collector — and is now paired with the in-band write.

`searchMode: 'vector'` still throws coded `EMBEDDING_UNAVAILABLE` and `'keyword'` is not treated as a
degradation, since it was what the caller asked for. The tool description was updated (version
`1.5.0`) so a model calling it is told to read both fields before concluding absence.

Pinned by `src/lib/mcp/tools/__tests__/query-case-knowledge-degraded.test.ts` — including the case
that motivates the whole task: a degraded empty result and a healthy empty result are now
distinguishable, where before both were `{results: []}`.

**`research_evidence`** has the same shape on `tier`: `fast` is one retrieval with no outline,
`deep`/`deep-report` add rerank, and only `deep-rlm` uses the RLM role. Its declared dependency today
is `localLlmDependency()` alone (`:150-151, :226-227`).

**Consequence for stage 2.** `ToolDependency.check` is `() => Promise<boolean>` — it receives **no
call parameters**, so it cannot express "needs embedding unless `searchMode` is `keyword`". Making
role deps `required: true` therefore cannot be a blanket flip; it is only correct for roles a tool
needs on *every* call. The conditional cases need a **separate per-call admission check** at the
point of use, which is a different mechanism with a different failure signal, and should be scoped as
its own task rather than bent into this one.

This is the same defect the series keeps finding, one layer up: **the readiness mechanism describes
the tool more precisely than it describes the call.**

### Cost note

`checkRoleAvailability` is uncached. `refreshDependencies` runs deps in parallel, so N declaring
tools mean N `getAllSidecarStatuses()` calls per refresh — an in-memory `Map` walk, no probe, cheap.
The `unavailable` path additionally hits `prisma.config.findMany` once per declaring tool via
`hasDirectHost`. Bounded and rare, but add a memo if item 5's successor declares roles widely.

## Risks

- **`UNREPORTED` is not `down`.** A host that declares a container and returns no status is telling
  you nothing about it. Three wrong "role X does not exist" conclusions were drawn from unreported
  hosts in one session. A readiness gate that treats silence as failure will close tools that work.
- **A synthetic `running` is not a probe.** The sidecar emits `'running'` for host-runtime and DMR
  roles by assumption, and there is **no declared status union at all** — `statusCache.ts` types it
  bare `string`, with observed literals `'running' | 'not_found' | 'error'`. Do not build a
  seven-state vocabulary on top of three literals and an assumption without deciding what the
  synthetic value becomes.
- **Retiring the global will surface failures that were previously invisible.** Tools that reported
  ready while their role was down will start reporting `notReady`. That is the fix working; expect
  the first output to look like a regression.
- **Do not make readiness a live probe per call.** `isToolReady` is on the hot path. Cache, with a
  stated TTL (item 4).
- **Scope discipline.** This task makes readiness role-aware. It does **not** add a fleet tool
  ([task 30](./30-mcp-parity-and-fleet-visibility.md)) or change any timeout
  ([task 38](./38-interactive-embedding-budget.md)). Both become straightforward afterwards, which is
  the argument for doing this first.

## Acceptance

| Check | Expected |
|---|---|
| Completion host down, embedding up | embedding-only tools **ready**; completion tools `notReady` naming the completion role |
| A vLLM role exited | tools depending on it are `notReady` naming that role — the case that currently reads `[]` |
| Embedding host down, `searchMode: 'hybrid'` | the caller learns the vector leg was missing — not a silent success |
| Embedding host down, before the call | `isToolReady` is **false** for `query_case_knowledge`, which today returns `{ready: true}` |
| An unreachable host | reported `unknown`, not `down`; the readiness call still returns promptly |
| A shared-Ollama role on 11434 | **not** reported as drift or failure |
| `notReady` | never empty while a required role is genuinely down |
| `tool-registry.ts` | no `ollamaUp` gate; no `toolNeedsLlm` |
| `corpus_status` | still answers on a degraded fleet — now because it declares no role dependency, not because of its `category` |
| Comment vs constant | agree on the cache TTL |

## Why this is the prerequisite

- **[Task 30](./30-mcp-parity-and-fleet-visibility.md) Part 3** — a `fleet_status()` cannot report
  role health the registry has no way to express. Its priority should rise from P2 alongside this.
- **[Task 38](./38-interactive-embedding-budget.md)** — per-role budgets need per-role identity, and
  §5's amendments assume roles are first-class.
- **[Task 22](./22-rerank-observability.md)** — a degraded reranker is currently indistinguishable
  from a working one in the response; role readiness is the other half of that answer.

## References

- `src/lib/mcp/tool-registry.ts:47, 60, 108-133, 155-157, 167-172, 175-180, 220, 223`
- `src/lib/mcp/tool-types.ts:65-74` · `src/lib/mcp/tools/base-tool.ts:83-86`
- `src/lib/mcp/shared-dependencies.ts:197-252`
- `src/lib/gpu/fleet-router.ts:601,606,611` (shared-Ollama rewrite), `:874-879` (stale `ROLE_PORTS`), `:895-897` (prefers live config)
- `src/lib/ingestion/ollama-embedding-provider.ts:174-182, 272-274` — per-request acquire/release
- `sideCar/src/lib/state.ts:59+` (role registry), `:412` (no vLLM `/api/ps`)
- `sideCar/src/lib/ollama-api.ts:82` · `sideCar/src/lib/host-ollama-watchdog.ts:31-32`
