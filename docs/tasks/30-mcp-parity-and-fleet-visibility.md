# Parameter parity between tools, and read-only fleet visibility

**Status:** **Part 3 built 2026-09-09** (items 3–6 done); item 1 blocked on file territory, item 2 decided · **Effort:** S · **Priority:** **P1** (raised from P2) · **Created:** 2026-09-08
**Blocked by:** ~~[task 39](./39-role-aware-readiness.md)~~ — unblocked: task 39 stage 1 shipped `checkRoleAvailability` / `roleDependency` (`src/lib/mcp/shared-dependencies.ts:394-489`) with a three-outcome result. See §REFUTED premises (ii) for a defect found in it while building on it.
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §5, §6 item 10

> **Provenance.** The parity gaps are verified by grep. The `multiPass` framing in v12 is **wrong** —
> corrected below. The fleet tools are unbuilt and unverified.

Field names and code citations only. No case data.

## Part 1 — parameter parity

**Verified:** `searchMode` and `recordStatus` are declared on `query_case_knowledge`
(`src/lib/mcp/tools/query-case-knowledge.ts:188`) and appear **nowhere** in
`src/lib/mcp/tools/research-evidence.ts` — grep returns zero hits for both.

v12 calls this "an asymmetry with no evident reason", and nothing in the source contradicts that. It
is a small, additive fix: declare both on `research_evidence` and thread them through to the same
retrieval call.

## Part 2 — `multiPass`, and the correction

v12 §5 says *"`multiPass` is absent from MCP entirely"* and concludes that *"multipass retrieval — the
thing a reranker is most useful for — cannot be requested from MCP at all."*

**`multiPass` is not a retrieval parameter.** It is a **synthesis** switch —
`src/lib/search/deep-search.ts:2284`:

```js
multiPass ? generateReportMultiPass : generateReport
```

It selects how the *report* is generated, not how evidence is retrieved. It is exposed on exactly one
MCP schema: `src/lib/mcp/tools/routed-routing-explain.ts:49`.

So the report's inference does not follow: the reranker's usefulness is unrelated to this flag. The
real reranker gap is [task 22](./22-rerank-observability.md), and the real "is multipass retrieval
possible" question is `deep-rlm`'s RLM rounds — which, per task 22, are **not reranked at all**.

That leaves a genuine but different question: should `multiPass` be requestable on the report tools?
Decide it on its own merits, not as a reranker issue.

## Part 3 — fleet visibility

Writing v12 required reading `/api/admin/gpu-fleet` in a browser pane because **no tool exposes it**.
Two read-only tools would close that:

- `fleet_status()` — host reachability, role assignments, VRAM where known
- `role_assignments_list()` — which role runs where

`role_assign()` **mutates machine state** and belongs behind the same profile discipline the
cloud-provider boundary already gets. v12 says this and it is right; this task proposes the two
read-only tools only.

**This is not hypothetical plumbing.** During this session the rerank host was confirmed live by
probing `10.10.20.5:8099` directly from a shell — HTTP 200 in 0.37 s on `/v1/models`. A caller with
`fleet_status()` would not have needed a shell. And per [task 22](./22-rerank-observability.md), a
silently degraded reranker is invisible in the response, so fleet health is currently the *only* way
to distinguish a real rerank from a fallback.

### Amendments — 2026-09-09, from [report v15](../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md) and [task 38](./38-interactive-embedding-budget.md) §5

Four, and the first changes what this tool *is*.

**(a) It must probe, not relay.** The sidecar queries Ollama roles live (`/api/tags`, `/api/ps` —
`sideCar/src/lib/ollama-api.ts:82`) but has **no equivalent for vLLM**: `sideCar/src/lib/state.ts:412`
says verbatim that vLLM *"doesn't expose a per-model size endpoint like Ollama's `/api/ps`"*, so it
infers liveness from `nvidia-smi` PID attribution. The two vLLM roles are **`ss-reranker` and
`ss-rlm`** — exactly the ones whose health cannot otherwise be asserted. A `fleet_status()` that
re-serves container state through MCP reproduces the `notReady` defect: green while the path is sick.
Requirement: a bounded `GET /v1/models` per vLLM role, one short per-host timeout, host reported
`unknown` on timeout.

**(b) Encode the role→port map once — it currently exists three times and they disagree.**

| Where | Roles | Note |
|---|---|---|
| `sideCar/src/lib/state.ts:59+` | 6 (embedding 11434, completion 11435, ocr 11436, code-embedding 11437, reranker 8099, rlm 8100) | the authority |
| `src/lib/gpu/fleet-router.ts:874-879` | **4** — missing `code-embedding` and `rlm` | docstring `:873` says *"must match sideCar/server.js registry"* — **that file no longer exists** |
| `src/lib/ai/stream-rlm.ts:53` | 1 — `RLM_PORT = 8100` hardcoded | the value the master's own map omits |

`resolveEndpoint` (`fleet-router.ts:895-897`) already prefers sidecar-reported config over the
constant, so the stale map is a fallback rather than the live path — which makes consolidating it
low-risk, and makes leaving it a trap that will not fail loudly.

**A shared Ollama answers on 11434 regardless of role, and this is encoded** —
`fleet-router.ts:601,606,611` rewrite host-runtime Ollama roles to `port: 11434`. **Never report it
as drift.**

**(c) `UNREPORTED` is not `down`.** A host that declares a container and returns no status is telling
you nothing about it; three wrong "role X does not exist" conclusions came from that confusion in one
session. Distinguish `running` / `exited` / `unloaded` / `not_pulled` / `created` / `unreported` /
`unreachable`, and never collapse the last two.

⚠️ **This costs more than widening an enum.** There is **no declared status type today** —
`statusCache.ts` types it bare `string`, the observed literals are `'running' | 'not_found' |
'error'`, and host-runtime/DMR roles get a **synthetic `'running'`** the sidecar assumes rather than
probes. Six of the seven states would be invented, and the synthetic value needs an explicit decision:
a role reported `running` because nothing checked must not keep saying `running` under a vocabulary
that promises probes.

**(d) It is blocked by [task 39](./39-role-aware-readiness.md).** Readiness is currently one cached
boolean from a completion-only probe, so the registry has no way to express per-role health. A fleet
tool reporting what the registry cannot represent would be a second, parallel source of truth.
Priority raised to P1 for the same reason task 39 is: this is the only way to distinguish a real
rerank from a fallback.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Declare `searchMode` and `recordStatus` on `research_evidence` and thread them through. Match `query_case_knowledge`'s semantics exactly — a parameter that means something subtly different under the same name is worse than its absence. | ☐ **blocked — spec below, §Part 1 plumbing** |
| 2 | Decide explicitly whether `multiPass` should be requestable on the report tools, on synthesis grounds. Record the decision either way. | ☑ **decided — see §Item 2** |
| 3 | Add `fleet_status()` — read-only, `category: 'search'` so it answers on a degraded fleet (see [task 23](./23-corpus-status-and-denominators.md) for why that declaration is load-bearing). | ☑ `src/lib/mcp/tools/fleet-status.ts` |
| 4 | Add `role_assignments_list()` — read-only. | ☑ `src/lib/mcp/tools/role-assignments-list.ts` |
| 5 | **Do not add `role_assign()` in this task.** If it is wanted, it is a separate task with its own profile and auth discussion. | ☑ not added |
| 6 | Cross-reference from [task 22](./22-rerank-observability.md): once `rerankApplied` exists in responses, fleet status stops being the only way to tell. Note which is authoritative. | ☑ **see §Item 6** — task 22 still needs the reciprocal note |

---

## Implementation notes — 2026-09-09

### Premises re-verified against source

Every factual claim above was re-checked before any code was written. These held:

- `searchMode` / `recordStatus` on `query_case_knowledge:188`, absent from `research-evidence.ts` — ✅.
- `multiPass` as a synthesis switch at `deep-search.ts:2284` — ✅ (and see §Item 2 for what v12 *also* got wrong).
- Amendment (b)'s three-way port map disagreement — ✅ all three confirmed:
  `sideCar/src/lib/state.ts:59+` (6 roles; `rlm` at `:128-131`, port 8100),
  `fleet-router.ts:874-879` (**4** roles), `stream-rlm.ts:53` (`RLM_PORT = 8100`).
  The docstring at `fleet-router.ts:873` does say *"must match sideCar/server.js registry"*
  and `sideCar/server.js` **does not exist** — ✅.
- The shared-Ollama 11434 rewrite at `fleet-router.ts:601,606,611` — ✅, and it is **not** drift.
- Amendment (a)'s verbatim quote — ✅ at `sideCar/src/lib/state.ts:410-412`.
- Amendment (c)'s ⚠️ warning that six of seven states do not exist — ✅. `containers[role].status`
  is typed bare `string` (`status-cache.ts:21`).
- `GpuRole` (`fleet-router.ts:153`) omits both `rlm` and `code-embedding` — ✅.

### REFUTED premises

**(i) `multiPass` is not "absent from MCP entirely" on the research surface.** v12 says so and
Part 2 above repeats the framing. In fact `research-params.ts:23` lists `multiPass` in
`STEERING_KEYS`, so `research_evidence` / `research_start` **already accept it and explicitly
report it in `routing.ignored[]`** (`:144-146`). The item-2 question was therefore never "should
we add it" but "should we keep ignoring it". Decided below.

**(ii) `checkRoleAvailability` can return `unavailable` for a fleet that has gone entirely
silent.** Found while reusing task 39 stage 1; **not fixed — `shared-dependencies.ts` was
read-only for this task.** `getAllSidecarStatuses()` (`status-cache.ts:230-232`) is a bare
`Array.from(cache.values())` with **no staleness filter**, unlike its siblings
`findSidecarsWithRole` (`:267`) and `isSidecarConnected` (`:241`), which both filter on
`STALE_THRESHOLD_MS`. Trace `checkRoleAvailability('reranker')` against a cache holding only
stale entries (`shared-dependencies.ts:394-457`):

1. `findSidecarsWithRole('reranker','running')` → `[]` — stale entries filtered out.
2. `getAllSidecarStatuses()` → `length > 0` — stale entries **not** filtered.
3. The `all.length === 0` branch (`:439`) is skipped, so its basis string — *"no sidecar has
   reported within the staleness window"* — never fires, even though that is exactly the
   situation.
4. `hasDirectHost('reranker')` → `false`; `DIRECT_HOST_ROLES` (`:366-371`) has no vLLM entry.
5. Returns **`unavailable`** (`:453`), basis *"N sidecar(s) reporting, none with 'reranker'
   running"*.

A fleet that has stopped heartbeating altogether reports `reranker: unavailable`. That is the
"UNREPORTED is not down" rule violated inside the code written to enforce it, and the `:442`
basis string claims a staleness semantics the call does not have. Harmless today only because
`roleDependency` ships `required: false`; it becomes a live refusal the moment that flips.
**Fix belongs in task 39** — either filter by `lastSeen` in `checkRoleAvailability`, or add a
staleness-filtering accessor to `status-cache.ts`. This is why both new tools compute
`staleMs` themselves rather than treating membership in `getAllSidecarStatuses()` as "connected".

### Item 2 — decision on `multiPass`: keep ignoring it. Do not expose it on `research_*`.

`multiPass` selects `generateReportMultiPass` vs `generateReport` (`deep-search.ts:2284`) — it
governs **how a report is written**. `research_evidence` and `research_start` return evidence and
never synthesise prose; their own description says so verbatim. A synthesis switch on a tool that
never synthesises is a knob with no referent, which is worse than its absence: a caller that sets
it reasonably concludes something changed. The current behaviour — accepted, ignored, and *named*
in `routing.ignored[]` — is already the honest handling, and it is what ships.

The live question is only whether the **`report_*` / `research_report`** tools should expose it.
That is out of scope here (they are routed-profile tools with their own cost and policy surface)
and is not a reranker question: v12 inferred *"multipass retrieval — the thing a reranker is most
useful for — cannot be requested from MCP at all"*, and that inference does not follow, because
the flag never touched retrieval. The real reranker gap is [task 22](./22-rerank-observability.md).

### Item 6 — which signal is authoritative

Two different questions; neither substitutes for the other, and this is carried in
`fleet_status`' own payload (`notes[0]`, from `roleAuthorityNote()`) rather than left to memory:

| Question | Authority |
|---|---|
| Was the rerank path reachable at `observedAt`? | `fleet_status().hosts[].roles[].probe` |
| Did the reranker actually run **on this call**? | task 22's `rerankApplied` (unbuilt) |

A reachable host that timed out mid-request still yields first-stage order, so `probe: 'ok'` has
never been evidence a rerank happened. Conversely `rerankApplied: false` does not say *why*, and
fleet reachability is what answers that. **Task 22 needs the reciprocal note** — it is in another
agent's territory and was not edited here.

### Part 3 — what was built

`src/lib/mcp/tools/fleet-status.ts` and `src/lib/mcp/tools/role-assignments-list.ts`, registered
in `src/lib/mcp/tools/index.ts`. Both `category: 'search'`, both `profiles: ['local']` **stated
explicitly** (an absent `profiles` means *both* — `tool-types.ts:56-58` — which is precisely the
infrastructure leak the Risks section names), and both declare **zero dependencies**: a tool whose
job is reporting fleet degradation must not refuse because the fleet is degraded.

**Amendment (a) — probes, does not relay.** `fleet_status` issues a live `GET /v1/models` against
every role whose reported runtime is vLLM. Roles are selected by `type === 'vllm'` /
`vram.perRole[role].runtime === 'vllm'`, **not** by a hardcoded `['reranker','rlm']` pair, so a
future vLLM role is probed without an edit. Ollama roles are deliberately not probed — the sidecar
already queries those live via `/api/tags` and `/api/ps`, so its reported status for them is an
observation, and duplicating it here would create a second source of truth. Each probe carries its
own `AbortSignal.timeout` (default 2500 ms, clamped 250–10000); all probes run under one
`Promise.allSettled`, so wall clock is bounded by the single longest probe, not by host count.
Tested: four never-answering targets at a 300 ms budget complete under 1000 ms.

**Amendment (b) — no fourth port map.** The map exists three times too many already; a fourth
copy in a new file, consulted precisely when the sidecar told us nothing, would be worse than the
trap it patches. Ports come only from `containers[role].config.port ?? containers[role].port`. An
unreported port yields `port: null`, `portSource: 'unreported'` and `probe: 'not_attempted'` with
a reason — never a guess. Two Ollama roles sharing 11434 on one host are flagged
`sharedOllamaPort: true` and excluded from drift detection; genuine drift (the same role on
different ports across Docker-runtime hosts) is reported in `role_assignments_list().notes`.
**Consolidating the three existing maps still needs `fleet-router.ts:874-879`** — `src/lib/gpu/**`
was out of territory for this task.

**Amendment (c) — the seven-state enum was deliberately NOT built.** Amendment (c) asks for
`running`/`exited`/`unloaded`/`not_pulled`/`created`/`unreported`/`unreachable` and then warns in
its own ⚠️ that six of the seven do not exist upstream. Inventing five values nothing produces is
the same "green because nothing checked" defect in new costume. Instead each role carries four
**orthogonal** fields that are never collapsed into one verdict:

| Field | Meaning |
|---|---|
| `reported` | the sidecar's own status string, **verbatim and unmapped** (`'running'`/`'not_found'`/`'error'` are what exist) |
| `reportedSynthetic` + `syntheticBasis` | the sidecar **assumed** that status rather than observing it — detected from `image` (`host-ollama`, `dmr`), not from a role list |
| `staleMs` / `stale` on the owning host | how old the heartbeat carrying it is |
| `probe` + `probeDetail` + `probeModels` | what **this call** saw on the wire: `ok` / `http_error` / `timeout` / `unreachable` / `not_attempted` |

This settles the synthetic-`running` decision by **labelling** it rather than laundering it: a
role reported `running` because nothing checked is still reported `running` — with
`reportedSynthetic: true`, a basis string, and a summary note. `unreported` and `unreachable`
never share a field: a host that says nothing about a role appears in `roles[].notReportedBy` and
contributes to **no** probe bucket and **no** reachability count. An unreadable cache and an empty
fleet each produce an explicit note saying the report is an absence of information, not evidence
anything is down.

`probeModels` reports the ids `/v1/models` returned without asserting they match the role's
configured model. A 200 serving the wrong model is a real failure mode, and the caller is better
placed to judge it than a hardcoded comparison here.

**Runtime detection is three-valued for the same reason.** `resolveRoleRuntime()` returns
`undefined` rather than "not vLLM" when nothing was reported: `containers[role].type`,
`config?.type` and the whole `vram` block are each optional (`status-cache.ts:26,32,40`), so a
sidecar can report `{status:'running', name:'ss-reranker', port:8099}` and declare no runtime at
all. A boolean `isVllmRole()` would have told that caller, in an output field, that the status
"is an observation, not an inference" — silence turned into a positive claim, inside the tool
built to stop that. `runtimeReported` is carried beside `runtime` for the same reason
`reportedSynthetic` is carried beside `reported`. The same guard applies to `sharedOllamaPort`:
port 11434 with no reported runtime counts as shared rather than as drift.

**Tests:** `src/lib/mcp/tools/__tests__/fleet-status.test.ts` — 39 cases, `@jest-environment node`,
`fetch` and both dynamically-imported modules mocked locally (no global mocks exist in this repo).
Beyond the acceptance table's host-up / host-down cases it covers the ones a naive implementation
passes by accident: a **stale** cache entry (labelled *and still probed*), a role with **no
reported port**, a **synthetic `running`**, an **unmapped status string**, a host that **never
mentions** the role, an **unreadable cache**, shared-Ollama 11434 **not** counted as drift, and an
explicit **wall-clock bound** against targets that never answer. Both tools opt into
`rejectsUnknownParams()`, and that guard lives in `BaseMCPTool.execute` rather than `executeImpl`,
so four cases drive the real entry point to exercise it.

### Part 1 — the exact patch, and why none of it was landed

Item 1 is a **six-edit change across five files**. Two of those files were granted
(`research-params.ts`, `research-types.ts`); the two that carry the hardcoded value
(`gather-evidence.ts`, `deep-search.ts`) were not, pending a territory answer.

**Nothing was landed, including the granted half — deliberately.** The granted files are the
*middle* of the chain, not a safe prefix of it. `parseResearchParams` currently **throws
`INVALID_PARAMS` naming the key** for any top-level param outside `ALLOWED_TOP_LEVEL_KEYS`
(`research-params.ts:132-142`). Adding `searchMode` / `recordStatus` to that set without the
downstream threading replaces a clear 400 with **silent acceptance and a silent drop** — the
caller sends `recordStatus: 'filed'`, gets 200, and reasonably believes drafts were excluded when
nothing filtered. That is strictly worse than today's absence, and it is the same
"knob that had no effect" class as the `jest.setup.js` that never ran. **Land all six edits
together or none.**

Line numbers below were re-verified against the working tree on 2026-09-09 (they had already
shifted from the first pass — other work is live in both search files).

#### Edit 1 — `src/lib/mcp/tools/research-evidence.ts`, `RESEARCH_INPUT_SCHEMA` (`:22-91`)

Add two properties beside `whereClauses` (`:46-50`). Copy the descriptions from
`query-case-knowledge.ts:130-142` **verbatim** — a parameter that means something subtly
different under the same name is worse than its absence — then add the fan-out sentence, which is
the one true difference between the tools:

```ts
searchMode: {
  type: 'string',
  enum: ['vector', 'hybrid', 'keyword'],
  description:
    'Search mode: vector, hybrid, or keyword (default: hybrid). Applied to EVERY sub-query '
    + 'this tool dispatches, including the RLM evidence rounds in deep-rlm.',
},
recordStatus: {
  type: 'string',
  enum: ['filed', 'draft', 'any'],
  description:
    'Filter by record status: "filed" returns only chunks from documents with a recognised '
    + 'court file stamp, "draft" returns only unfiled working copies, "any" (default) returns '
    + 'both. Drafts are always labelled in results. Applied to every sub-query.',
},
```

#### Edit 2 — `src/lib/mcp/research/research-params.ts`

Three changes. Both params are **enum strings**, so they cannot ride `parseRetrievalSettings` —
that helper runs `positiveInt` over every key (`:88-96`) and would drop them silently.

- `:45-48` — add both to `HONOURED_TOP_LEVEL_KEYS`. They belong at the top level, not under
  `retrieval`: that object is numeric knobs and `RETRIEVAL_KEYS` (`:25-30`) is typed
  `(keyof RetrievalSettings)[]`.
- Add a validating parser beside `parseResearchMode` (`:98-103`), which is the pattern to copy —
  it throws `INVALID_PARAMS` on a bad value rather than silently defaulting:

```ts
const SEARCH_MODES = ['vector', 'hybrid', 'keyword'] as const;
const RECORD_STATUSES = ['filed', 'draft', 'any'] as const;

function parseEnum<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new McpError('INVALID_PARAMS', `${field} must be one of ${allowed.join(', ')}`);
}
```

- `:187-195` — carry them into `options`, same conditional-spread style as the rest:

```ts
...(searchMode ? { searchMode } : {}),
...(recordStatus ? { recordStatus } : {}),
```

Do **not** add them to `STEERING_KEYS`. That set means "accepted and deliberately ignored"
(`:144-146` pushes each into `routing.ignored[]`); these are its opposite.

#### Edit 3 — `src/lib/mcp/research-types.ts`, `GatherEvidenceOptions` (`:268-287`)

```ts
/** Retrieval mode for every sub-query. Same semantics as query_case_knowledge. */
searchMode?: 'vector' | 'hybrid' | 'keyword';
/** Record-status filter for every sub-query. Same semantics as query_case_knowledge. */
recordStatus?: 'filed' | 'draft' | 'any';
```

Beside `whereClauses` (`:275`), **not** inside `RetrievalSettings` — same coercion reason as
Edit 2.

#### Edit 4 — `src/lib/search/deep-search.ts`, `executeParallelSearches` (`:483-509`)

The signature is already seven positional parameters, four of them optional, and
`gather-evidence.ts:349` passes seven in a row. **Do not add two more positionals** — a caller
that transposes two of nine will not fail loudly. Add a trailing options object:

```ts
export async function executeParallelSearches(
  subQueries: ReadonlyArray<string | SubQuerySpec>,
  caseId: string | undefined,
  registry: ToolRegistry,
  pushWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void,
  chatId?: string,
  limitPerSubQuery: number = 50,
  caseIds?: string[],
  /** Retrieval params threaded from the caller. Absent = today's defaults. */
  retrievalParams?: { searchMode?: 'vector' | 'hybrid' | 'keyword'; recordStatus?: 'filed' | 'draft' | 'any' },
): Promise<SubQueryResult[]> {
```

Then at `:507-508`:

```diff
         limit: limitPerSubQuery,
-        searchMode: 'hybrid',
+        searchMode: retrievalParams?.searchMode ?? 'hybrid',
+        ...(retrievalParams?.recordStatus ? { recordStatus: retrievalParams.recordStatus } : {}),
```

`searchMode` keeps its literal default so the **second** caller — `:2118-2124`, the dashboard
deep-search path, which passes only five arguments — is unchanged. `recordStatus` is spread
conditionally rather than defaulted to `'any'`: `query_case_knowledge` already defaults it at
`:188`, so sending it explicitly would only bloat the params of every existing call.

#### Edit 5 — `src/lib/search/deep-search.ts`, the RLM round path

**This is the edit most likely to be skipped, and skipping it is the defect.** `:1805` hardcodes
`searchMode: 'hybrid'` in a *second*, independently-built `query_case_knowledge` payload
(`:1795-1807`) that the RLM agent drives during `deep-rlm`. Thread only Edit 4 and the parameter
is honoured in phase 1 and silently dropped during the RLM rounds.

Add to `RlmEvidenceRoundsOptions` (`:1601-1622`), beside `inheritedWhereClauses`:

```ts
searchMode?: 'vector' | 'hybrid' | 'keyword';
recordStatus?: 'filed' | 'draft' | 'any';
```

and apply the same two-line diff at `:1805` with `options.` in place of `retrievalParams?.`.

#### Edit 6 — `src/lib/search/gather-evidence.ts`, both call sites

- `:348-350` — pass the new options object as the 8th argument:

```diff
-    executeParallelSearches(scopedSpecs, options.caseId, registry, pushWarning, options.chatId, limitPerSubQuery, options.caseIds),
+    executeParallelSearches(scopedSpecs, options.caseId, registry, pushWarning, options.chatId, limitPerSubQuery, options.caseIds,
+      { searchMode: options.searchMode, recordStatus: options.recordStatus }),
```

- `:451-459` — the `runRlmEvidenceRounds` call. Add beside `caseIds` / `chatId`:

```ts
searchMode: options.searchMode,
recordStatus: options.recordStatus,
```

#### Semantics, and what must be measured

- **`recordStatus` reaches Lance as a hard filter.** `query-case-knowledge.ts:358-360` sets
  `searchQuery.filter.recordStatus` only for `'filed'` / `'draft'`; `'any'` applies nothing
  (`vector-store.ts:998`). Threading it changes *which documents come back* — the Risks section is
  right that this is a **behaviour change, not a schema change**. The acceptance check *"the same
  query through both tools → comparable filtering behaviour"* must be measured on the same query
  before and after, not inferred from the schema.
- **`searchMode: 'keyword'` is not just a filter.** `query-case-knowledge.ts:212` skips the
  embedding call entirely when `searchMode === 'keyword'`; across an N-sub-query fan-out that is a
  latency and cost change as well as a recall change. Conversely `'vector'` makes an embedding
  failure fatal — `:252-257` rethrows `EMBEDDING_UNAVAILABLE` instead of falling back to FTS, so a
  `research_evidence` call that would have degraded to keyword now fails outright. Both are
  correct (they are `query_case_knowledge`'s semantics, which is the point), and both belong in
  the tool description, as Edit 1 does.
- **Tests to add:** a rejected bad enum value out of `parseResearchParams`; `options.searchMode`
  reaching the `query_case_knowledge` payload of **both** call sites, asserted against a mocked
  registry — the RLM-round assertion is the one that catches a half-threaded implementation; and
  `recordStatus` **absent** from the payload when the caller omits it.

## Risks

- **A fleet tool leaks infrastructure detail into an MCP surface** that a routed profile may expose to
  a cloud model. Decide the profile deliberately — `local`-only is the safe default.
- **Timeouts.** `fleet_status()` probing unreachable hosts must bound its wall clock and report a host
  as unknown rather than hanging. The reranker's own 90 s batch timeout
  (`src/lib/search/reranker.ts:190-192`) is the cautionary example.
- **Parity work can silently change behaviour.** Threading `recordStatus` into `research_evidence`
  changes which documents it returns. That is the point, but it is a behaviour change, not a schema
  change — measure before and after.
- **Do not present fleet reachability as proof rerank ran.** A reachable host that timed out mid-call
  still yields first-stage order. Only task 22's `rerankApplied` settles it.

## Acceptance

| Check | Expected |
|---|---|
| `research_evidence` schema | declares `searchMode` and `recordStatus` with `query_case_knowledge`'s semantics |
| The same query through both tools | comparable filtering behaviour |
| `fleet_status()` with every host up | roles, hosts and VRAM where known |
| `fleet_status()` with a host down | that host reported unreachable, bounded wall clock, no hang |
| Both tools | answer with Ollama unavailable |
| `multiPass` | decision recorded |

## References

- `src/lib/mcp/tools/query-case-knowledge.ts:188`
- `src/lib/mcp/tools/research-evidence.ts` — no `searchMode` / `recordStatus`
- `src/lib/search/deep-search.ts:2284` — `multiPass` as a synthesis switch
- `src/lib/mcp/tools/routed-routing-explain.ts:49` — its only schema exposure
- `src/lib/mcp/tool-registry.ts:145-147, 156-157, 177` — profile filter and the LLM gate
- `src/app/api/admin/gpu-fleet` — the endpoint with no tool
- [`06-mcp-two-profiles.md`](./06-mcp-two-profiles.md) — the profile discipline a mutating tool must meet
