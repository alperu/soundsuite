# MCP Report v15 — what the MCP server knows about sidecar LLMs, and what it only assumes

**Date:** 2026-09-09 · **Status:** report. Nothing built — **this is the next task to be scoped.**
**Question:** how does the MCP server learn which sidecar-hosted models/roles are available to it?
**Working folder:** [`../mcp/`](../mcp/README.md) · **Amends:** [task 30](../tasks/30-mcp-parity-and-fleet-visibility.md) Part 3

Field names and code citations only. No case data.

> **Provenance.** §2 and §3 are read from source and quoted. §4 was written while a source audit was
> still running and has since been **corrected by it** — the audit refuted this report's central
> open question, in a useful direction, and the correction is kept visible rather than edited away.
> The items still unverified are marked as such. §6 is design discussion, not a decision.

---

## 1. The short answer

**It does not know.** The MCP layer has two mechanisms that sound like they answer this question and
neither does:

| Mechanism | What it actually determines | What it does **not** |
|---|---|---|
| `model-capabilities.ts` | whether a **tag name/family** *could* do constrained-JSON text generation | whether that model is loaded, reachable, or on which host |
| `tool-registry.ts` readiness gate | one cached boolean: "is Ollama up" | which of the six roles is up; anything about vLLM at all |

So availability is represented by **a single boolean covering a fleet of six roles across two
runtimes.**

---

## 2. `model-capabilities.ts` answers a different question

Verified in full. It classifies a tag by *name and family*, to decide whether it can serve the local
profile's constrained-JSON steps (decompose, evidence outline):

```ts
export function isTextGenerationTag(tag: OllamaTagInfo): boolean {
  return !isEmbeddingTag(tag) && !isVisionTag(tag);
}
```

Three properties worth noting, all deliberate and all documented in the file:

- **It fails open.** *"A tag we cannot confidently identify as an embedding or a vision/OCR build is
  allowed through — hiding a usable model is worse than listing a doubtful one."* Correct for its
  purpose; it means the output is a **candidate list, not an availability list**.
- **It is a leaf module on purpose** — `routing-defaults.ts` imports `getConfig` → prisma, which
  cannot enter the browser bundle. So the classifier is deliberately isolated from anything that
  could probe a host.
- **Its input is `/api/tags` shape** (`OllamaTagInfo`), i.e. *what a host could load*, not what it
  has loaded. Ollama's `/api/ps` — what is resident **now** — is not consulted here.

**This module is doing its job.** It is named for capability and it reports capability. The gap is
that nothing else answers availability, so this is the closest thing and gets read as more than it
is.

---

## 3. The readiness gate is one boolean for six roles

`src/lib/mcp/tool-registry.ts:155-157`:

```ts
private toolNeedsLlm(tool: BaseMCPTool): boolean {
  return tool.getMetadata().category !== 'search';
}
```

and the gate it feeds:

```ts
if (profile === 'local') {
  const tool = this.tools.get(toolName);
  if (tool && this.toolNeedsLlm(tool) && !this.ollamaUp) {
    reasons.push(ollamaUnavailableReason(this.ollamaState));
  }
}
```

Three consequences follow, and the third is the important one.

**(a) Readiness is binary and global.** `this.ollamaUp` is a single cached value. A tool that needs
only the *completion* role is blocked when the *embedding* host is the one that is down, and vice
versa — and a tool needing the reranker is gated on an Ollama probe that says nothing about vLLM.

**(b) Readiness is a cached probe, not a live one.** `this.ollamaState` is consulted, not measured,
at call time. Under `local` the answer can therefore be stale in either direction: a host that
recovered still reads down, and a host that died still reads up.

**(c) The global is a second gate layered on top of a working one.**

An earlier draft of this report claimed *"a tool cannot currently say 'I need the completion role'"*
and that `category` was being overloaded to express a dependency. **That was wrong, and the truth
makes the fix smaller.**

A per-tool dependency mechanism already exists and is **already in use**:

| Piece | Where |
|---|---|
| `ToolDependency { key, label, required, check(): Promise<boolean> }` | `tool-types.ts:65-74` — an arbitrary async probe |
| `getDependencies()` — *"override to declare"* | `tools/base-tool.ts:83-86` |
| `refreshDependencies()` runs every check in parallel and caches | `tool-registry.ts:108-133` |
| `dependencyStatus: Map<toolName, {…, satisfied}[]>` | `tool-registry.ts:47` |
| `isToolReady()` already fails on an unsatisfied required dep, with a specific reason | `tool-registry.ts:167-172` |

And roughly nine tools already override it — `detect-contradictions.ts:87` declares
`[llmProviderDependency(), vectorStoreDependency()]`, `research-evidence.ts:150` declares
`[localLlmDependency()]`, and the same pattern appears in `track-claim-evolution`,
`reconstruct-timeline`, `detect-privilege`, `extract-obligations`, `compare-argument-structures` and
`analyze-tone`. There is even an established **helper** convention (`…Dependency()` factories) that a
`roleDependency('embedding')` would slot straight into.

So the defect is not a missing mechanism. It is that **the `ollamaUp` global is applied
unconditionally on top of it** (`tool-registry.ts:175-180`). A tool that declared its roles correctly
today would *still* be blocked by a completion-only probe that says nothing about vLLM.

`corpus_status` declaring `category: 'search'` is therefore not an abstraction being abused — it is
the only available escape from a blunt second gate. Both readings agree the workaround was correct;
they disagree about what to build, and the corrected reading is much cheaper:

> **Populate the mechanism that exists, and retire the global** — rather than design a new way to
> express dependencies.

---

## 4. The audit landed, and it moved the question

This section originally asked *"does the master ever call the sidecar at all?"* and called it the
open question everything else branched on.

**It was the wrong question.** Audited answer:

> The master calls the sidecar constantly. What is zero is **`src/lib/mcp/` → the fleet layer.**
> The gap is **intra-master**, not master↔sidecar.

That is a better problem than the one this report was written to describe. Nothing needs to be
built to reach the sidecar; the knowledge is already inside the process. The MCP layer simply does
not consult it.

**And it is not merely status polling — the master talks to the sidecar on the data path, per
request.** Verified call sites:

| Site | What it does |
|---|---|
| `ollama-embedding-provider.ts:174-182` | resolves `sidecarUrl` **per embedding request** via the fleet router, logging host, sidecar, model and excluded hosts |
| `ollama-embedding-provider.ts:272-274` | `releaseEndpoint('embedding', sidecarUrl)` |
| `ollama-ocr-engine.ts:130` | OCR host resolved via fleet-router |
| `reranker-lifecycle.ts:274` | pushes per-role idle timeouts, `minOnline` and container name **to the agent** |
| sidecar side | `/api/acquire`, `/api/release`, `/api/config`, `/api/status` |

**This has a consequence [task 38](../tasks/38-interactive-embedding-budget.md) does not yet
account for.** If an endpoint is acquired from the sidecar on every embedding call, then **sidecar
acquire time sits inside the interactive budget**. Task 38 §2 computes a ~370 s worst case purely
from Ollama's preflight/timeout/backoff constants; the real ceiling also includes whatever
`acquire` costs when a container must be started. That figure is therefore a **lower bound**, not
the total — which strengthens task 38's own instruction to instrument before tuning.

### Confirmed, with citations

**`model-capabilities.ts` is consumed by no MCP tool at all.** Its only two consumers are the admin
UI model picker (`src/components/admin-ai-services.tsx:21,313`) and a re-export at
`routing-defaults.ts:78`. So §2's "closest thing to an availability signal" is not even wired to the
MCP surface — it is an admin-UI filter.

**Model resolution is Ollama-direct against a single host string.** `routing-defaults.ts:84-85`
resolves one `ollamaCompletionHost || ollamaHost || OLLAMA_HOST`; `/api/tags` probed at 3 s
(`:80`), cached 60 s (`:81`). `localDecomposeModel` (`:127`) and `localOutlineModel` (`:156`) walk a
config → env → tag-match → default chain against that one host. **No role concept, no host tags, no
sidecar call.**

**The readiness probe only ever checks the completion role.** `ollamaReadiness()`
(`shared-dependencies.ts:197-252`) does `GET /api/tags` at 3 s plus a 5-token `POST /api/generate`
smoke at 10 s, cached 60 s with 2-strike hysteresis, re-probed on execute
(`tool-registry.ts:223`). **Embedding, OCR, reranker and RLM liveness are never checked anywhere on
the MCP surface.** That is the concrete form of §3(a): the one boolean is not merely coarse, it is
measured against a single role and applied to all six.

**`llm-policy.ts` pins provider identity, not availability.** It enforces `LOCAL_PROVIDER = 'ollama'`
under the `local` profile (`:42-50`) and throws `POLICY_VIOLATION` otherwise. Nothing there knows
whether the pinned provider is reachable.

**No MCP tool reports model or role availability.** Confirmed across the full tool set.

### A documentation drift found in passing

`tool-registry.ts:220` comments that the readiness result is *"cached 30 s"*; the constant is
**60 s**. Same class as the `rerankInteractiveTimeoutMs` disagreement in
[task 38](../tasks/38-interactive-embedding-budget.md) §4 (comment says 15000, code falls back to
30_000) — a stated default that the code contradicts, in the file a reader trusts. Worth fixing in
whichever task picks this up.

### The role→port map exists three times, and the copies disagree

This is the sharpest finding, and it is a fresh defect rather than a restatement.

| Where | Roles covered | Note |
|---|---|---|
| Sidecar `defaultRegistry` — `sideCar/src/lib/state.ts:59+` | **6** — embedding 11434, code-embedding 11437, completion 11435, ocr 11436, reranker 8099, rlm 8100 | the authority |
| Master `ROLE_PORTS` — `src/lib/gpu/fleet-router.ts:874-879` | **4** — missing `code-embedding` **and** `rlm` | docstring `:873` says *"must match sideCar/server.js registry"* — **that file no longer exists** |
| `src/lib/ai/stream-rlm.ts:53` | 1 — `const RLM_PORT = 8100` hardcoded | a third copy of the value the second copy omits |

So the master's own map is missing the RLM role, and the RLM port survives only as a hardcoded
constant elsewhere. The docstring instructing a reader to keep it in sync points at a **deleted
file** — a maintenance instruction that cannot be followed and will not fail loudly. Same defect
class as the frozen `~35,890` and `"byte-identical as of this commit"` removed earlier in this
series: *a statement that keeps reading as true after it stops being so.*

**Mitigating, and worth crediting:** the master already prefers live data over its own constant.
`resolveEndpoint` (`fleet-router.ts:895-897`) reads
`cached?.containers?.[role]?.config?.port` ahead of `ROLE_PORTS`. So the stale map is a fallback,
not the primary path — which is why this has not broken visibly.

**The shared-Ollama exception is encoded, not merely observed** — correcting task 38 §5(b), which
implies it may be folklore. `fleet-router.ts:601,606,611` rewrite every host-runtime Ollama role to
`port: 11434`, overriding 11435/11436.

### The status vocabulary is worse than "undefined" — it is untyped

Task 38 §5(c) asks for a status vocabulary distinguishing `running` / `exited` / `unloaded` /
`not_pulled` / `created` / `unreported` / `unreachable`.

**There is no declared union at all.** `statusCache.ts` types it as bare `string`. The literals
actually emitted are `'running' | 'not_found' | 'error'`, plus a **synthetic `'running'`** for
host-runtime and DMR roles — that is, a role can report `running` because the sidecar *assumed* it,
not because anything was probed. Any consumer distinguishing seven states would be inventing six of
them.

### The sidecar already publishes what the MCP layer needs

`GET /status` (`sideCar/src/app/api/status/route.ts` → `handleStatus`) returns a full snapshot:
containers, roles, VRAM, `hostOllama`, `dmr`. The host-Ollama watchdog probes every **15 s**
(`host-ollama-watchdog.ts:31`) and reconciles roughly every 60 s (`:32`), surfacing
`hostOllama: { enabled, host, roles[], budgetMb, lastHealth }` with a typed `HostOllamaHealth`
(`state.ts:271-279`).

So the data exists, is typed on the host-Ollama path, and is refreshed on a 15 s cadence. **Nothing
about this needs building — it needs consuming.**

### `:412` confirmed verbatim

`sideCar/src/lib/state.ts:412` — *"(which doesn't expose a per-model size endpoint like Ollama's
`/api/ps`)"* — and it justifies `gpuProcessCache` (`:413`), which maps `nvidia-smi
--query-compute-apps` PIDs to roles **precisely because vLLM has no `/api/ps`**. So vLLM role
liveness is inferred from GPU process attribution, not from asking the server.

### The near-miss tool

`routing_explain` (`routed-routing-explain.ts:72`) is the closest existing thing to a capability
report — but it is a dry run over **preset config**, and it is registered routed-profile-only
(`tools/index.ts:32-34`). **A `local` session has nothing.**

### Status of the task 38 §5 claims after this audit

Every item this report inherited unverified is now settled, and two needed amending:

| Claim (task 38 §5) | Verdict |
|---|---|
| Role→port map, six roles | **Confirmed** in the sidecar registry — and found to exist in three disagreeing copies (above) |
| Shared Ollama answers on 11434 | **Confirmed and encoded** (`fleet-router.ts:601,606,611`), not folklore — §5(b) understates it |
| vLLM has no `/api/ps` equivalent | **Confirmed verbatim** at `state.ts:412`; liveness comes from `nvidia-smi` PID attribution instead |
| A status vocabulary is needed | **Confirmed and stronger than stated** — there is no declared type at all, and one emitted value is synthetic |

### Still pending — the audit's section C

Three questions remain open, and they are the ones that decide implementation shape:

1. **Does anything under `src/lib/mcp/` read fleet state today?** (Expected: no — but the nearest
   module that does is what the MCP layer would import.)
2. **Which file picks the host for each of embedding / completion / rerank / RLM?**
3. **What does a caller actually see** when `query_case_knowledge` runs with the embedding host
   stopped, and after how long? Task 38 §2 computes a ~370 s worst case from constants but records
   that it was never observed to completion.

*(The "does the master call the sidecar at all" item that stood here is answered above: it does.)*

---

## 5. Why this matters, concretely

Three live problems trace back to this one gap.

**A degraded reranker is indistinguishable from a working one.**
[Task 22](../tasks/22-rerank-observability.md) established that every degraded path in `rerank()`
returns the input array unchanged, and the flag gating `rerankScore` is a pool size read *before* the
call. During this session the rerank host was confirmed live only by probing `:8099` from a shell —
HTTP 200 in 0.37 s — because no MCP surface exposes it.

**`fleet_status()` as currently specified would re-serve the same blindness.**
[Task 30](../tasks/30-mcp-parity-and-fleet-visibility.md) Part 3 proposes it; task 38 §5 amends it to
*probe rather than relay*, precisely because relaying container state reproduces the `notReady`
defect — green while the path is sick.

**The embedding path has no interactive budget** ([task 38](../tasks/38-interactive-embedding-budget.md)),
worst case ~370 s before a caller sees an error. A caller that could ask "is the embedding role
loaded?" would not need to discover this by waiting.

The common shape: **the MCP layer infers runtime health from a proxy** (a cached global boolean, a
tag name, a container state) **rather than asking the component that knows.**

---

## 6. Directions worth considering — none chosen

Deliberately unresolved; this is a report.

1. **Per-role readiness instead of one boolean.** Let a tool declare the roles it needs
   (`requiresRoles: ['completion']`) and gate on those. This retires the `category`-as-dependency
   workaround in §3(c) and is the smallest change that makes the model correct.
2. **A read-only `fleet_status()` that probes**, per task 38 §5(a) — bounded `GET /v1/models` per
   vLLM role, short per-host timeout, `unknown` on timeout rather than hanging.
3. **A distinct status vocabulary.** `running` / `exited` / `unloaded` / `not_pulled` / `created` /
   `unreported` / `unreachable` — and never collapsing the last two into "down" (task 38 §5(c)).
   **§4 raises the cost of this one:** there is no declared status type today, only bare `string`
   with three observed literals and a synthetic `'running'`. So this is not "widen an enum", it is
   "introduce one, and decide what the synthetic value becomes" — a role reported `running` because
   the sidecar assumed it must not keep saying `running` under a vocabulary that promises probes.

5. **Collapse the three role→port maps to one.** The master's copy is missing two roles and its
   docstring points at a deleted file. `resolveEndpoint` already prefers live sidecar data, so the
   constant is a fallback — which makes deleting or deriving it low-risk and removes a trap that
   will not fail loudly.
4. **Let the MCP layer consume the fleet knowledge the master already holds**, rather than
   re-probing. §4 confirms the master talks to the sidecar constantly — so a fresh probe from
   `src/lib/mcp/` would duplicate a cache that already exists one module away, and the two would
   drift. **This is now the cheapest direction, not the speculative one.**

**Revised first step.** The original recommendation here was to measure whether the master can reach
the sidecar. That is answered — it can, and does. The first step is instead:

> **Wire `src/lib/mcp/` to the fleet knowledge already in the process, and make readiness per-role.**

Direction 1 (per-role `requiresRoles`) and direction 4 (consume, do not re-probe) are the same change
seen from the two ends, and together they retire the `category`-as-dependency workaround in §3(c).
Direction 2 (`fleet_status()`) then becomes a thin read over knowledge that already exists, rather
than a new probing subsystem — which is also what keeps it honest, since a tool that relays is only
as good as what it relays (§7).

**What still needs measuring before building** — narrower again after §4:

- Whether the fleet state the master caches is **fresh enough to gate a live call on**. The
  host-Ollama watchdog probes every 15 s, which is promising, but the master's own cache TTL is not
  yet established.
- What that state reports for the **two vLLM roles**, whose liveness is inferred from `nvidia-smi`
  PID attribution rather than from asking the server. A role can currently report `running` because
  the sidecar synthesised it.
- What a caller **actually sees** with a role down. Task 38 §2 computes ~370 s from constants and is
  explicit that it was never observed to completion; that number should be measured before any
  budget is tuned against it.

---

## 7. The standing risk

A fleet tool leaks infrastructure detail into an MCP surface that a routed profile may expose to a
cloud model. `local`-only is the safe default, and task 30 already carries this risk. Nothing here
changes it.

And the rule this series keeps re-learning applies directly: **a status field must not report more
confidence than its probe earned.** A `fleet_status()` that says `running` because Docker said
`running`, while the model inside is unloaded or the port is unreachable, would be the same defect
this repo has spent twelve reports removing — relocated to the fleet layer.
