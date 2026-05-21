/**
 * Map a Filing's classified `filingType` (one of the 24 canonical strings
 * from `src/services/filing-type-classifier.ts`) to the tag-panel
 * `EntityKind` that controls which tag spec the panel renders.
 *
 * Each of the 24 filing types now has its own EntityKind so the tag panel
 * surfaces the right per-type markers/refs/values. The `attachmentKindHint`
 * stays in the return shape for downstream consumers; it mirrors the entity
 * kind for back-compat (and falls back to a sensible value for the special
 * Motion / Clerk's Record / Reporter's Record cases).
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
  | 'petition'
  | 'letter'
  | 'decree'
  | 'reply'
  | 'returnOfService'
  | 'demandLetter'
  | 'objection'
  | 'request'
  | 'supplement'
  | 'designation'
  | 'other';

export interface FilingEntityClassification {
  entityKind: EntityKind;
  /** Optional MotionAttachment.attachmentKind hint. For backwards compat
   *  with downstream consumers — defaults to the camelCase of the kind. */
  attachmentKindHint?: AttachmentKindHint;
}

/**
 * Best-guess mapping from Filing.filingType → EntityKind. Match is
 * case-insensitive and tolerant of apostrophe variants.
 */
export function classifyFilingEntityKind(
  filingType: string | null | undefined,
): FilingEntityClassification {
  const norm = normalize(filingType);

  // Case-level records get their own entity kinds and no attachment hint
  // (they aren't MotionAttachment rows).
  if (norm === 'clerks record' || norm === 'clerksrecord' || norm === 'cr') {
    return { entityKind: 'clerksRecord' };
  }
  if (norm === 'reporters record' || norm === 'reportersrecord' || norm === 'rr') {
    return { entityKind: 'reportersRecord' };
  }

  // Motion is its own first-class entity.
  if (norm === 'motion') return { entityKind: 'motion' };

  const kind = FILING_TYPE_TO_KIND[norm];
  if (!kind) {
    // Unknown / empty input → fall through to 'other'.
    return { entityKind: 'other', attachmentKindHint: 'other' };
  }

  const hint = ATTACHMENT_KIND_HINTS[kind];
  return hint
    ? { entityKind: kind, attachmentKindHint: hint }
    : { entityKind: kind };
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
 * Normalized filing-type label → EntityKind. Covers all 24 canonical
 * filing types from filing-type-classifier.ts (minus Motion / Clerk's
 * Record / Reporter's Record which are special-cased above).
 */
const FILING_TYPE_TO_KIND: Record<string, EntityKind> = {
  notice: 'notice',
  letter: 'letter',
  order: 'order',
  petition: 'petition',
  affidavit: 'affidavit',
  subpoena: 'subpoena',
  brief: 'brief',
  response: 'response',
  reply: 'reply',
  judgment: 'judgment',
  decree: 'decree',
  transcript: 'transcript',
  settlement: 'settlement',
  'bill of review': 'billOfReview',
  'return of service': 'returnOfService',
  'demand letter': 'demandLetter',
  objection: 'objection',
  request: 'request',
  supplement: 'supplement',
  designation: 'designation',
  other: 'other',
};

/**
 * Per-entity-kind hint for downstream consumers that still want a
 * MotionAttachment.attachmentKind-style label. Most kinds map identity-style
 * (brief → brief); a few use the legacy supportingDoc / email / rfa labels
 * that the original MotionAttachment.attachmentKind enum used.
 */
const ATTACHMENT_KIND_HINTS: Partial<Record<EntityKind, AttachmentKindHint>> = {
  notice: 'notice',
  letter: 'letter',
  order: 'order',
  proposedOrder: 'proposedOrder',
  petition: 'petition',
  affidavit: 'affidavit',
  subpoena: 'subpoena',
  brief: 'brief',
  response: 'response',
  reply: 'reply',
  judgment: 'judgment',
  decree: 'decree',
  transcript: 'transcript',
  settlement: 'settlement',
  billOfReview: 'billOfReview',
  returnOfService: 'returnOfService',
  demandLetter: 'demandLetter',
  objection: 'objection',
  request: 'request',
  supplement: 'supplement',
  designation: 'designation',
  other: 'other',
};

/**
 * Canonical list of per-filing-type EntityKinds → MotionAttachment.attachmentKind.
 * Single source of truth for routing/validation across:
 *  - `tableFromFilter` in `src/lib/legal/repo.ts` (panel `filter=<kind>` → table)
 *  - `KIND_TO_ATTACHMENT_KIND` in `src/app/api/haystack/[op]/route.ts`
 *    (auto-upsert + commit kind resolution)
 *  - `KIND_MODEL_MAP` in the same file (kind → Prisma model name)
 *
 * Each key is a camelCase EntityKind from `tag-spec.ts`; the value is the
 * `MotionAttachment.attachmentKind` discriminator. Identity mapping today —
 * if a future EntityKind ever splits or renames its attachmentKind, this is
 * the only place that needs to know. `motion` / `case` / `clerksRecord` /
 * `reportersRecord` are NOT here: they have dedicated Prisma tables.
 */
export const PER_FILING_TYPE_KINDS: Record<string, string> = {
  notice: 'notice',
  letter: 'letter',
  order: 'order',
  proposedOrder: 'proposedOrder',
  petition: 'petition',
  affidavit: 'affidavit',
  subpoena: 'subpoena',
  brief: 'brief',
  response: 'response',
  reply: 'reply',
  judgment: 'judgment',
  decree: 'decree',
  transcript: 'transcript',
  settlement: 'settlement',
  billOfReview: 'billOfReview',
  returnOfService: 'returnOfService',
  demandLetter: 'demandLetter',
  objection: 'objection',
  request: 'request',
  supplement: 'supplement',
  designation: 'designation',
  other: 'other',
};
