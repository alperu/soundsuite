/**
 * filter-logic-catalogue.ts
 *
 * Runtime catalogue of filterable XETO fields, mirroring the type definitions
 * in `src/lib/legal/types.ts` by hand.
 *
 * WHY THIS DUPLICATES `types.ts`:
 *   TypeScript interfaces are erased at runtime — we cannot enumerate their
 *   keys to build a UI. Codegen from XETO → JSON-Schema → TS is future work
 *   (see types.ts header). Until then, this catalogue is maintained by hand
 *   and gated by compile-time `_check_*` guards below. If a CaseTags / PersonTags /
 *   MotionTags key is renamed, those guards fail to compile.
 *
 * WHAT GOES IN:
 *   Only fields that are actually filterable end-to-end — i.e. they have a
 *   resolver in `src/lib/search/boolean-to-fts.ts` (FIELD_RESOLVERS,
 *   CASE_ATTRIBUTE_ALLOWLIST, PERSON_ATTRIBUTE_ALLOWLIST, CASE_PERSON_HOPS).
 *   Fields that exist in the XETO schema but have no resolver yet are listed
 *   in KNOWN_BROKEN at the bottom for follow-up.
 */

import type { CaseTags, PersonTags, MotionTags } from '@/lib/legal/types';

// ---------------------------------------------------------------------------
// Compile-time guards. If these break, the catalogue is out of sync with
// types.ts and must be updated by hand.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _check_caseTags: Pick<CaseTags, 'causeNo' | 'jurisdictionRef' | 'courtRef' | 'judgeRefs'> = {
  causeNo: '',
  jurisdictionRef: '',
  courtRef: undefined,
  judgeRefs: undefined,
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _check_personTags: Pick<PersonTags, 'displayName' | 'email' | 'barNumber' | 'jurisdictionRef'> = {
  displayName: '',
  email: undefined,
  barNumber: undefined,
  jurisdictionRef: undefined,
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _check_motionTags: Pick<MotionTags, 'motionType' | 'caseRef' | 'judgeRef' | 'movantRef' | 'respondentRef'> = {
  motionType: '',
  caseRef: '',
  judgeRef: undefined,
  movantRef: undefined,
  respondentRef: undefined,
};

// ---------------------------------------------------------------------------
// Catalogue shape
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'date' | 'number' | 'ref' | 'marker';

export interface CatalogueField {
  /** Field name as the user types it in the search bar. */
  name: string;
  type: FieldType;
  /** Click-to-insert example string. */
  example: string;
}

export interface CatalogueSection {
  /** Human label, e.g. 'Case'. */
  name: string;
  /** The XETO marker on the entity, e.g. 'case'. */
  marker: string;
  /** Query path-prefix (same as marker today). */
  path: string;
  fields: CatalogueField[];
}

// ---------------------------------------------------------------------------
// Catalogue contents — only fields backed by a resolver in boolean-to-fts.ts
// ---------------------------------------------------------------------------

export const CATALOGUE: CatalogueSection[] = [
  {
    name: 'Case',
    marker: 'case',
    path: 'case',
    fields: [
      // Direct lance-scalar resolvers (FIELD_RESOLVERS)
      { name: 'case',         type: 'string', example: 'case=="23-CV-1234"' },
      { name: 'caseNumber',   type: 'string', example: 'caseNumber=="23-CV-1234"' },
      { name: 'caseId',       type: 'string', example: 'caseId=="abc123"' },
      { name: 'caseRef',      type: 'ref',    example: 'caseRef==@<case-uuid>' },
      // case-attribute traversals (CASE_ATTRIBUTE_ALLOWLIST)
      { name: 'case->jurisdiction', type: 'string', example: 'case->jurisdiction=="Texas"' },
      { name: 'case->state',        type: 'string', example: 'case->state=="TX"' },
      { name: 'case->county',       type: 'string', example: 'case->county=="Travis"' },
      { name: 'case->country',      type: 'string', example: 'case->country=="USA"' },
      { name: 'case->name',         type: 'string', example: 'case->name=="Smith v. Jones"' },
      { name: 'case->caseNumber',   type: 'string', example: 'case->caseNumber=="23-CV-1234"' },
      // Task #66: XETO marker tags (presence flags in `Case.tags` JSON).
      { name: 'case->case',            type: 'marker', example: 'case->case==true' },
      { name: 'case->site',            type: 'marker', example: 'case->site==true' },
      { name: 'case->jurisdictionTx',  type: 'marker', example: 'case->jurisdictionTx==true' },
      { name: 'case->jurisdictionCa',  type: 'marker', example: 'case->jurisdictionCa==true' },
      { name: 'case->jurisdictionNy',  type: 'marker', example: 'case->jurisdictionNy==true' },
    ],
  },
  {
    name: 'Filing',
    marker: 'filing',
    path: 'filing',
    fields: [
      { name: 'filingId',   type: 'string', example: 'filingId=="abc123"' },
      { name: 'filingRef',  type: 'ref',    example: 'filingRef==@<filing-uuid>' },
      { name: 'filingType', type: 'string', example: 'filingType=="RR"' },
    ],
  },
  {
    name: 'Document',
    marker: 'document',
    path: 'document',
    fields: [
      { name: 'documentId',   type: 'string', example: 'documentId=="abc123"' },
      { name: 'fileRef',      type: 'ref',    example: 'fileRef==@<doc-uuid>' },
      { name: 'documentType', type: 'string', example: 'documentType=="order denying"' },
      { name: 'pageNumber',   type: 'number', example: 'pageNumber >= 1' },
      { name: 'chunkIndex',   type: 'number', example: 'chunkIndex >= 0' },
      { name: 'volumeNumber', type: 'number', example: 'volumeNumber >= 1' },
    ],
  },
  {
    name: 'Motion',
    marker: 'motion',
    path: 'motion',
    fields: [
      { name: 'motionType',    type: 'string', example: 'motionType=="disqualification"' },
      { name: 'judgeRef',      type: 'ref',    example: 'judgeRef==@<person-uuid>' },
      { name: 'movantRef',     type: 'ref',    example: 'movantRef==@<person-uuid>' },
      { name: 'respondentRef', type: 'ref',    example: 'respondentRef==@<person-uuid>' },
    ],
  },
  {
    name: 'Person',
    marker: 'person',
    path: 'person',
    fields: [
      // Person ref-attribute traversals (PERSON_ATTRIBUTE_ALLOWLIST)
      { name: 'judgeRef->displayName',      type: 'string', example: 'judgeRef->displayName=="Roberts"' },
      { name: 'judgeRef->email',            type: 'string', example: 'judgeRef->email=="smith@court.gov"' },
      { name: 'judgeRef->barNumber',        type: 'string', example: 'judgeRef->barNumber=="123456"' },
      { name: 'movantRef->displayName',     type: 'string', example: 'movantRef->displayName=="Smith"' },
      { name: 'respondentRef->displayName', type: 'string', example: 'respondentRef->displayName=="Jones"' },
      { name: 'lawyerRef->displayName',     type: 'string', example: 'lawyerRef->displayName=="Smith"' },
      { name: 'clerkRef->displayName',      type: 'string', example: 'clerkRef->displayName=="Smith"' },
      { name: 'reporterRef->displayName',   type: 'string', example: 'reporterRef->displayName=="Smith"' },
      // 3-hop via case
      { name: 'case->judge->displayName',      type: 'string', example: 'case->judge->displayName=="Roberts"' },
      { name: 'case->movant->displayName',     type: 'string', example: 'case->movant->displayName=="Smith"' },
      { name: 'case->respondent->displayName', type: 'string', example: 'case->respondent->displayName=="Jones"' },
    ],
  },
];

/** Curated examples used in the panel's bottom row. One per query shape. */
export const FEATURED_EXAMPLES: string[] = [
  'case=="23-CV-1234"',                                // scalar equality
  'motion and motionType=="disqualification"',         // marker + scalar
  'caseRef==@<case-uuid>',                             // ref
  'case->judge->displayName=="Roberts"',               // path traversal
  'case->jurisdictionTx==true',                        // XETO marker tag (#66)
];

/** Comparison operators rendered as the top toolbar. */
export const OPERATORS: { token: string; insert: string }[] = [
  { token: '==', insert: '==' },
  { token: '!=', insert: '!=' },
  { token: '>=', insert: '>=' },
  { token: '<=', insert: '<=' },
  { token: '>',  insert: '>'  },
  { token: '<',  insert: '<'  },
];

/** Boolean keywords / grouping. */
export const BOOLEANS: { token: string; insert: string }[] = [
  { token: 'and', insert: 'and' },
  { token: 'or',  insert: 'or'  },
  { token: 'not', insert: 'not' },
  { token: '(',   insert: '()'  },
  { token: ')',   insert: ')'   },
];

/**
 * Fields that exist in the XETO schema (types.ts) but currently have no
 * resolver in boolean-to-fts.ts. Promote into CATALOGUE as resolvers land.
 *
 * Tracked here so future work has a single grep target.
 */
export const KNOWN_BROKEN: string[] = [
  // CaseTags
  'causeNo', 'jurisdictionRef', 'courtRef', 'judgeRefs', 'plaintiffRefs',
  'defendantRefs', 'respondentRefs', 'movantRefs', 'courtClerkRefs',
  'courtReporterRefs', 'filedOn', 'causeFiledStamp',
  // PersonTags scalars/markers
  'person', 'displayName', 'email', 'barNumber',
  'lawyer', 'judge', 'courtClerk', 'courtReporter', 'bailiff', 'proSe', 'self',
  // MotionTags
  'motion (marker)', 'caseRef (on motion)', 'siteRef', 'motionRef', 'subMotion',
  'amends', 'supersedes', 'revisionSeq',
  // MotionEventTags
  'motionEvent', 'occurredOn', 'courtFilingDate', 'causeNoStamp',
  'fileRef', 'authoredBy', 'servedOn', 'courtClerkRef', 'courtReporterRef',
  'hearingRef', 'received', 'filed', 'courtFiled', 'responded', 'signed',
  'granted', 'denied', 'served', 'hearingHeld', 'withdrawn', 'mooted',
  // HearingTags
  'hearing', 'hybrid', 'caseRefs', 'motionRefs', 'scheduledFor', 'heldOn',
  'durationMin', 'location', 'remote', 'transcriptRef', 'hearingType',
  // JurisdictionTags / CourtTags
  'jurisdiction (marker)', 'code', 'parent',
  'court', 'district',
  // MotionAttachmentTags
  'attachment', 'proposedOrder', 'brief', 'response', 'exhibit', 'label',
  'evidence', 'supportingDoc',
  // PersonRoleTags
  'personRole', 'personRef', 'scopeRef', 'movant', 'respondent', 'defendant',
  'plaintiff', 'intervenor', 'lawyerMovant', 'lawyerRespondent',
  'appearedOn', 'withdrewOn',
];
