# Extractable Fields Audit

> Snapshot of `prisma/data/sound-suite.db` taken 2026-05-22. Scope:
> what XETO tag fields are currently populated on filings, what could
> be filled by an LLM extractor reading the indexed text chunks, and
> where the current pipeline leaves the gaps.

## 0. Clarification on data model

The task brief says "the Filings table has `tags` JSON". That is not how the
schema is shaped. `Filing` is a thin parent row (id, caseId, filingType,
title, slug, filingDate, description, volumeNumber, isSupplemental,
supplementalOrder, createdAt, updatedAt) — **no `tags` column**. XETO tags
live on the per-kind sub-entity rows:

| Filing.filingType   | Where the tag bag lives                | DB rows |
| ------------------- | -------------------------------------- | ------- |
| Motion              | `Motion.tags` (also `Motion.judgeId`, `movantId`, `respondentId` columns) | 13 Filings → 34 Motion rows (extra rows are kind:"motion" shells materialised by `ensureMotionForFiling` for other filing kinds) |
| Reporter's Record   | `ReportersRecord.tags` + `reporterId`, `hearingDate`, `documentId` cols | 15 → 13 |
| Clerk's Record      | `ClerksRecord.tags` + `filedOn`, `documentId` cols | 2 → 2  |
| every other type (Response / Brief / Notice / Order / Petition / Objection / Reply / Supplement / Letter) | `MotionAttachment.tags` + `documentId`, `authoredById` cols | 21 attachments |

Coverage % below counts a field as **populated** when *any* path is set:
the dedicated column (e.g. `Motion.judgeId`), the JSON path
(`json_extract(tags, '$.judgeRef')`), or the generated virtual column. Numbers
denominators are the sub-entity row counts above, not the Filing row counts.

Document linkage to a filing happens through `Document.filingId`; the
sub-entity-level `documentId` / `fileRef` is the canonical place the tag
panel and chunk-attribution code look. That distinction drives the
`fileRef` gap in §3.

---

## 1. Current data coverage

### 1.0 Unified summary

% of rows with the field set via *any* path (column, JSON, virtual). `Motion`
row reflects the 13 **real** motion-typed Filings only — the 21 shadow Motion
rows that `ensureMotionForFiling` materialises as MotionAttachment parents
cannot meaningfully carry these fields and are excluded from the denominator.
`hearingDate` and `reporterRef` are only meaningful on `reportersRecord`;
`movantRef`/`respondentRef` are only meaningful on motion-shaped kinds. n/a
denotes "field not in this kind's spec".

| Filing kind        | n  | filedOn | receivedOn | fileRef | judgeRef | movantRef | respondentRef | reporterRef | hearingDate | authoredBy |
| ------------------ |---:|--------:|-----------:|--------:|---------:|----------:|--------------:|------------:|------------:|-----------:|
| motion             | 13 |   0%    |    0%      |   0%    |    0%    |   **8%**  |    **8%**     |    n/a      |    n/a      |    0%      |
| motionAttachment   | 21 |   0%    |    0%      |  43%    |    0%    |    0%     |     0%        |    n/a      |    n/a      |   19%      |
| clerksRecord       |  2 |   0%    |    0%      |   0%    |    0%    |   n/a     |    n/a        |    n/a      |    n/a      |    0%      |
| reportersRecord    | 13 |   0%    |    0%      |   0%    |    0%    |   n/a     |    n/a        |     0%      |     0%      |    n/a     |
| **all Filings**    | 51 |   **0%** (`Filing.filingDate` is NULL on every row) | — | — | — | — | — | — | — | — |

The `fileRef` 43% on MotionAttachment is the only non-zero cell. Every other
field on every kind is effectively empty. **Headline: auto-fill starts from
a clean slate, and even the precondition `Person` table has zero rows with
the `judge`, `lawyer`, `courtReporter`, or `self` markers — so refs have no
targets to resolve to until those Persons are created.**

### 1a. Motion (n=34 rows — 13 real motion-typed Filings + 21 shadow rows materialised for MotionAttachment parents)

| Field         | Populated | % |
| ------------- | ---------:|--:|
| filedOn       | 0/34      | 0% |
| receivedOn    | 0/34      | 0% |
| fileRef       | 0/34      | 0% |
| judgeRef      | 0/34      | 0% |
| movantRef     | 1/34      | 3% |
| respondentRef | 1/34      | 3% |
| authoredBy    | 0/34      | 0% |
| hearingDate   | n/a       | —  |

The single populated `movantRef` / `respondentRef` is the manually-tagged
`disqualifyCounsel` motion (selfFiled=true). Everything else is empty.

### 1b. MotionAttachment by attachmentKind (n=21)

| attachmentKind | n | fileRef | authoredBy | judgeRef/signedBy | movantRef | respondentRef | filedOn | receivedOn | date value (signedOn/sentOn/hearingDate) |
| -------------- |--:|--------:|-----------:|------------------:|----------:|--------------:|--------:|-----------:|----:|
| brief          | 2 | 1 (50%) | 2 (100%)   | 0 | 0 | 0 | 0 | 0 | 0 |
| letter         | 1 | 0       | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| notice         | 2 | 2 (100%)| 2 (100%)   | 0 | 0 | 0 | 0 | 0 | 0 |
| objection      | 3 | 1 (33%) | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| order          | 1 | 1 (100%)| 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| petition       | 3 | 0       | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| reply          | 1 | 0       | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| response       | 5 | 2 (40%) | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| supplement     | 3 | 2 (67%) | 0          | 0 | 0 | 0 | 0 | 0 | 0 |
| **all**        |21 |  9 (43%)| 4 (19%)    | 0 | 0 | 0 | 0 | 0 | 0 |

Sample sizes are tiny — any % beyond "0% / 100%" is essentially noise.
The structural fact is what matters: **dates and judge/party refs are
universally empty**, fileRef is barely past coin-flip.

### 1c. ClerksRecord (n=2)

| Field      | Populated | % |
| ---------- | ---------:|--:|
| fileRef / documentRef | 0/2 | 0% |
| filedOn (col + tag)   | 0/2 | 0% |
| preparedBy            | 0/2 | 0% |
| preparedOn            | 0/2 | 0% |
| authoredBy            | 0/2 | 0% |

### 1d. ReportersRecord (n=13)

| Field        | Populated | % |
| ------------ | ---------:|--:|
| fileRef / documentRef | 0/13 | 0% |
| reporterRef (col + tag) | 0/13 | 0% |
| hearingDate (col + tag) | 0/13 | 0% |
| filedOn      | 0/13 | 0% |

### 1e. Filing-level `filingDate`

`Filing.filingDate` is `NULL` for **every** 51 Filing rows. Whatever
ingestion sets this column, it never has. The downstream `filedOn` tag is
also empty on every sub-entity. So **no filing in this DB knows when it
was filed** — neither at the Filing level nor the tag level.

### 1f. Origin (Task #27) overrides

| Kind            | n  | selfFiled | opposingFiled | courtIssued | thirdParty |
| --------------- |---:|----------:|--------------:|------------:|-----------:|
| Motion          | 34 | 1         | 0             | 0           | 0          |
| MotionAttachment| 21 | 2         | 0             | 1           | 0          |

Manual origin overrides have only been used a handful of times. The
read-side `deriveOrigin` (route.ts:692) computes origin **at read time**
from the row's `authoredBy` Person tags, so the column counts here only
reflect explicit panel-set overrides, not what the UI displays. The
derivation requires `authoredBy` to be set — which (per §1a/§1b) is true
on only 4 of 76 sub-entity rows. Effectively no origin is being inferred
either.

### 1g. Headline coverage

**Of the nine target fields, eight are at 0% across every filing kind**;
the one exception (fileRef) is 43% on MotionAttachment and 0% everywhere
else. Auto-fill is starting from essentially a clean slate.

---

## 2. Indexed-text signal for missing fields

Source for excerpts: LanceDB `chunks` table (22 415 chunks). Each chunk is
prefixed with `[Case: <case> | Filing: <filingType>]` and includes the
document text in 250-1000 char fragments with `document_id`,
`filing_id`, `filing_type`, `page_number`.

Critical caveat: only **Clerk's Record (3 docs) and Reporter's Record
(11 docs) and 3 Motion pages** have full PageCache rows. Other filing
types have chunks in LanceDB but the `PageCache` table is mostly empty —
all pattern matching below was done against LanceDB chunks, which is the
primary text store for an LLM extractor anyway.

### 2.1 `filedOn` (clerk file-stamp date)

- **Pattern A — clerk file-stamp coversheet ("FILED IN ... COURT").** Found
  on Reporter's Records and clerk-stamped briefs/orders.
  Excerpt (`f6731412`, Reporter's Record):
  `D VOLUME 1 TRIAL COURT CAUSE NO. D-1-FM-21-005611 FILED IN APPEALS COURT CAUSE NO. 03-25-00905-CV`
  — note: this is the appellate "filed in N-th court of appeals" stamp, not a date.
- **Pattern B — embedded date stamp on the appellate cover.** Excerpt
  (Brief `bbfaa6a4`): `BRIEF OF APPELLANT ALPER UZMEZLER James A. Vaught State Bar No. 20526300 VAUGHT LAW FIRM ...` — date stamp itself is often
  rendered as an image overlay that OCR'd as the receiving court header,
  not a date string.
- **Pattern C — Clerk's Record index has explicit per-document filed
  dates.** Excerpt (Clerk's Record `4740bf99` page 2):
  `INDEX  FILED DATE   DOCUMENT DESCRIPTION   PAGES  ... 7/9/2025   PETITION FOR BILL OF REVIEW   5-35  7/10/2025  MOTION FOR EXPEDITED SCHEDULING ORDER ...`
  This is the highest-signal source for `filedOn` of *individual
  filings* — the Clerk's Record literally enumerates them with dates.
- **Confidence**: **High** for Clerk's Records (they have the explicit
  INDEX) and for any filing referenced by one. **Medium** for
  Reporter's Records (their own "FILED DATE" is on the cover sheet
  but rendered awkwardly by OCR). **Low** for individual motions /
  briefs / responses where the stamp is a visual overlay; the
  underlying body text rarely contains the file-stamp date in
  machine-readable form.
- **LLM strategy**: pass the first chunk + the matching Clerk's Record
  INDEX chunks (if any) for the same case; ask for the ISO date the
  document was "filed of record". Refuse-when-unsure must be enforced.

### 2.2 `receivedOn`

- **Pattern**: filings rarely record a separate "received" date in the
  body text. The "filed by party at portal" vs. "stamped by clerk"
  distinction is captured server-side via FileWatcher's `createdAt`, not
  in the document body.
- **Confidence**: **Low to none** from text. **Recommendation**:
  populate `receivedOn` from `Document.createdAt` (when FileWatcher
  picked the PDF up) — that is a pipeline change, not an LLM extraction.

### 2.3 `fileRef`

Not an extraction problem — see §3. Every Filing has at least one
Document (with two exceptions), so this is purely a wiring fix.

### 2.4 `judgeRef`

- **Pattern A — caption "Honorable X, Judge Presiding".** Excerpt
  (Clerk's Record `4740bf99`):
  `Trial Court Cause No. D-1-FM-25-004488 In the 126th District Court of Travis County, Texas Honorable KEVIN D. HENDERSON Judge Presiding`
  This is gold for the case-level judge.
- **Pattern B — signature block "SIGNED on ___, 2025 / __________ PRESIDING JUDGE".** Excerpt
  (Clerk's Record `4740bf99`):
  `SIGNED on this ____ day of __________________, 2025.        ____________________________________ PRESIDING JUDGE`
  — useful for `Order` and `Judgment` rows (signedBy slot).
- **Pattern C — order header naming the judge.** Excerpt (Order
  `a95acf36`): `UZMEZLER V. STEVENS PAGE 1 OF 2 NO. D-1-FM-25-004488 IN THE MATTER OF ... ORDER ON MOTION FOR WITHDRAWAL OF COUNSEL  On  this  day,  the  Court  considered ...`
  — judge isn't named in the body but the case caption above usually
  carries the "Honorable …" header.
- **Confidence**: **High** for Clerk's Records, Orders, and any document
  with the standard Texas caption. **Medium** for Motions (judge may
  appear only in the TO line "TO THE HONORABLE …"). **Low** for
  Reporter's Records (the judge is named in the proceeding header but
  often only as "THE COURT" once inside the transcript).
- **LLM strategy**: extract the "Honorable X, Judge Presiding" or
  "SIGNED ... PRESIDING JUDGE" lines from the first 2-3 chunks. Match
  the extracted name against `Person.tags.judge==true` rows; if no
  match, surface as a draft `judgeRef` value (string) for the user to
  confirm — never auto-create Persons.

### 2.5 `movantRef`

- **Pattern A — explicit "Movant" prose.** Excerpt (Clerk's Record
  `4740bf99`): `SCHEDULING ORDER On __________________, the Court considered Movant's Motion for Scheduling Conference in this Petition for Bill of Review ...`
  and (same doc): `I am the Respondent in the above-styled cause and the Movant in the pending Emergency Motion to Suspend Enforcement.`
- **Pattern B — caption "Respondent's Motion to …" / "Petitioner's
  Motion to …" identifies the movant by party role.** Excerpt
  (Order `a95acf36`): `ORDER ON MOTION FOR WITHDRAWAL OF COUNSEL` —
  the motion itself usually carries `RESPONDENT'S MOTION TO ...` in the
  title, which the chunk attribution preserves.
- **Confidence**: **High** for motions and motion-attachments (the
  title alone disambiguates Petitioner-vs-Respondent). The hard part is
  resolving "Respondent" → which Person — but the case-level
  `plaintiffRefs` / `defendantRefs` already give the lookup table.
- **LLM strategy**: extract the moving-party role from the motion title
  ("Respondent's Motion to …"), then look up `Case.tags.defendantRefs`
  for the side. If multiple parties on one side, pass the case's party
  list as part of the prompt and ask the model to pick.

### 2.6 `respondentRef`

- Mirror of `movantRef`: derived from the opposing-side role plus the
  case-level party tables. Confidence and strategy are the same. The
  one row in the DB that has both set (`disqualifyCounsel` motion) is a
  manually-tagged example showing the shape.

### 2.7 `reporterRef` (Reporter's Record)

- **Pattern A — cover signature line "Chavela Crain, CSR 3064 - 53rd District Court Texas Certified Shorthand Reporter"** appears verbatim
  on every Reporter's Record volume 1 we sampled. Excerpt (RR
  `032289d1`): `Chavela Crain, CSR 3064 - 53rd District Court Texas Certified Shorthand Reporter  1  REPORTER'S   RECORD VOLUME   1   OF   3   VOLUMES TRIAL   COURT   CAUSE   NO.   D-1-FM-25-004488`.
- **Confidence**: **Very high** — the reporter's name + CSR number is
  the first thing on the cover of every reporter's record. Match against
  `Person.tags.courtReporter==true` rows (Person table has 0 such rows
  right now — `Person markers` query returned all zeros — so this needs
  Person auto-creation OR a "draft reporterRef" workflow).
- **LLM strategy**: extract `(name, CSR#)` from the first chunk; if no
  matching Person, draft the reporter name + offer to create.

### 2.8 `authoredBy`

- **Already partially wired.** Task #27's `deriveOrigin`
  (`src/app/api/haystack/[op]/route.ts:692`) computes origin
  (`selfFiled`/`opposingFiled`/…) from `authoredBy → Person.tags`. So
  *setting* `authoredBy` would cascade origin markers — but only 4 of 76
  sub-entity rows have it set, so origin is mostly inert too.
- **Patterns**:
  - **Signature block "/s/ Name".** Excerpt (Clerk's Record): `I hereby certify that a true and correct copy ... was served on Petitioner, Alper Uzmezler, on July 31, 2025 ... /s/ Ekim Stevens  Ekim Stevens`
  - **Attorney letterhead with State Bar No.** Excerpt (Brief
    `bbfaa6a4`): `BRIEF OF APPELLANT ALPER UZMEZLER James A. Vaught State Bar No. 20526300 VAUGHT LAW FIRM, P.C. 5929 Balcones Drive, Suite 201 Austin, Texas 78731 (512) ...`
  - **Pro-se filer signature** — the same Vaught block but with
    "PRO SE" instead of bar number; Clerk's Record example above
    shows pro-se Alper Uzmezler.
- **Confidence**: **High** for briefs, motions, responses (signature
  block at the end is reliable). **Medium** for short notices and
  letters where the sender may be in the header only. **Low** for
  reporter's records (no party authors them — the reporter does, which
  is a separate `reporterRef`).
- **LLM strategy**: extract from the last 2 chunks (signature block is
  always at the bottom) plus the first chunk (header may name a firm).
  Resolve to a `Person` carrying `lawyer` or `self` marker.

### 2.9 `hearingDate` (Reporter's Record + Transcript)

- **Pattern**: explicit "ON MOTION TO … On the 24th day of September, 2025, the following proceedings came …".
  Excerpt (RR `TRAVIS-D-1-FM-25-004488-RR-VOL002`): `HEARING ON   MOTION   TO   DISQUALIFY AND   MOTION   TO   DISMISS -------------------------------------------------- On   the   24th   day   of   September,   2025,   the   following proceedings came`.
- **Confidence**: **Very high** for Reporter's Records — the date is on
  page 1 of every volume. The pattern is "On the Nth day of <Month>,
  YYYY". A small regex can pull this without an LLM.

---

## 3. fileRef gap

### 3a. Filings with zero linked Documents

| filingType        | total | with≥1 doc | zero docs |
| ----------------- |------:|-----------:|----------:|
| Reporter's Record |    15 |     15     |     0     |
| Motion            |    13 |     11     |     **2** |
| Response          |     5 |      5     |     0     |
| Objection         |     3 |      3     |     0     |
| Petition          |     3 |      3     |     0     |
| Supplement        |     3 |      3     |     0     |
| Brief             |     2 |      2     |     0     |
| Clerk's Record    |     2 |      2     |     0     |
| Notice            |     2 |      2     |     0     |
| Letter            |     1 |      1     |     0     |
| Order             |     1 |      1     |     0     |
| Reply             |     1 |      1     |     0     |
| **Total**         |    51 |     49     |     **2** |

Only **2 Filings have no Document at all** — both `Motion`-typed
(`827bc926`, `a778762d`). These are "naked filings" that need a Document
linked or they should be deleted.

### 3b. Filings with a Document but no fileRef on the sub-entity tag side

Computed as: Filing has ≥1 Document on `Document.filingId`, but the
matching Motion / MotionAttachment / ClerksRecord / ReportersRecord row
has neither `documentId` set nor `tags.fileRef` set.

| Sub-entity        | rows with linked Filing-Document | rows with fileRef set | gap |
| ----------------- |---------------------------------:|----------------------:|----:|
| Motion (n=34)     | 32 (Filing has docs)             | 0                     | **32** |
| MotionAttachment (n=21) | 21                          | 9                     | **12** |
| ClerksRecord (n=2)| 2                                | 0                     | **2** |
| ReportersRecord (n=13) | 13                          | 0                     | **13** |

### 3c. Recommended fix

`fileRef` for each sub-entity should be **derived, not extracted**:
when the sub-entity is materialised (`ensureMotionForFiling` etc., in
`src/app/api/haystack/[op]/route.ts:1204`), pick the Filing's primary
Document and write `documentId` (and emit `tags.fileRef` for haystack
read paths). For multi-Document Filings (rare — the Clerk's Record
case is the only one in this DB), default to the largest/longest doc
and surface a chooser in the panel.

This closes ~59 of the 76 sub-entity rows (all the ones where Filing
has docs) without involving an LLM at all.

---

## 4. Currently-automatic vs. needs-AI

| Field         | Status today                                                                              | Action needed                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `selfFiled`/`opposingFiled`/`courtIssued`/`thirdParty` | **Auto-derived at read-time** by `deriveOrigin` (route.ts:692) from `authoredBy → Person.tags` | Already works — just need `authoredBy` populated; AI extraction of `authoredBy` cascades these for free.        |
| `authoredBy`  | Manual only; ~5% set                                                                      | **AI extraction** from signature block + letterhead. High confidence.                                           |
| `fileRef`     | Plumbing gap — Document is linked to Filing but not propagated to sub-entity              | **Pipeline fix** (no AI). Pick primary Document in `ensureMotionForFiling`/`ensureMotionAttachmentForFiling`/`ensureReportersRecordForFiling`/`ensureClerksRecordForFiling`. |
| `filedOn`     | 0% everywhere; `Filing.filingDate` column is NULL for all 51 Filings                      | **AI extraction**. High signal in Clerk's Record INDEX; medium in cover stamps; supplement with Document.createdAt as `receivedOn` fallback. |
| `receivedOn`  | 0%                                                                                        | **Pipeline fix** — write `Document.createdAt` (or FileWatcher event time) into `receivedOn`. No AI needed.       |
| `judgeRef`    | 0%; case-level `judgeRefs` also empty                                                     | **AI extraction** from caption "Honorable X, Judge Presiding" + signature blocks. High confidence.              |
| `movantRef`/`respondentRef` | <3% set                                                                       | **AI extraction** from motion title + case party tables. High confidence once `Case.plaintiffRefs`/`defendantRefs` are populated. |
| `reporterRef` | 0% (and no `Person.courtReporter` rows exist)                                             | **AI extraction** of `(name, CSR#)` from Reporter's Record cover; first auto-creates Person with `courtReporter` marker. |
| `hearingDate` | 0% on ReportersRecord                                                                     | **Regex** ("On the Nth day of <Month>, YYYY") is sufficient — LLM optional.                                     |
| Case-level prerequisites | `Case.judgeRefs`, `plaintiffRefs`, `defendantRefs` are also empty in this DB   | A first AI pass over each Case's clerk's record / cover briefs to populate the party tables — without these, sub-entity ref resolution has no anchor. |

**Headline:** of the 9 target fields, 4 need an AI extractor
(`authoredBy`, `filedOn`, `judgeRef`, `movantRef`/`respondentRef`,
`reporterRef`), 2 need pipeline plumbing only (`fileRef`, `receivedOn`),
2 are derivable from the previous group (`hearingDate` via regex, the
origin quartet via existing `deriveOrigin`), and the model pre-requisite
`Case.*` party tables also need a first AI pass.

---

## 5. Recommended extractor prompt skeleton

Per-filing call, batched across 4-8 chunks (first 2 + last 2 chunks plus
any chunk containing `FILED`, `SIGNED`, `Honorable`, `Movant`, `/s/`,
or `CSR`):

> "You are reading parts of a single legal filing of type
> `<filingType>` in a `<jurisdiction>` court. The case has parties
> `<plaintiff names>` (plaintiff side) and `<defendant names>`
> (defendant side). Extract the following fields **only if you can
> support them with a verbatim quote from the chunks** — otherwise
> return `null`. Output strict JSON.
>
> Fields:
> - `filedOn`: ISO date the clerk file-stamped this filing (look for
>   "FILED" stamps or a clerk's-record INDEX entry).
> - `judgeName`: the natural-language name in "Honorable X, Judge
>   Presiding" or "/s/ HON. X" (signing judge for orders).
> - `movantPartyRole`: one of `"plaintiff"`, `"defendant"`, `"third-party"`
>   based on the motion title (e.g. "Respondent's Motion to …" →
>   defendant if the defendant is the respondent in the caption).
> - `respondentPartyRole`: the opposite role.
> - `authoredByName`: signature-block or letterhead name; mark
>   `"self"` if the document is signed pro se by the user
>   (`alper@basservices.net` → ALPER UZMEZLER).
> - `reporterName` + `reporterCsrNumber`: Reporter's Record only —
>   from the cover signature line.
> - `hearingDate`: Reporter's Record only — ISO date from "On the Nth
>   day of <Month>, YYYY".
>
> For each non-null field also return a `evidenceQuote` (≤120 chars)
> copied from the chunk text.
>
> Refuse to guess. If two pieces of evidence conflict, return the most
> specific one and flag `"ambiguous": true`."

The downstream resolver then:
1. Looks up `judgeName` / `authoredByName` / `reporterName` against
   `Person` table by name (with `judge` / `lawyer` / `self` /
   `courtReporter` marker scoping).
2. Stores the *string* in a `pendingResolution` tag if no Person
   matches, leaving a chip in the panel for one-click create-and-link.
3. Sets the typed ref tag (`judgeRef`, `authoredBy`, `reporterRef`,
   `movantRef`, `respondentRef`) when a Person matches.
4. Re-runs `deriveOrigin` on save so the origin marker quartet falls
   out for free.

A separate one-time backfill pass should:
- Populate `Document.createdAt` → sub-entity `receivedOn` tag
  (no LLM).
- Set sub-entity `documentId` / `fileRef` from the parent Filing's
  primary Document (no LLM).
- Walk every Clerk's Record's INDEX table and stamp `filedOn` on every
  filing listed there (high-signal, LLM-extracted once per Clerk's
  Record covers many filings at once).

---

## Appendix — code references

- Tag spec: `/Users/alper/Code/court-lens-mcp/src/components/case/tag-spec.ts`
- Origin derivation: `/Users/alper/Code/court-lens-mcp/src/app/api/haystack/[op]/route.ts` lines 647-770 (`deriveOrigin`, `applyOrigin`)
- Sub-entity materialisation: same file, lines 1204-1380 (`ensureMotionForFiling`, `ensureMotionAttachmentForFiling`, `ensureReportersRecordForFiling`, `ensureClerksRecordForFiling`)
- Filing classifier: `/Users/alper/Code/court-lens-mcp/src/services/filing-type-classifier.ts`
- Chunk store schema: LanceDB `chunks` table (fields: `id`, `text`, `document_id`, `case_id`, `page_number`, `chunk_index`, `is_exhibit`, `exhibit_path`, `filing_id`, `filing_type`, `volume_number`, `case_number`, `document_type`, `annotations`)
- DB snapshot: `/Users/alper/Code/court-lens-mcp/prisma/data/sound-suite.db`
