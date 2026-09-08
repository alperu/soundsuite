# MCP Report v10 — what still limits search quality

**Date:** 2026-09-08 · **Baseline:** working tree after task 15 (branch coverage), 9 files staged, nothing committed
**Method:** live probes against the running index (35,890 chunks) from the browser pane. Every number below was measured in this session, not inferred.
**Status:** findings open. No code changed.

All patterns and examples in this file are synthetic or generic. No case names, cause numbers, party
names, filing titles, or document text.

---

## 0. Where things stand

Recall soundness for `scan_for_pattern` is now good. The coverage rule escalates unreachable keyword
sets to a full scan, capped pages escalate rather than ending silently, and the warnings distinguish
a *proven* absence from an *unreached* one. I re-verified eleven cases; all pass, and keyword
pagination is sound (a capped literal paged to exhaustion returned 37 unique rows, exactly matching
the 37 from an exhaustive scan of the same term).

So this report is not about recall bookkeeping. It is about the two layers underneath it — **what the
index stores** and **what a query is matched against** — where the remaining defects are larger than
anything fixed in v8/v9, and one of them produces confident wrong answers rather than cautious ones.

Priorities below are P0 (wrong answers today), P1 (silent misses), P2 (capability gaps).

---

## 1. P0 — Line numbering breaks multi-word phrase search in transcripts

**This is the biggest remaining hole, and it is invisible.**

Reporter's records are stored with their line numbers inline, so chunk text reads:

```
110 1 <words words words words words words words>
    2 <words words words words words words words>
    3 A <answer text continuing across the line>
```

A phrase that spans a line break therefore has a **number and whitespace inside it**. A literal regex
for that phrase cannot match, however exhaustive the scan.

Measured on a phrase I had already located by eye in a transcript chunk:

| Pattern shape | strategy | scanned | result |
|---|---|---|---|
| `<six words of the phrase>` as a regex | `full-scan` | 35,890 | **0** |
| same phrase with `\s+\d+\s+` at the line break | `full-scan` | 35,890 | **1** |

The scan was exhaustive both times. The corpus contains the phrase. The literal search proves its
absence — correctly, by its own contract, and wrongly in every sense the user cares about.

Transcript lines run roughly eight to ten words, so **any phrase longer than about eight words is
more likely than not to be unfindable**, and a phrase of four or five words fails whenever it happens
to straddle a break. This silently caps how long a quoted phrase can usefully be — the exact
operation a litigation search exists to perform.

It also interacts badly with the v9 work: the answer is now a *proven* zero, so it is more
convincing than it used to be.

**Fix options, cheapest first.**

1. **Normalise at query time.** When a pattern contains a literal space, compile it with the space
   replaced by `\s*(?:\d{1,3}\s+)?\s*`. Cheap, no reindex, no schema change, and it makes the common
   case work. Risk: a pattern that deliberately matches a digit sequence; gate it behind a
   `linePermissive` parameter defaulting to true for `Reporter's Record` filings.
2. **Store a normalised text column** alongside the raw one — line numbers stripped, whitespace
   collapsed — and run the regex against that while returning the raw text for display, with offsets
   mapped back. More work, but it fixes FTS tokenization at the same time and is the right long-term
   shape.
3. Do not solve it by telling operators to write `\s+\d+\s+` by hand. That is the current de-facto
   workaround, it is undiscoverable, and nobody will remember it under time pressure.

**Acceptance:** a six-to-ten-word phrase known to span a line break returns its hit with a plain
pattern, and the existing exhaustive-scan controls do not regress.

---

## 2. P0 — A plain multi-word phrase returns unverified keyword matches

The regex post-filter runs only when the pattern `looksLikeRegex`. A pattern with no metacharacters
skips it and returns **BM25 keyword hits, ranked, formatted identically to real matches**.

Measured, using a six-word phrase that occurs **zero** times in the corpus in that exact form:

```
pattern: <six-word phrase, no metacharacters>
→ 20 rows returned, candidatePool 21, nextCursor present
→ rows actually containing the phrase: 0 / 20
```

Every row was a bag-of-words match sharing common terms. Nothing in the response says the phrase was
never checked: no warning, no flag, and the rows carry the same `citationShort` and `page` fields a
verified hit carries. An operator asking "where was this said" gets twenty citations to passages
where it was not said.

This is the mirror image of the bug just fixed. v8/v9 closed the false-negative path and left the
false-positive path open, and the false-positive path is **the default input shape** — a person
searching for a quoted sentence types the sentence.

The `looksLikeRegex` gate is defensible for *escalation* decisions (§1 of v9's reasoning holds: you
do not want linear scans for dashboard natural-language queries). It is not defensible as a gate on
*verification*. Those are different questions and they have been collapsed into one flag.

**Fix.** Separate them:

- Keep `looksLikeRegex` deciding *strategy*.
- Decide *verification* on whether the caller wanted a phrase. Either add an explicit `mode:
  "phrase" | "keyword"` (default `phrase` for `scan_for_pattern`, whose entire purpose is exact
  matching), or always post-filter and, when the filter empties a non-empty pool, say so in a warning
  the way the regex path already does.
- At minimum, and immediately: **emit a warning whenever rows are returned without post-filtering.**
  One sentence — *"matched on keywords, not the literal phrase; rows may not contain it"* — converts
  a wrong answer into a hedged one.

**Acceptance:** a phrase absent in exact form returns either zero rows or rows explicitly labelled
unverified; a phrase present returns it.

---

## 3. P1 — No text normalisation, in either direction

Three separate misses, all measured:

| Variant | Result | Note |
|---|---|---|
| A name with diacritics, spelled **with** them | 20+ rows (capped) | present |
| The same name spelled **without** diacritics | 5 rows, exhaustive scan | also present |
| A contraction with a **straight** apostrophe | found | corpus form |
| The same contraction with a **curly** apostrophe | **0, reported as *proven* absent** | pool 38, fully covered |

Two consequences.

**Both spellings of a name exist in the corpus**, so a search for either form silently returns a
subset. Anyone counting mentions, or asserting that a party said something a given number of times,
is wrong by construction. This is not hypothetical — it is a single name that appears both ways
because different filings transliterate differently.

**The curly-apostrophe case is worse because v9 made it confident.** macOS and Word autocorrect
straight quotes to curly ones, so an operator pasting a quotation from a brief gets a *proven*
absence for text that is in the corpus with the other glyph. The proof is technically sound and
practically false.

**Fix.** Fold at index and query time: Unicode NFKD + diacritic strip, and map the curly quote family
(`‘’“”`), dashes (`‐`–`―`), and non-breaking spaces to ASCII. Keep the raw text for
display. This is the same normalised-column work as §1 option 2 — **do them together**; separately
they each cost a reindex.

Hyphenation is a related, smaller case: a pattern for `<letter>-<space><letter>` returns rows, i.e.
hyphen-plus-break artifacts survive extraction, so a word split across a line break is a third way to
miss a match.

---

## 4. P1 — Chunk boundaries, and no way to see across one

Two connected gaps.

**Overlap looks inconsistent.** Sampling 120 chunks, of 106 page-adjacent pairs only **23 (22%)**
showed a shared text window at the boundary. Chunk sizes ran 60 / 1,488 / 2,120 characters
(min/median/max). *Stated as measured, not as a mechanism*: my adjacency test used page order as a
proxy for chunk order, which is imprecise, so this is a signal to investigate rather than a proven
defect. But if overlap is genuinely partial, then a phrase spanning a chunk boundary is unfindable
for the same reason as §1 — and the 60-character minimum suggests some chunks are fragments that
cannot carry context at all.

**Worth measuring properly**: emit chunk ordinals, then check what fraction of consecutive pairs
overlap and by how much. That is a ten-line query against the store, and it either clears the concern
or promotes it to P0.

**There is no context-expansion tool.** Of the 24 tools in `local`, none returns the chunk before or
after a hit. That is why the speaker-attribution method in the skill has to say "a chunk that opens
mid-turn loses its first partial turn" — the fix would be trivial if a caller could ask for the
neighbouring chunk. It also forces the digest pattern to slice a window out of whatever text happens
to be in the hit.

**Fix.** Add `get_chunk_context({ chunkId, before = 1, after = 1 })`, or a `context` parameter on
`scan_for_pattern` returning padded text. No LLM, no reindex, small surface. This is the highest
value-per-line item in the report.

---

## 5. P2 — Structure metadata is still null, and it blocks real filters

`headingPath`, `blockType` and `speakers` remain unpopulated; the backfill has not been run because
it mutates the live index and is waiting on a backup and a go-ahead. Fair. But note what it costs
while it waits:

- **No speaker filter.** Attribution works today only by scanning printed labels in the text and
  splitting on them (skill §3a). That method is sound but manual, and it degrades exactly where the
  chunk boundary falls mid-turn (§4).
- **No section filter.** "Find this only in the argument section, not the appendix" is not
  expressible.
- **No block-type filter.** Quotations, headings and table cells are indistinguishable from body
  text, so a search for a phrase cannot exclude the places where a filing merely *quotes* it — which
  is precisely the distinction that separates a primary source from your own brief quoting it.

That last one is doing real damage now: the corpus duplicates itself (clerk's records transcribe
reporter's records), and the only current defence is client-side dedupe by snippet text.

**When the backfill runs, take the backup first and verify a restore**, not just that the file
exists. It is the one irreversible operation in this list.

---

## 6. P2 — Carried over, unchanged

- **`deep-report` returns `outline: null`** and burns its 25-second budget; the host has no small
  instruct model selected. One pull plus a selection on Admin → AI Services fixes it. Until then the
  tier costs time and returns nothing extra.
- **Graph data is empty.** `query_case_graph` is callable but no motion has a child, `amendsId` or
  `supersedesId`, and no Person links to any Motion. Callable ≠ productive.
- **`safeKeywords`' whole-pattern rescue** (task 14 item 2) still admits fragment runs as keywords.
  No reproducing case remains, correctly deferred.
- **`fetchLimit = (offset + limit) * 5`** still shifts strategy with `limit`. v9 made it unable to
  flip a verdict, which was the right call; the shift itself is harmless and can stay.

---

## 7. Suggested order

| # | Item | Why first | Cost |
|---|---|---|---|
| 1 | Warn when rows are returned unverified (§2, minimum fix) | turns a wrong answer into a hedged one, today | ~10 lines |
| 2 | `get_chunk_context` (§4) | unblocks attribution and context; no reindex | small |
| 3 | Line-number-tolerant matching (§1, option 1) | fixes the most common real query | small, gated |
| 4 | Proper `mode: phrase\|keyword` split (§2, full fix) | removes the false-positive class | medium |
| 5 | Normalised text column: line numbers, diacritics, quotes (§1 opt 2 + §3) | one reindex, fixes three findings | medium/large |
| 6 | Measure chunk overlap properly (§4) | cheap; either clears or promotes a P0 | tiny |
| 7 | Structure backfill (§5) | unblocks three filters | needs backup + go-ahead |

Items 1, 2, 3 and 6 are all small and independent, and together they cover the two P0s and the
measurement that decides whether there is a third.

## 8. The pattern worth naming

v8 found a false negative. v9 fixed it and made the negatives provable. This report finds that the
*positive* side was never verified at all, and that an exhaustive scan can still miss a phrase that
is plainly in the corpus because of how the text is stored.

The common thread is that **recall bookkeeping has been improving faster than the matching itself**.
The tool is now careful and articulate about how much of the corpus it looked at, while remaining
silent about whether what it compared was the right string. Both P0s here are of that kind. Worth
holding onto when the next warning string gets written: a warning describes the search, and the
question the operator asked was about the text.
