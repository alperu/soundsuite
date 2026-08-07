/**
 * Structure-hint extraction (task #13 phase 3b).
 *
 * Detects query shapes that target document STRUCTURE rather than content
 * topics. Deliberately separate from classifyQueryComplexity — that returns
 * a cost tier; these are retrieval-filter signals on an orthogonal axis.
 *
 * Current hints:
 *  - "the table on page 12"    → { tablePage: 12 }   (hard boost for
 *   block_type='table' sources on that page; a future no-retrieval route
 *   can serve it straight from the structure API once document scope is
 *   resolvable from the conversation)
 *  - "what did THE COURT say"  → { speaker: 'THE COURT' } (boost sources
 *   whose speakers column contains the label)
 */

export interface StructureHint {
  /** Page number from an explicit "table on page N" ask. */
  tablePage?: number;
  /** Speaker label from a "what did X say/ask/testify" ask — normalized
   * to the RR producer's label forms (THE COURT, MR. DOE, Q, A). */
  speaker?: string;
}

const TABLE_PAGE_RE = /\btables?\s+(?:on|at|from)\s+page\s+(\d{1,4})\b/i;

// Speaker label shapes the RR producer emits: THE COURT / THE WITNESS /
// MR. X / MS. X / MRS. X / DR. X / JUDGE X. Query verbs: say/ask/testify/
// state/argue/object.
const SPEAKER_RE = /\bwhat\s+did\s+(the\s+(?:court|witness|bailiff|interpreter|clerk)|(?:mr|ms|mrs|dr)\.?\s+[a-z][a-z-]+|judge\s+[a-z][a-z-]+)\s+(?:say|ask|testify|state|argue|object)/i;

export function extractStructureHint(query: string): StructureHint {
  const hint: StructureHint = {};

  const table = TABLE_PAGE_RE.exec(query);
  if (table) {
    const n = parseInt(table[1], 10);
    if (Number.isFinite(n) && n > 0) hint.tablePage = n;
  }

  const speaker = SPEAKER_RE.exec(query);
  if (speaker) {
    // Normalize to the producer's uppercase label form: 'the court' →
    // 'THE COURT'; 'mr smith' → 'MR. SMITH'.
    let label = speaker[1].toUpperCase().replace(/\s+/g, ' ').trim();
    label = label.replace(/^(MR|MS|MRS|DR)\.?\s/, '$1. ');
    hint.speaker = label;
  }

  return hint;
}

/** True when a source's delimited speakers column contains the label. */
export function speakersInclude(speakers: string | undefined, label: string): boolean {
  if (!speakers) return false;
  return speakers.toUpperCase().includes(`|${label.toUpperCase()}|`);
}
