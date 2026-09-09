# `docs/mcp/` — the MCP ↔ sidecar surface

**Created:** 2026-09-09 · **Status:** working folder, nothing implemented from here yet

## What this folder is for

The question that opened it: **how does the MCP server know which sidecar LLMs are available to
it?** Today the answer appears to be "mostly, it does not" — see
[`REPORT-sidecar-model-awareness.md`](./REPORT-sidecar-model-awareness.md).

This folder is deliberately separate from the two existing MCP doc homes, which have different jobs:

| Folder | Holds |
|---|---|
| `docs/MCP-Improvements/` | the numbered report series (v2 → v14) on the **caller-facing** MCP surface — tools, warnings, denominators |
| `docs/tasks/` | numbered, self-contained engineering tasks (01 → 38) with acceptance criteria |
| **`docs/mcp/`** (this) | the **server↔runtime** boundary: which models/roles exist, which are reachable, and how the MCP layer learns it |

Work that graduates from here becomes a numbered task in `docs/tasks/`. This folder is where the
question is still being characterised.

## Standing conventions inherited from the report series

These are not stylistic preferences; each was learned from a defect this repo actually shipped.

1. **No frozen numbers.** Any figure that changes belongs in a query, not in a document. A per-case
   table written into `docs/tasks/35-bulk-promotion.md` was stale within hours.
2. **A claim names its denominator.** "Role X is down" must say what was probed and what was not.
3. **`UNREPORTED` is not `down`.** A host that declares a container and returns no status is telling
   you nothing about that container — three wrong conclusions were drawn from that confusion in one
   session.
4. **Describe the action, not the outcome, before the outcome exists.** A status line emitted before
   a probe completes cannot report what the probe found.
5. **Verify before building.** Four premises of report v12 and three of v14 were refuted by reading
   source. Every proposal here carries a "confirm first" step for that reason.

## Contents

The opening report graduated into the numbered series and lives there now:

- [`../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md`](../MCP-Improvements/REPORT-v15-sidecar-model-awareness.md)
  — what the MCP layer knows about sidecar-hosted models, what it infers instead, and where that
  breaks. **This is the next task to be scoped.**

Working notes and drafts for that work belong here; anything that becomes a conclusion belongs in the
report series or in a numbered task.

## Related, elsewhere

- [`../tasks/30-mcp-parity-and-fleet-visibility.md`](../tasks/30-mcp-parity-and-fleet-visibility.md)
  — proposes `fleet_status()` / `role_assignments_list()`. Task 38 §5 amends it substantially.
- [`../tasks/38-interactive-embedding-budget.md`](../tasks/38-interactive-embedding-budget.md) — the
  interactive-vs-batch timeout asymmetry, and the §5 amendments to task 30.
- [`../tasks/22-rerank-observability.md`](../tasks/22-rerank-observability.md) — why a degraded
  reranker is currently indistinguishable from a working one in the response.
