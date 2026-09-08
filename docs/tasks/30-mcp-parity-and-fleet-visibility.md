# Parameter parity between tools, and read-only fleet visibility

**Status:** Proposed — **diagnosed, not verified** · **Effort:** S · **Priority:** P2 · **Created:** 2026-09-08
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

## Work

| # | Item | Status |
|---|---|---|
| 1 | Declare `searchMode` and `recordStatus` on `research_evidence` and thread them through. Match `query_case_knowledge`'s semantics exactly — a parameter that means something subtly different under the same name is worse than its absence. | ☐ |
| 2 | Decide explicitly whether `multiPass` should be requestable on the report tools, on synthesis grounds. Record the decision either way. | ☐ |
| 3 | Add `fleet_status()` — read-only, `category: 'search'` so it answers on a degraded fleet (see [task 23](./23-corpus-status-and-denominators.md) for why that declaration is load-bearing). | ☐ |
| 4 | Add `role_assignments_list()` — read-only. | ☐ |
| 5 | **Do not add `role_assign()` in this task.** If it is wanted, it is a separate task with its own profile and auth discussion. | ☐ |
| 6 | Cross-reference from [task 22](./22-rerank-observability.md): once `rerankApplied` exists in responses, fleet status stops being the only way to tell. Note which is authoritative. | ☐ |

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
