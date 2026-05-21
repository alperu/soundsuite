/**
 * Map a Filing's classified `filingType` (one of the 21 canonical strings from
 * `src/services/filing-type-classifier.ts`) to the tag-panel `EntityKind` that
 * controls which tag spec the panel renders.
 *
 * The mapping:
 *   - Motion           → `motion`
 *   - Clerk's Record   → `clerksRecord`
 *   - Reporter's Record→ `reportersRecord`
 *   - everything else  → `motionAttachment` (with an `attachmentKindHint`
 *                        suggesting which MotionAttachment marker would apply
 *                        if/when a MotionAttachment row exists).
 *
 * v1 note: the hint is informational only — the actual MotionAttachment row
 * isn't always present at the time the page renders; we surface the EntityKind
 * so the tag panel can show the right marker set, and the hint is exposed for
 * future seeding/UI use.
 */
import type { EntityKind } from '@/components/case/tag-spec';

export type AttachmentKindHint =
  | 'proposedOrder'
  | 'brief'
  | 'response'
  | 'email'
  | 'evidence'
  | 'exhibit'
  | 'supportingDoc'
  | 'order'
  | 'transcript'
  | 'affidavit'
  | 'subpoena'
  | 'judgment'
  | 'settlement'
  | 'notice'
  | 'rfa'
  | 'billOfReview'
  | 'petition';

export interface FilingEntityClassification {
  entityKind: EntityKind;
  /** Optional MotionAttachment.attachmentKind hint when entityKind === 'motionAttachment'. */
  attachmentKindHint?: AttachmentKindHint;
}

/**
 * Best-guess mapping from Filing.filingType → EntityKind (+ optional
 * attachmentKind hint for motionAttachment cases). Match is
 * case-insensitive and tolerant of apostrophe variants.
 */
export function classifyFilingEntityKind(
  filingType: string | null | undefined,
): FilingEntityClassification {
  const norm = normalize(filingType);

  // Case-level records get their own entity kinds.
  if (norm === "clerks record" || norm === 'clerksrecord' || norm === 'cr') {
    return { entityKind: 'clerksRecord' };
  }
  if (norm === "reporters record" || norm === 'reportersrecord' || norm === 'rr') {
    return { entityKind: 'reportersRecord' };
  }

  // Motion is its own first-class entity.
  if (norm === 'motion') return { entityKind: 'motion' };

  // Everything else → motionAttachment, with a hint of which marker applies.
  const hint = ATTACHMENT_KIND_HINTS[norm];
  return { entityKind: 'motionAttachment', attachmentKindHint: hint };
}

/** Lowercase + strip punctuation + collapse whitespace. */
function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Mapping from a normalized filingType string → MotionAttachment.attachmentKind
 * marker. Any filingType that isn't Motion / Clerk's Record / Reporter's Record
 * routes here; unknown strings fall through to `motionAttachment` with no hint.
 */
const ATTACHMENT_KIND_HINTS: Record<string, AttachmentKindHint> = {
  brief: 'brief',
  response: 'response',
  reply: 'response',
  notice: 'notice',
  petition: 'petition',
  affidavit: 'affidavit',
  subpoena: 'subpoena',
  judgment: 'judgment',
  decree: 'judgment',
  order: 'order',
  settlement: 'settlement',
  'bill of review': 'billOfReview',
  'return of service': 'supportingDoc',
  'demand letter': 'email',
  letter: 'email',
  objection: 'supportingDoc',
  request: 'rfa',
  supplement: 'supportingDoc',
  designation: 'supportingDoc',
  transcript: 'transcript',
};
