# Result-size economy — a `fields` projection and a count-only summary

**Status:** Proposed — **diagnosed, not verified** · **Effort:** S · **Priority:** P2 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §3c

> **Provenance.** Code citations read from source. v12's stated *reason* for this item is **wrong** —
> corrected below — but the item survives the correction on different grounds. Nothing executed.

Field names and code citations only. No case data.

## ✅ Verification 2026-09-09 — the correction is right, but **it over-corrected: item 1 fixes docs that are already correct**

**CONFIRMED — the core correction stands.**

| Claim | Evidence |
|---|---|
| Nothing in this repo enforces a 60 KB ceiling | `mcp-server.ts` `sendSuccess` is `res.writeHead(200, …); res.end(JSON.stringify(data));` — serialise and return, no size branch anywhere |
| The cap is a host-side client limit | `public/mcp-client/soundsuite-client.js:25` records it as a learned constraint of the calling tool |
| A `fields` projection would not lift a server limit | follows from the above |
| The surviving justification — pagination costs a call per page — is sound | the cursor/`nextCursor` paging path in `scan-for-pattern.ts` is per-call |

**REFUTED — item 1's premise.** The task says `SKILL.md:522` and `public/mcp-client/README.md:57`
"present the cap as a server property" and calls correcting them "the honest part of the task."
**Both documents already attribute it to the client:**

- `public/mcp-client/README.md:57` — *"helpers return summaries so a result never exceeds **the
  tool's** ~60 KB output cap"*. "The tool" is the calling `javascript_tool`, not this server.
- `skills/soundsuite-mcp/SKILL.md:636` — *"A result over ~60 KB **aborts the call** and dumps to a
  file you then have to parse."* Aborting the call is client behaviour, and the sentence says so.

Neither sentence claims the server truncates. **Item 1 has nothing to fix** and should be deleted, or
reduced to a one-line check that no *new* doc introduces the misreading. This is a correction that
introduced a second error while fixing the first — worth noting, because the v12 sentence it corrects
really was wrong.

**STALE CITATIONS**

- `SKILL.md:522` → the 60 KB sentence is at **`:636`**; `:522` is unrelated.
- `soundsuite-client.js:25 (constant)` → `:25` is a **comment line** in the file's header block. There
  is **no 60 KB constant** in that file; the other `60`s (`:251`, `:292`, `:325`) are an excerpt
  radius and two default `limit`s, unrelated to the cap. The reference list's "`:25` (constant),
  `:71` (summariser, used `:66`, `:224`)" is wrong on the first item.

**Revised disposition — keep P2, drop item 1, keep items 2-6.** The task's *own* stated reason for
existing (pagination costs round trips; the server already knows the total on the exhaustive path)
survives untouched, and items 3 and 4 carry the real discipline — a projection must never trim the
honesty fields, and `totalMatches` must not appear on a capped path. Item 6 (measure the byte
reduction) stays: it is still unmeasured.

## The correction: the 60 KB ceiling is not ours

v12 §3c attributes the pressure to a "60 KB result ceiling" that "pushes callers to small `limit`s".

**Nothing in this repo enforces such a ceiling.** It is a host-side MCP **client** cap. The server
just serialises and returns — `src/lib/mcp/mcp-server.ts:242, 248` (`JSON.stringify`, end response).
The figure appears only in documentation and in a client-side *display* summariser:

| Where | Line |
|---|---|
| `skills/soundsuite-mcp/SKILL.md` | `:522` |
| `public/mcp-client/README.md` | `:57` |
| `public/mcp-client/soundsuite-client.js` | `:25` (constant), `:71` (summariser, used `:66`, `:224`) |
| REPORT-v12 itself | `:114` |

So a `fields` parameter would **not** lift a server limit. It would reduce the bytes a client has to
summarise away, and the round trips a caller spends paging.

**The item still earns its place**, for the reason v12 gives second rather than first: *pagination
costs a call per page*, and for a scan that is already exhaustive server-side, a caller asking "how
many and where" pays five calls for an answer the server computed in one pass.

## Two changes

**1. `fields` projection.** Return `citationShort`, `page` and `match`, drop `text`. A caller counting
and locating pulls 200 rows in one call instead of five.

**2. Count-only summary.** For an exhaustive scan, return `totalMatches` plus the first N rows. The
server already knows the total on the full-scan path; the caller currently reconstructs it by paging.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Correct the documentation first.** `SKILL.md:522` and `public/mcp-client/README.md:57` present the cap as a server property. A caller who believes the server truncates will design around a constraint that does not exist. This is a five-minute fix and it is the honest part of the task. | ☐ |
| 2 | Add `fields?: string[]` to `scan_for_pattern`'s input schema (`scan-for-pattern.ts:663-724`, a JSON-schema literal) and project at the row-assembly sites (`:1216`, `:1323`). Keep `rejectsUnknownParams` semantics intact. | ☐ |
| 3 | Ensure a projected response still carries `completeness` in full ([task 24](./24-completeness-object.md)). **Projection must never trim the honesty fields** — a smaller response that has dropped its denominator is exactly the wrong trade. | ☐ |
| 4 | Add `totalMatches` on the exhaustive path, where the count is already known. Do **not** synthesise it on the `fts+regex` path, where it is not. | ☐ |
| 5 | Consider the same `fields` on `query_case_knowledge` (schema at `:104-167`), whose rows carry the largest text payloads. | ☐ |
| 6 | Measure the actual byte reduction on a real scan and record it. An unmeasured optimisation is the failure mode this series keeps naming. | ☐ |

## Risks

- **A projection that drops `text` makes rows unverifiable.** Today a caller can check a match against
  the returned text. `mode: "phrase"` already verifies server-side
  ([task 16](./16-phrase-verification-default.md)), but a caller projecting `text` away is trusting
  that verification completely — say so in the parameter description.
- **`fields` interacts with `completeness`.** See item 3; this is the reason the two tasks are
  separate but must land in a known order.
- **`totalMatches` on a capped path would be a lie.** Item 4's restriction is the whole safety of it.
- **Do not add server-side truncation** while fixing the documentation. The server not truncating is
  a feature: the caller decides what it can hold.

## Acceptance

| Check | Expected |
|---|---|
| `SKILL.md` and client README | describe the 60 KB cap as a client display limit, not a server cap |
| A scan with `fields: ["citationShort","page","match"]` | no `text`; byte reduction measured |
| The same scan without `fields` | byte-identical to today |
| Any projected response | still carries `completeness` in full |
| `totalMatches` | present on exhaustive answers, absent on capped ones |

## References

- `src/lib/mcp/mcp-server.ts:242, 248` — serialise and return; no ceiling
- `public/mcp-client/soundsuite-client.js:25, 66, 71, 224` — the client-side summariser
- `skills/soundsuite-mcp/SKILL.md:522`, `public/mcp-client/README.md:57` — the docs to correct
- `src/lib/mcp/tools/scan-for-pattern.ts:663-724, 1216, 1323, 1344-1352`
- `src/lib/mcp/tools/query-case-knowledge.ts:104-167`
- [`24-completeness-object.md`](./24-completeness-object.md) — the fields projection must never trim
