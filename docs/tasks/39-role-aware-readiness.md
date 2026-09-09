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
| 1 | **Confirm before building** (this repo's standing rule — four premises of v12 and three of v14 were refuted this way). Re-verify `tool-registry.ts:47,108-133,167-172,175-180` and `tool-types.ts:65-74` still read as above. | ☐ |
| 2 | Add a `roleDependency(role: FleetRole)` factory beside the existing `…Dependency()` helpers, returning `{ key: 'role:embedding', label: 'Embedding role', required: true, check }`. Match the existing convention exactly — a differently-shaped helper is worse than none. | ☐ |
| 3 | **Source the check from fleet state the master already holds, do not re-probe.** Confirmed: **nothing under `src/lib/mcp/` reads fleet state today** — grep for `fleet-router\|status-cache\|resolveEndpoint\|getFleetStatus\|getSidecarStatus` returns **zero hits**. The two modules to import are `@/lib/gpu/fleet-router` (`getFleetStatus()`, `resolveEndpoint(role)`, type `GpuRole`) and `@/lib/gpu/status-cache` (`getSidecarStatus(url)`, `isSidecarConnected(url)`, type `CachedSidecarStatus`). Both are server-only and already import prisma, so they are safe for `src/lib/mcp/` — but **must never reach the admin client bundle**, the same constraint that forced `model-capabilities.ts` to exist as a leaf module (`:5-8`). A second probe would duplicate a cache one import away and the two would drift. | ☐ |
| 4 | ~~Establish the cache TTL before gating on it.~~ **Answered — it is fresh enough.** Sidecars **push** their full `/status` to the master every **5 s** (`sideCar/src/lib/ws-client.ts:46 HEARTBEAT_INTERVAL = 5_000`, fired at `:973` HTTP / `:1061-1084` WS), landing in `status-cache.ts` as `CachedSidecarStatus` — per-role `status`, `loadedModels`, `config.port`, `gpuOnly`, `gpuReady`, `vram.perRole`, `idleTimeouts`. **Capability knowledge is inbound and continuous, not something the master polls.** Record the 5 s cadence in the check's comment so the next reader does not re-derive it. | ☑ settled |
| 5 | Declare roles on the tools that need them. Start with the ones whose failure is currently invisible: `query_case_knowledge` (embedding), `research_evidence` (embedding + completion), the rerank path (reranker), the RLM path (rlm). | ☐ |
| 6 | **Retire the global.** Delete the `!this.ollamaUp` branch at `:175-180` and `toolNeedsLlm` at `:155-157`. Keep the probe itself if it feeds the completion role's own dependency — it becomes one role's check rather than every tool's gate. | ☐ |
| 7 | **Do not let a role probe hang a readiness call.** Bounded per-host timeout; a host that does not answer is `unknown`, not `down`. | ☐ |
| 8 | Fix the doc drift found in passing: `tool-registry.ts:220` comments *"cached 30 s"*; the constant is **60 s**. | ☐ |
| 9 | Tests: a tool with an unsatisfied role dep is `notReady` **with that role named**; a tool needing only embedding is **ready** while completion is down; the previous behaviour (everything ready while a vLLM role is exited) is asserted **gone**. | ☐ |
| 10 | **Decide what a silent degrade owes the caller**, and verify the existing signal reaches them. `query_case_knowledge` already calls `pushWarning({ source: 'embedding', reason: 'embed-failed' })` (`:251-256`) before falling through to keyword-only — but whether that warning survives to the MCP response is **unsettled**. Trace it. If it does not surface, a caller cannot distinguish a thin result from a degraded one. Same question as [task 22](./22-rerank-observability.md) item 9. | ☐ |
| 11 | **`GpuRole` omits `rlm`** (`fleet-router.ts:153`), which is why `stream-rlm.ts:195-246` cannot use `resolveEndpoint` and walks `fleet.sidecars` by hand instead, matching `containers.rlm.status === 'running'` and skipping synthetic images. Adding `rlm` to the type is a prerequisite for expressing an RLM role dependency at all — and is the same omission as the missing `rlm` entry in `ROLE_PORTS` ([task 30](./30-mcp-parity-and-fleet-visibility.md) amendment (b)). | ☐ |

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
