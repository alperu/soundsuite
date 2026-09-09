# `rlmNotes` is empty during the run, not on the result — v12 had it backwards

**Status:** Proposed · **Effort:** XS (item 1) + S (items 2–4) · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §4d, §6 item 4

Field names and code citations only. No case data.

## The report's claim, and what the code does

v12 §4d states:

> `rlmNotes` is populated on `research_status` while a job runs and comes back **empty** on
> `research_result`. The audit trail disappears exactly when someone would want to review it. Carry it
> onto the final result.

**Both halves are inverted.** Verified in source:

**`research_result` carries the notes.** `tools/research-jobs-tools.ts:91-95` returns the
`EvidenceResult` verbatim:

```js
case 'done': {
  const result = getJobResult(jobId);
  if (!result) throw new McpError('JOB_NOT_FOUND', …);
  return result as EvidenceResult;
}
```

That object includes `rlm.notes`, landed at `gather-evidence.ts:466` (`rlm = { rounds: out.rounds,
toolCalls: out.toolCalls, notes: out.notes }`), spread at `:576`, typed at `research-types.ts:138`.
The HTTP path is the same (`api/mcp/[kind]/[id]/result/route.ts:43`).

**`research_status.rlmNotes` is `[]` for the entire run.** `job.rlmNote()` is only called *after*
`gatherEvidence` resolves — `src/lib/mcp/research/start-research-job.ts:57`:

```js
const result = await gatherEvidence(query, registry, { … });
for (const note of result.rlm?.notes ?? []) job.rlmNote(note);
```

So the array fills microseconds before the job flips to `done`. The projection itself is fine
(`research-jobs.ts:151`, `rlmNotes: [...job.rlmNotes]`); it has nothing to project until the end.

**The prescribed fix is therefore a no-op.** "Carry it onto the final result" would change nothing —
it is already there. The real defect is that the live trace is unavailable *during* the 140 s window
when a poller would use it, which is the same user-visible complaint arriving from the opposite
direction.

**Two tool descriptions advertise the behaviour the code does not have:**
`research-jobs-tools.ts:37` ("…RLM notes, and the outline once it is ready") and
`research-evidence.ts:218` ("Poll research_status { jobId, cursor } for phase, new evidence and RLM
notes"). This is v12 §7's thesis — *the system describes what it intended to do more precisely than
it verifies what it did* — appearing inside the item meant to fix it.

## Two further defects the report could not have seen

**1. Report jobs never call `rlmNote` at all.** `src/lib/mcp/routed/start-report-job.ts:71-92` wires
`signal`, `onToken`, `onProgress`, `onThoughts`, `onEvidence`, `setCost` and `setOutline` — not
`rlmNote`. `run-report.ts:192-204` accumulates notes locally and emits them only in the final result
(`:299`). So `report_status.rlmNotes` is **permanently** empty, a distinct defect with an identical
symptom.

**2. The note text already streams live — as a per-item field.** `gather-evidence.ts:458-462`:

```js
onRound: ({ round, sources: roundSources, note }) => {
  const items = addItems(roundSources.map((s) => ({
    ...toItem(s, `rlm-round-${round}`),
    rlmNote: note,
  })));
  if (items.length > 0) options.onEvidence?.(items);
},
```

`EvidenceItem.rlmNote` is declared at `research-types.ts:118`, and `onEvidence` → `job.evidence()`
emits immediately. **The data a caller wants already reaches pollers and the NDJSON stream today**,
attached to the evidence items that round produced. The `rlmNotes` array is the redundant surface,
and it is the broken one.

That reframes the decision: this is not "populate an array", it is "decide which of two surfaces is
the trace, and make the other one honest."

## Re-verification, 2026-09-09 — premises hold, nothing built

Checked against current source before touching anything (standing rule: verify before building).
**Every premise in this file still reads as written. Nothing was refuted.** Specifically:

- **The inversion is real.** `start-research-job.ts:57` is still
  `for (const note of result.rlm?.notes ?? []) job.rlmNote(note);`, sitting **after**
  `await gatherEvidence(...)` — so `research_status.rlmNotes` is `[]` for the whole run and fills
  microseconds before the job flips to `done`. v12's claim remains backwards in both halves, and its
  prescribed "carry it onto the final result" remains a no-op.
- **Defect 1 confirmed.** `start-report-job.ts` wires `signal`, `onToken`, `onProgress`,
  `onThoughts`, `onEvidence`, `setCost` and `setOutline` — and **no `rlmNote`**.
  `report_status.rlmNotes` is permanently empty.

**Deliberately not built.** All five items land in `src/lib/mcp/research/start-research-job.ts`,
`src/lib/mcp/routed/start-report-job.ts`, `src/lib/mcp/routed/run-report.ts`,
`src/lib/mcp/research-jobs.ts` and `research-jobs-tools.ts` — every one outside the file territory of
the change that verified them, and item 4's `research-evidence.ts` is explicitly owned elsewhere. The
verification above is the deliverable; the work is unblocked for whoever owns those files.

Item 5's decision now has a precedent to follow: the same "a flag that looks like an outcome but
isn't" defect was closed in [task 22](./22-rerank-observability.md) item 3 by making the *producer*
report its own outcome rather than having a consumer infer it from a proxy. `rlmNotes` reconstructed
from a post-hoc replay loop is the same shape of mistake.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Call `job.rlmNote(note)` from the `onRound` callback**, not after the await. The note is already in hand at `gather-evidence.ts:458-462`; it needs an `onRlmNote` option threaded from `start-research-job.ts:57` so notes land as each round closes (`deep-search.ts:1645-1653`). Delete the post-hoc replay loop. | ☐ |
| 2 | **Wire `rlmNote` into report jobs.** `start-report-job.ts:71-92` — add the callback and have `run-report.ts:192-204` push through it instead of only into its local array. | ☐ |
| 3 | **Make note mutations visible to the NDJSON stream.** `setOutline`, `setCost` and `rlmNote` (`research-jobs.ts:191-205`) mutate the job record **without calling `emit`** (`:87-94`), so a stream tailer never learns of them. Either emit a typed event for each, or document in the tool description that these are poll-only. Silence in the stream while the field changes is the worst of the three options. | ☐ |
| 4 | **Correct the two tool descriptions** (`research-jobs-tools.ts:37`, `research-evidence.ts:218`) to match whatever items 1–3 land. If the per-item `rlmNote` field is chosen as the trace, say so and point callers at it. | ☐ |
| 5 | **Decide whether the array survives.** If `EvidenceItem.rlmNote` is the real trace, `rlmNotes` is a denormalised copy that has now been wrong twice. Keeping both means keeping them in sync forever. State the decision. | ☐ |

## Risks

- **Do not "fix" this by copying `rlm.notes` onto the result.** It is already there; that change would
  be a no-op shipped as a fix, and would leave the actual defect (empty during the run) untouched
  while appearing to close the item.
- **`rlmNote` is fired from inside a hot callback.** `onRound` already does mapping and `onEvidence`
  dispatch; adding an unbounded array push per round is fine, but do not add I/O there.
- **Item 3 changes the event stream's shape.** `scripts/mcp-bridge/bridge.mjs:165-186` maps event
  types explicitly and ignores unknown ones, so new types are safe there — but confirm before adding.
- **Verify before claiming.** Every claim in this file was read from source; the follow-up report must
  state the observed `research_status.rlmNotes` value mid-run, not assert the fix worked.

## Acceptance

| Check | Expected |
|---|---|
| `research_status` polled mid-run, after round 1 closes | `rlmNotes` non-empty |
| `research_result` on the same job | notes present (unchanged behaviour — it already worked) |
| `report_status` polled mid-run | `rlmNotes` non-empty |
| NDJSON stream over the same run | note arrival is observable, or the description says it is poll-only |
| Tool descriptions | match observed behaviour |
| A note's text | identical between `EvidenceItem.rlmNote` and the array entry, or the array is gone |

## References

- `src/lib/search/deep-search.ts:1645-1653` — `closeRound`, where a note is minted
- `src/lib/search/gather-evidence.ts:458-462` (per-item `rlmNote`), `:466`, `:473`, `:576`
- `src/lib/mcp/research-jobs.ts:56, 87-94, 147, 149, 151, 172-205` — record, `emit`, `toView`, handle
- `src/lib/mcp/research/start-research-job.ts:57` — the post-hoc replay loop
- `src/lib/mcp/routed/start-report-job.ts:71-92`, `src/lib/mcp/routed/run-report.ts:192-204, 299`
- `src/lib/mcp/research-types.ts:118` (`EvidenceItem.rlmNote`), `:138` (`rlm`), `:297-302` (event)
- `src/lib/mcp/tools/research-jobs-tools.ts:37, 59-63, 91-95`, `src/lib/mcp/tools/research-evidence.ts:218`
- [`29-progress-notifications.md`](./29-progress-notifications.md) — the stream this trace should reach
