# Progress notifications — extend the bridge that already exists

**Status:** Proposed — **diagnosed, not verified** · **Effort:** S–M · **Priority:** P2 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §3b, §6 item 9

> **Provenance.** Code citations read from source. v12's premise for this item was **wrong** — see
> below — so the task is smaller and differently shaped than the report proposes. Nothing executed.

Field names and code citations only. No case data.

## ✅ Verification 2026-09-09 — **fully verified; nothing refuted**

Status changed from *diagnosed, not verified*. Every claim in this file checks out against source,
including its own correction of v12. This is the only file in the 26-32 sweep where verification
found no error.

| Claim | Verdict | Evidence |
|---|---|---|
| The translation layer already exists, outside `src/` | ✅ | `scripts/mcp-bridge/bridge.mjs` — `relayJobEvents` `:137`, `progressToken` read from `_meta` `:231`, relay started `:218-224` |
| `progress` → `notifications/progress` **with `progress: evt.seq`** | ✅ | `bridge.mjs:167-171` — literally `progress: typeof evt.seq === "number" ? evt.seq : 0` |
| `thoughts` → `notifications/message` | ✅ | `bridge.mjs:174-179` |
| Every event carries `seq` | ✅ | `research-jobs.ts` — `const event: ResearchJobEvent = { seq: job.events.length, ts: Date.now(), type, payload }` |
| `evidence` and `token` are **not** relayed | ✅ | the `switch (evt.type)` in `bridge.mjs` has cases for `progress` and `thoughts` only |
| `setOutline`, `setCost` and `rlmNote` mutate without calling `emit` | ✅ | all three set `job.<field>` then `job.updatedAt = Date.now()` and return — while `progress`, `evidence`, `thoughts` and `token` immediately above them all call `emit(job, …)`. The contrast is visible in one screenful. |
| Nothing under `src/` knows about `progressToken` | ✅ | every occurrence of `progressToken` in the repo is in `scripts/mcp-bridge/bridge.mjs` |
| `bridge.mjs` is outside the jest roots | ✅ | `jest.config.js` `roots: ['<rootDir>/src']` |

**One addition for item 5.** The risk note is sharper than the item. Because the bridge is the *only*
implementation, "which transport real callers use" is not a nice-to-know — a caller on the in-process
`mcp-server.ts` path gets no notifications at all and has no way to discover that from the tool
description. Item 1 (document what streams, and over which transport) therefore closes most of the
practical gap on its own, and should be done first even if items 2-4 never happen.

**Revised disposition — keep P2, keep the shape.** No re-scoping needed. Item 1 is the highest-value
line in the file and is nearly free.

## The report's premise is wrong

v12 §3b states that the NDJSON progress stream *"[n]one of it reaches MCP"* and proposes building a
translation layer to `notifications/progress`.

**That layer exists.** It is simply not under `src/` — it is in `scripts/mcp-bridge/bridge.mjs`:

| What | Line |
|---|---|
| `progressToken` read from `_meta` | `:224` |
| relay started | `:214-227` |
| NDJSON → MCP mapping | `:165-186` |

The mapping already does what v12 asks for, including the resumption key: `progress` →
`notifications/progress` **with `progress: evt.seq`**, and `thoughts` → `notifications/message`.

Every event already carries `seq` — `src/lib/mcp/research-jobs.ts:88`, typed at
`research-types.ts:297-302`:

```js
const event: ResearchJobEvent = { seq: job.events.length, ts: Date.now(), type, payload };
```

So the task is **not** "build a translation layer". It is: decide what the existing one deliberately
omits, and close the gaps that matter.

## What is actually missing

**1. `evidence` and `token` events are deliberately not relayed** (`bridge.mjs:165-186`). That is
defensible — relaying every evidence item as a notification would flood the channel — but it means a
caller watching notifications sees phase progress and never sees evidence arriving. v12's complaint
("the caller sits blind for 140 s") is therefore half-true: phases stream, content does not.

**2. Three mutations never reach the stream at all.** `setOutline`, `setCost` and `rlmNote`
(`research-jobs.ts:191-205`) mutate the job record **without calling `emit`** (`:87-94`). A stream
tailer never learns the outline landed. This is the same defect as
[task 25](./25-rlm-notes-live-trace.md) item 3, from the stream's side.

**3. `cursor` and `newEvidenceCount` exist only on `research_status`** — `research-jobs.ts:147`
(`cursor: job.evidence.length`) and `:149` (`newEvidenceCount: fresh.length`), returned by
`tools/research-jobs-tools.ts:59-63`. They are **never on an event**, so a tailer must count evidence
itself to know where it is. Putting the cursor on the event is what makes the stream resumable
without a parallel poll.

**4. Nothing under `src/` knows about `progressToken`.** Only the comment at `research-jobs.ts:9`.
The in-process MCP server path (`mcp-server.ts`) does not emit notifications; only the stdio bridge
does. So a client connected other than through the bridge gets nothing regardless.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Document what the bridge already does**, in the skill and the tool descriptions, before writing code. A caller told to poll while notifications already work is the cheapest bug here to fix. | ☐ |
| 2 | **Put `cursor` on progress events**, so a tailer can resume without a parallel `research_status` poll. | ☐ |
| 3 | **Emit for `setOutline` / `setCost` / `rlmNote`** (`research-jobs.ts:191-205`), or document them as poll-only. Silence while the field changes is the worst of the three options. Coordinate with [task 25](./25-rlm-notes-live-trace.md) item 3 — one change, not two. | ☐ |
| 4 | **Decide the evidence-relay question explicitly.** Options: keep omitting; relay a count-only `evidence` progress event; relay behind an opt-in. Write down which and why — the current omission is undocumented, so it reads as an oversight rather than a decision. | ☐ |
| 5 | **Decide whether the non-bridge path needs notifications.** If clients reach the server directly rather than through `scripts/mcp-bridge/`, item 1–4 do not help them. Establish which transport real callers use before building a second implementation. | ☐ |

## Risks

- **Do not build a second translation layer.** The most likely failure here is implementing under
  `src/` what `bridge.mjs` already does, then having two mappings that drift.
- **Streaming makes 140 s legible, not shorter.** v12 says this and it is worth repeating:
  [task 27](./27-subquery-grounding-gate.md) removes more wall clock than this ever will. Priority is
  P2 for that reason.
- **`bridge.mjs` is outside `src/` and outside the jest roots** (`jest.config.js` `roots:
  ['<rootDir>/src']`), so changes there are not covered by the suite. Add coverage or test manually
  and say which.
- **Event volume.** `seq` is `job.events.length` — an unbounded array per job. Relaying more event
  types grows it; check the retention story before adding.

## Acceptance

| Check | Expected |
|---|---|
| A `deep-rlm` job through the bridge with a `progressToken` | phase notifications arrive with monotonic `seq` |
| Same, killed and resumed from a `seq` | no duplicate or skipped events |
| Outline landing mid-run | observable in the stream, or documented as poll-only |
| A tailer using only notifications | can resume without calling `research_status` |
| Skill and tool descriptions | state what streams, what polls, and over which transport |

## References

- `scripts/mcp-bridge/bridge.mjs:165-186, 214-227, 224`
- `src/lib/mcp/research-jobs.ts:9, 87-94, 130, 147, 149, 172-205, 263-303`
- `src/lib/mcp/research-types.ts:297-302`
- `src/lib/mcp/tools/research-jobs-tools.ts:59-63`
- `src/app/api/mcp/[kind]/[id]/events/route.ts`
- [`25-rlm-notes-live-trace.md`](./25-rlm-notes-live-trace.md) — the same silent-mutation defect
- [`27-subquery-grounding-gate.md`](./27-subquery-grounding-gate.md) — the change that actually shortens the job
