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
| 3 | **Source the check from fleet state the master already holds, do not re-probe.** The master calls the sidecar per request on the data path (`ollama-embedding-provider.ts:174-182`), and `resolveEndpoint` (`fleet-router.ts:895-897`) already prefers sidecar-reported config over its own constants. A second probe from `src/lib/mcp/` would duplicate a cache one module away and the two would drift. | ☐ |
| 4 | **Establish the cache TTL before gating on it.** A readiness gate reading state staler than the decision it informs is a new instance of the defect this series keeps finding. The host-Ollama watchdog probes every 15 s (`host-ollama-watchdog.ts:31`); the master's own cache TTL is **not yet established** — settle it, and state it in the code. | ☐ |
| 5 | Declare roles on the tools that need them. Start with the ones whose failure is currently invisible: `query_case_knowledge` (embedding), `research_evidence` (embedding + completion), the rerank path (reranker), the RLM path (rlm). | ☐ |
| 6 | **Retire the global.** Delete the `!this.ollamaUp` branch at `:175-180` and `toolNeedsLlm` at `:155-157`. Keep the probe itself if it feeds the completion role's own dependency — it becomes one role's check rather than every tool's gate. | ☐ |
| 7 | **Do not let a role probe hang a readiness call.** Bounded per-host timeout; a host that does not answer is `unknown`, not `down`. | ☐ |
| 8 | Fix the doc drift found in passing: `tool-registry.ts:220` comments *"cached 30 s"*; the constant is **60 s**. | ☐ |
| 9 | Tests: a tool with an unsatisfied role dep is `notReady` **with that role named**; a tool needing only embedding is **ready** while completion is down; the previous behaviour (everything ready while a vLLM role is exited) is asserted **gone**. | ☐ |

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
