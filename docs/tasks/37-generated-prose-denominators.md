# Denominators in generated prose — the surface no sweep can see

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v14-execution-plan-to-working.md`](../MCP-Improvements/REPORT-v14-execution-plan-to-working.md) §5
**Blocked by:** [`24-completeness-object.md`](./24-completeness-object.md)

Field names and code citations only. No case data.

## Problem

Every completeness defect this series found was found by reading **string literals**. That method has
now been run twice across all 61 non-test files under `src/lib/mcp` — line-wise, and again with `' +`
continuations collapsed so a claim could not hide across a concatenation break. The static surface is
clean.

**Two surfaces emit absence prose that no such sweep can ever see, because a model writes it at
runtime:**

- `research_evidence` emits **`gaps`**
- `src/lib/mcp/routed/run-report.ts` emits **report prose**

A model writing *"no evidence found for section X"* is an undenominated corpus-absence claim by
construction. It is also **the sentence most likely to be pasted into something that matters** — a
memo, a filing, an email to a client — because it is written in prose a person can use directly,
unlike a `warnings[]` entry.

At the corpus coverage [task 23](./23-corpus-status-and-denominators.md) measures — read it live,
it is roughly a ninth of the corpus — such a sentence is wrong in the most consequential possible way.

> ⚠️ **Both citations above are wrong. Corrected 2026-09-09 by reading the source.** The *problem* is
> real and unchanged; **neither named file generates anything.** This task was written to fix
> unverified site citations and shipped two of its own.

### The real generation sites

| Task said | Actually | What is there |
|---|---|---|
| `research_evidence` emits `gaps` | **`src/lib/search/evidence-outline.ts`** | The model prompt is at `:221`; the JSON schema requiring `gaps` at `:274-276`; the parse at `:107-133`. `gaps` appears in `src/lib/mcp/tools/research-evidence.ts` **only inside the tool's description string** — that file generates nothing. `research-types.ts:136` is the type. There is also a deterministic path: `:197` emits `gaps: ['no evidence retrieved']` with no model involved — an undenominated absence claim written by *code*, which the static sweeps missed because they only read `src/lib/mcp`. |
| `run-report.ts` emits report prose | **`src/lib/search/deep-search.ts`** | the `REPORT_SYSTEM_PROMPT` constant ("You are an expert legal research analyst…"), the closing `Write the research report now…` instruction block that follows it, and the `callLLM(REPORT_SYSTEM_PROMPT, …)` call sites. **Cited by symbol, not line — that file is under active edit and its line numbers moved during this audit.** `run-report.ts` imports `deepSearch` and assembles `ReportResult.report` — it *carries* the prose, it never writes it. It contains no prompt, no model call and no string that could over-claim. |

Two consequences.

**The sweep boundary was the defect, not the sweep.** "Both surfaces are invisible to a string sweep
because a model writes them" was half right. `evidence-outline.ts:197` is a **literal** absence
string in source — findable by exactly the method this series has been running — and it was missed
because every sweep was scoped to `src/lib/mcp`. The generation happens one directory over, in
`src/lib/search`. Widen the scope before concluding the static surface is clean; "clean" has been
carrying an unstated denominator of its own.

**Injection point changes.** Item 2 says to inject the denominator into "both generation contexts".
Those contexts are `deep-search.ts`'s report prompt and `evidence-outline.ts`'s outline prompt, both
under `src/lib/search/**`. Neither is reachable from `src/lib/mcp`, and `corpus-denominator.ts` is
MCP-side, so the injection needs a deliberate direction of dependency — decide it before writing
code, rather than discovering it at import time.

**Territory note:** the agent that performed this correction had `src/lib/search/**` as read-only, so
the implementation (items 2–6) is not started. The citations above are verified; the build is not
begun. Whoever picks this up owns `src/lib/search/`.

## Why this is not solved by task 24

[Task 24](./24-completeness-object.md) puts a `completeness` object on tool responses. That is
necessary and it does not close this. A structured field would sit **beside** prose that already
over-claims, and the person reading the report reads the prose. The field helps a machine; the
sentence is what reaches a human.

This is the inverse of the rest of the series. Everywhere else, the prose was honest and the machine
had to string-match to learn it. Here the machine will be honest and the prose will not.

## Approach

Two mechanisms, and the second is the one that actually holds.

**1. Inject the denominator into generation context.** `corpus-denominator.ts` already resolves a
scoped denominator (`getCorpusDenominator`) and renders it (`provenAbsenceClause`). Both surfaces know
their case scope, so both can be given the numbers before generating.

**2. Check the output.** A model can ignore its context; it cannot ignore a validator. Scan generated
text for absence assertions and flag any that carry no denominator nearby.

**Do not rely on (1) alone.** Context is a suggestion; the check is the guarantee. Shipping only the
injection would be this series' own recurring defect committed one last time — describing an intent
more precisely than verifying the outcome.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Locate both generation sites precisely.** | ☑ **done, and both original citations were wrong** — see the corrected table above. Real sites: `src/lib/search/evidence-outline.ts` (`:197,221,274`) and `src/lib/search/deep-search.ts` (`REPORT_SYSTEM_PROMPT` and its closing instruction block — by symbol; that file is under active edit). Neither receives coverage information today. |
| 2 | **Inject the resolved denominator** into both generation contexts, scoped to the case(s) the job actually covered — not the corpus figure, since per-case coverage ranges 2.3%–44.4% and quoting the corpus average to a sparse case is off by ~5x. | ☐ |
| 3 | **Build the post-generation validator.** Detect absence assertions ("no evidence", "nothing found", "does not appear", "is absent", "no mention of") and require a denominator within the same sentence or the adjacent one. Keep the pattern list in one place, tested. | ☐ |
| 4 | **Decide the failure mode, explicitly: block, annotate, or warn.** Annotating is probably right — refusing to emit a whole report because one sentence over-claims is worse than the over-claim, and a blocked report teaches operators to route around the check. Whatever is chosen, write down why. | ☐ |
| 5 | **Extend the banned-phrase guard to the generated surface.** `"the absence is proven"` is gone from `src/` and asserted absent by test; a model can reintroduce it verbatim in prose, where no source test looks. | ☐ |
| 6 | **Decide what a validator failure means for the job's result envelope** — does the caller learn that prose was flagged? A silently-annotated report is better than a silently-over-claiming one, but a caller that cannot see the flag cannot act on it. | ☐ |

## Risks

- **False positives will be common and annoying.** "No evidence of tampering was alleged" is not a
  corpus-absence claim. A validator that flags everything gets disabled, which is worse than no
  validator. Tune on real output, and prefer annotation over blocking (item 4).
- **This is unbounded pattern-matching against natural language.** It will never be complete. Treat it
  as raising the floor, not closing the hole, and say so in the acceptance criteria rather than
  claiming coverage it cannot have.
- **The denominator moves.** After [task 35](./35-bulk-promotion.md) the figures change from ~11% to
  ~100%. Injected text must read the live value, never a constant — the `~35,890` in the skill was
  exactly this mistake at the documentation layer.
- **Do not let the validator's own message over-claim.** "No undenominated absence claims found" is
  itself a completeness statement about a pattern list that cannot be complete.

## Acceptance

| Check | Expected |
|---|---|
| A report section that found nothing | says so **with** a denominator naming what was searched |
| A synthetic over-claiming string | caught by the validator |
| `"the absence is proven"` in generated prose | caught |
| A legitimate non-corpus absence ("no objection was raised") | **not** flagged |
| The denominator in generated text | matches `corpus_status` at generation time, not a constant |
| Validator coverage | stated honestly as a floor, with the known gap named |

## Handover: the two real generation sites

Written by an agent whose territory **excluded `src/lib/search/**`**. Everything below is described,
not made; no file under `src/lib/search` was edited. Whoever implements this owns that directory.

### Site 1 — `src/lib/search/evidence-outline.ts:197` (deterministic, no model)

**Exact current line:**

```ts
if (evidence.length === 0) return { sections: [], gaps: ['no evidence retrieved'] };
```

`'no evidence retrieved'` is a bare corpus-absence claim with no denominator, written by **code**, not
by a model. This is the one that should have been caught by a string sweep years ago; it survived only
because every sweep was scoped to `src/lib/mcp`.

**Proposed replacement** — the clause arrives as data, so this file gains no new imports:

```ts
if (evidence.length === 0) {
  return {
    sections: [],
    gaps: [`no evidence retrieved — ${options.absenceClause ?? 'coverage of the corpus could not be determined'}`],
  };
}
```

Add `absenceClause?: string` to `EvidenceOutlineOptions` (`:25`). The fallback is deliberately the
awkward wording, matching `provenAbsenceClause`'s "nothing known" shape: a denominator that could not
be read must read as a gap, not as an unqualified absence.

**Call sites that must supply it: exactly one.** `src/lib/search/gather-evidence.ts:539`, via the
`outlineOptions` object built at `:525-533`. Nothing else calls `buildEvidenceOutline`.

**Is a corpus context in scope there? Partly — and this is the crux.**

- The **case scope is already in scope**: `gather-evidence.ts` holds `options.caseId` and
  `options.caseIds` and already uses them at `:349`, `:364`, `:452-453`. No new plumbing is needed to
  know *which* denominator applies.
- The **resolver is not**: `getCorpusDenominator(context, caseIds)` requires a `ToolExecutionContext`,
  and `gather-evidence.ts` holds a `ToolRegistry`, not a context.

### Can `provenAbsenceClause` be reused verbatim?

**The renderer: yes. The resolver: no — and it should not be reached from here anyway.**

`provenAbsenceClause(den: CorpusDenominator | null)` is a **pure function of a plain data object**. It
already degrades correctly on `null` to wording that makes the missing denominator explicit, which is
exactly the behaviour this site needs. No variant is required.

`getCorpusDenominator` is the part that needs a context, and threading a `ToolExecutionContext` down
into `src/lib/search` would invert the dependency direction — search would begin depending on mcp.

**Recommended shape, which avoids that entirely:** resolve on the MCP side, where the context already
exists, and pass the finished value **down as data**:

1. In the MCP caller, call `getCorpusDenominator(context, caseIds)` — it is already cached per scope,
   so a page of scoped calls pays for it once.
2. Render with `provenAbsenceClause(den)` (or pass the `CorpusDenominator` itself, if the consumer
   wants to phrase it differently).
3. Thread the resulting **string** through the existing options objects into
   `EvidenceOutlineOptions.absenceClause` and into the report prompt below.

`src/lib/search` gains no import from `src/lib/mcp`, `corpus-denominator.ts` stays the single source,
and the value is live at generation time rather than a constant — which is the requirement item 2 and
the risks section both insist on.

### Site 2 — `src/lib/search/deep-search.ts`, the report prompt (model-written)

Cited **by symbol, not line**: that file is under active concurrent edit and its line numbers moved
during this audit.

**The two exact instructions that produce undenominated absence prose**, inside
`REPORT_SYSTEM_PROMPT`:

```
3. **Gaps** — What wasn't found or needs further investigation
```

and, in the closing instruction block:

```
- If certain aspects of the question cannot be answered from the excerpts, say so in the Gaps section
```

Both direct the model to assert absence and neither requires it to name what was searched. A model
following these faithfully produces exactly the sentence this task exists to prevent — and the Gaps
section is, by construction, the part of the report most likely to be pasted into a memo or a filing.

**Proposed replacement** — same two instructions, with the denominator made mandatory rather than
optional:

```
3. **Gaps** — What wasn't found or needs further investigation. Every statement that something is
   absent MUST name what was searched, using the coverage clause supplied below. Never write that
   something does not exist; write that it was not found in the material that was searched, and say
   how much of the corpus that was.
```

and:

```
- If certain aspects of the question cannot be answered from the excerpts, say so in the Gaps
  section, and attach the coverage clause verbatim: "{{absenceClause}}"
```

with the resolved clause interpolated into the user content alongside the excerpts.

**Call sites that must supply it:** the two `callLLM(REPORT_SYSTEM_PROMPT, userContent, …)` calls in
`deep-search.ts` (the second is the retry-at-larger-budget path — **both** need it, or the retry
silently emits the undenominated version). The clause reaches them the same way as site 1: resolved
MCP-side, threaded down as data.

**This site needs the validator; site 1 does not.** Site 1 is deterministic — fixing the string fixes
it, permanently and provably. Site 2 is a model that can ignore its instructions, so injection alone
is a suggestion. That asymmetry is worth preserving in the implementation: do not build the same
mechanism twice.

## References

- `src/lib/mcp/corpus-denominator.ts` — `getCorpusDenominator()`, `provenAbsenceClause()`
- `src/lib/mcp/routed/run-report.ts` — report prose generation
- `src/lib/mcp/tools/research-evidence.ts` — `gaps`
- [`24-completeness-object.md`](./24-completeness-object.md) — the structured half; must land first
- [`23-corpus-status-and-denominators.md`](./23-corpus-status-and-denominators.md) — the wording rule this extends
- [`33-full-scan-denominator-gap.md`](./33-full-scan-denominator-gap.md) — the static-surface equivalent, closed
