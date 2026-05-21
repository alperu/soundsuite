/**
 * Canonical sample queries surfaced in the search UI's left rail.
 *
 * Each row pairs a plain-English prompt the user can click with the compiled
 * Haystack filter it should resolve to once the freetext interpreter
 * (Task #5 — `POST /api/search/interpret`) is wired up.
 *
 * Until the interpreter lands, the panel falls back to populating the search
 * input with the English prompt and letting the user submit — semantic search
 * still runs over the prompt text.
 *
 * Patterns are drawn from `docs/xeto-haystack-research.md` §5
 * (Person-pool query patterns) and the date/event examples that follow.
 */

export type SampleCategory =
  | 'date'
  | 'judge'
  | 'amendment'
  | 'role'
  | 'hearing'
  | 'person';

export interface SampleQuery {
  /** Plain English the user clicks. */
  englishPrompt: string;
  /** Haystack filter the interpreter should resolve this to. */
  compiledFilter: string;
  /** One-line hint shown on hover. */
  description: string;
  category: SampleCategory;
}

export const SAMPLE_CATEGORY_LABEL: Record<SampleCategory, string> = {
  date: 'By date',
  judge: 'By judge',
  amendment: 'Amendments',
  role: 'By role',
  hearing: 'Hearings',
  person: 'By person',
};

export const SAMPLE_QUERIES: SampleQuery[] = [
  // -- Dates -----------------------------------------------------------------
  {
    englishPrompt: 'Motions filed on 2026-04-15',
    compiledFilter: 'motionEvent and kind=="courtFiled" and courtFilingDate==2026-04-15',
    description: 'Motion events with a clerk file-stamp on a single day',
    category: 'date',
  },
  {
    englishPrompt: 'Motions filed in April 2026',
    compiledFilter:
      'motionEvent and kind=="courtFiled" and courtFilingDate>=2026-04-01 and courtFilingDate<=2026-04-30',
    description: 'File-stamp date range over a whole month',
    category: 'date',
  },
  {
    englishPrompt: 'Motions due before next Friday',
    compiledFilter: 'motion and dueBy<=2026-05-29',
    description: 'Open motions with an approaching deadline',
    category: 'date',
  },

  // -- Judges ----------------------------------------------------------------
  {
    englishPrompt: 'Every motion Judge Roberts signed',
    compiledFilter: 'motionEvent and signed and authoredBy==@person-roberts',
    description: 'Signed motion events authored by a specific judge',
    category: 'judge',
  },
  {
    englishPrompt: 'Motions assigned to Judge Roberts',
    compiledFilter: 'motion and judgeRef==@person-roberts',
    description: 'Motions whose assigned judge matches',
    category: 'judge',
  },

  // -- Amendments ------------------------------------------------------------
  {
    englishPrompt: 'Amended motions to disqualify',
    compiledFilter: 'motion and motionType=="disqualify" and revisionSeq>=2',
    description: 'Motions with at least one amendment in their chain',
    category: 'amendment',
  },
  {
    englishPrompt: 'Proposed orders that have been amended',
    compiledFilter: 'motionAttachment and attachmentKind=="proposedOrder" and revisionSeq>=2',
    description: 'Attachment chains with a superseding revision',
    category: 'amendment',
  },

  // -- Roles -----------------------------------------------------------------
  {
    englishPrompt: 'Every motion Alper filed as movant',
    compiledFilter: 'personRole and movant and personRef==@person-alper',
    description: 'Walk PersonRoles where this person is the movant',
    category: 'role',
  },
  {
    englishPrompt: 'Lawyers admitted on case 24-04-02191-A',
    compiledFilter: 'personRole and lawyer and scopeRef==@case-24-04-02191-A',
    description: 'Lawyers attached to a specific case via PersonRole',
    category: 'role',
  },

  // -- Hearings --------------------------------------------------------------
  {
    englishPrompt: 'Hearings this month',
    compiledFilter: 'motion and hearingDate>=2026-05-01 and hearingDate<=2026-05-31',
    description: 'Motions whose hearing falls in the current month',
    category: 'hearing',
  },
  {
    englishPrompt: 'Hearings held but not yet ruled',
    compiledFilter: 'motionEvent and kind=="hearingHeld"',
    description: 'Motion events recording a hearing taking place',
    category: 'hearing',
  },

  // -- People ----------------------------------------------------------------
  {
    englishPrompt: 'All judges in the system',
    compiledFilter: 'person and judge',
    description: 'Person pool filtered by intrinsic judge marker',
    category: 'person',
  },
  {
    englishPrompt: 'Cases where Alper is a plaintiff',
    compiledFilter: 'case and plaintiffRefs.contains(@person-alper)',
    description: 'Cases containing a specific person as plaintiff',
    category: 'person',
  },
];

/** Recognized token prefixes surfaced in the tag-glossary section. */
export interface TokenGlossaryEntry {
  token: string;
  hint: string;
}

export const TOKEN_GLOSSARY: TokenGlossaryEntry[] = [
  { token: 'case', hint: 'Case ref' },
  { token: 'judge', hint: 'Assigned judge' },
  { token: 'lawyer', hint: 'Attorney of record' },
  { token: 'movant', hint: 'Moving party' },
  { token: 'respondent', hint: 'Responding party' },
  { token: 'clerk', hint: 'Filing clerk' },
  { token: 'reporter', hint: 'Court reporter' },
  { token: 'hearingDate', hint: 'Hearing date' },
  { token: 'filedAfter', hint: 'Court file-stamp on/after' },
  { token: 'filedBefore', hint: 'Court file-stamp on/before' },
  { token: 'motionType', hint: 'Motion category' },
  { token: 'kind', hint: 'Motion event kind' },
  { token: 'attachmentKind', hint: 'Attachment type' },
];
