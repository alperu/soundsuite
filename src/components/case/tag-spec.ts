/**
 * Hand-written stub of the XETO tag taxonomy from
 * docs/xeto-haystack-research.md §5. Used as the fallback when
 * /api/haystack/defs is not reachable.
 *
 * Tier = which UI section the tag renders into:
 *   marker — boolean (chip)
 *   ref    — reference to another haystack record (single)
 *   refs   — list-valued ref
 *   value  — scalar string/number/date
 *
 * EntityKind = which selection kind shows this tag by default.
 */

export type TagTier = 'marker' | 'ref' | 'refs' | 'value';
export type EntityKind =
  | 'case'
  | 'motion'
  | 'motionEvent'
  | 'motionAttachment'
  | 'hearing'
  | 'clerksRecord'
  | 'reportersRecord'
  // Per-filing-type entity kinds (one per canonical filing type from
  // src/services/filing-type-classifier.ts). Each extends MotionAttachment
  // in the XETO spec; here we render type-specific marker/ref/value sets.
  | 'notice'
  | 'letter'
  | 'order'
  | 'proposedOrder'
  | 'petition'
  | 'affidavit'
  | 'subpoena'
  | 'brief'
  | 'response'
  | 'reply'
  | 'judgment'
  | 'decree'
  | 'transcript'
  | 'settlement'
  | 'billOfReview'
  | 'returnOfService'
  | 'demandLetter'
  | 'objection'
  | 'request'
  | 'supplement'
  | 'designation'
  | 'other';

/**
 * Rich info shown in the click-to-open "?" popover. Optional — when absent,
 * the popover falls back to rendering `spec.doc` as a plain paragraph.
 *
 * The fields are deliberately granular so the popover can render structured
 * sections (definition, derivation, persistence, XETO reference, example,
 * related tags). All are optional except `whatItIs` so partial backfills
 * still surface useful content.
 */
export interface TagInfo {
  /** 1-line plain-English definition. Required when info is set. */
  whatItIs: string;
  /** Derivation, cascade, or compute rules (free-form prose). */
  howItWorks?: string;
  /**
   * Where the tag lives on the server side. Use one of:
   *   - "Prisma.<Model>.<column> (column)"
   *   - "tags JSON: '$.<path>'"
   *   - "computed (<source>)"
   */
  mapsTo?: string;
  /** Fully-qualified XETO slot path (e.g. "cc.courtlens.legal::Case.causeNo"). */
  xetoSpec?: string;
  /** Sample value or usage. */
  example?: string;
  /** Related tag names — UI shows as clickable chips that swap the popover. */
  relatedTags?: string[];
}

export interface TagSpec {
  name: string;
  tier: TagTier;
  /** XETO doc string — shown in the (?) tooltip. */
  doc: string;
  /** Value type hint for the editor (text/number/date/bool/ref). */
  valueType?: 'text' | 'number' | 'date' | 'bool' | 'ref';
  /** For ref-typed tags, which entityKind the target should be. */
  refTarget?: 'person' | 'motion' | 'case' | 'court' | 'hearing' | 'doc' | 'motionAttachment';
  /** Haystack ontology plumbing — not surfaced in the tag panel UI.
   *  These markers exist on records so a SkySpark/Haxall client can traverse
   *  via the standard site/equip/point idiom; they carry no information the
   *  user can act on, so the panel hides them. They stay in the record. */
  internal?: boolean;
  /**
   * Rich info shown when the user clicks the "?" icon. Falls back to `doc`
   * when absent. Backfilled for the most-touched tags; other entries render
   * the `doc` string only until a future pass populates them.
   */
  info?: TagInfo;
}

/**
 * Origin (filing provenance) marker quartet. Derived server-side from
 * `authoredBy` Person + their PersonRole; a value here is a manual
 * override that wins over derivation (Task #27). Shared across Motion,
 * MotionEvent, MotionAttachment, ClerksRecord, ReportersRecord, and every
 * per-filing-type alias via `attachmentBaseSpec`.
 */
const ORIGIN_MARKERS: TagSpec[] = [
  {
    name: 'selfFiled',
    tier: 'marker',
    doc: 'I authored / my counsel filed this filing.',
    valueType: 'bool',
    info: {
      whatItIs: 'Provenance marker — this filing came from me (or my counsel).',
      howItWorks: 'Derived server-side from authoredBy → Person with `self: true` marker. Override by setting `selfFiled: true` in tags JSON; the override always wins over derivation.',
      mapsTo: "tags JSON: '$.selfFiled' (override) OR computed (deriveOrigin)",
      xetoSpec: 'cc.courtlens.legal::SelfFiled (Origin)',
      relatedTags: ['opposingFiled', 'courtIssued', 'thirdParty', 'authoredBy'],
    },
  },
  {
    name: 'opposingFiled',
    tier: 'marker',
    doc: 'Opposing counsel / opposing party filed this.',
    valueType: 'bool',
    info: {
      whatItIs: 'Provenance marker — this filing came from the opposing side.',
      howItWorks: 'Derived from authoredBy + their PersonRole on this Case: when the author is plaintiff and self is defendant (or vice versa), the marker is emitted. Override by setting `opposingFiled: true` in tags JSON.',
      mapsTo: "tags JSON: '$.opposingFiled' (override) OR computed (deriveOrigin)",
      xetoSpec: 'cc.courtlens.legal::OpposingFiled (Origin)',
      relatedTags: ['selfFiled', 'courtIssued', 'thirdParty', 'authoredBy'],
    },
  },
  {
    name: 'courtIssued',
    tier: 'marker',
    doc: 'The court (judge, clerk, or reporter) issued this filing.',
    valueType: 'bool',
    info: {
      whatItIs: 'Provenance marker — this filing was issued by the court itself, not a party.',
      howItWorks: 'Derived from authoredBy → Person with `judge`, `courtClerk`, or `courtReporter` markers. Also applied as a fast-path for MotionEvent rows with kind="signed". Override by setting `courtIssued: true` in tags JSON.',
      mapsTo: "tags JSON: '$.courtIssued' (override) OR computed (deriveOrigin)",
      xetoSpec: 'cc.courtlens.legal::CourtIssued (Origin)',
      relatedTags: ['selfFiled', 'opposingFiled', 'thirdParty', 'authoredBy'],
    },
  },
  {
    name: 'thirdParty',
    tier: 'marker',
    doc: 'A non-party (amicus, witness, intervenor) filed this.',
    valueType: 'bool',
    info: {
      whatItIs: 'Provenance marker — this filing came from someone who is neither a party to the case nor the court.',
      howItWorks: 'Fallback derivation: authoredBy is set but the author has no self/judge/clerk/reporter marker and no plaintiff/defendant role in this case. Override by setting `thirdParty: true` in tags JSON.',
      mapsTo: "tags JSON: '$.thirdParty' (override) OR computed (deriveOrigin)",
      xetoSpec: 'cc.courtlens.legal::ThirdParty (Origin)',
      relatedTags: ['selfFiled', 'opposingFiled', 'courtIssued', 'authoredBy'],
    },
  },
]

/**
 * Shared "every filing has these" tag specs. Hoisted out of
 * `attachmentBaseSpec` so they can be spread into kinds that don't go
 * through that helper (Motion, MotionAttachment, ClerksRecord,
 * ReportersRecord). Each tag carries a rich `info` block so the (?)
 * popover renders consistently across every filing kind.
 *
 * Why a global helper instead of per-kind inlining: the user-facing
 * model promises "every filing knows when it was filed, when we received
 * it, and which PDF it lives in." Keeping one source of truth prevents
 * drift (e.g. only Motion gets a richer howItWorks string).
 */
const FILING_FILE_REF_SPEC: TagSpec = {
  name: 'fileRef',
  tier: 'ref',
  doc: 'Reference to the document (PDF).',
  refTarget: 'doc',
  info: {
    whatItIs: 'Pointer to the underlying PDF Document this filing was extracted from.',
    howItWorks: 'Synthesized server-side from the row\'s `documentId` foreign key on read; the Document row carries the actual file path, sha256, and OCR text. Manually overriding `fileRef` in tags JSON wins over the column when both are present.',
    mapsTo: 'Prisma.<Model>.documentId (column) — emitted as Haystack ref @<doc-id>',
    xetoSpec: 'cc.courtlens.legal::MotionAttachment.fileRef (inherited by every filing subtype)',
    example: '@doc-stamped-petition-a31',
    relatedTags: ['caseRef', 'motionRef', 'authoredBy'],
  },
}

const FILING_FILED_ON_SPEC: TagSpec = {
  name: 'filedOn',
  tier: 'value',
  doc: 'Date filed with the court.',
  valueType: 'date',
  info: {
    whatItIs: 'Date this filing was filed with the court clerk (legally-operative filing date).',
    howItWorks: 'On a filing row this is the clerk-stamp date — the date the deadline clock starts for this filing. Distinct from `receivedOn` (when WE got the PDF) and from MotionEvent.courtFilingDate (the lifecycle event\'s timestamp). When unset, the tag panel leaves it blank rather than guessing.',
    mapsTo: "tags JSON: '$.filedOn' (ISO date) — column on ClerksRecord; tags-only elsewhere",
    xetoSpec: 'cc.courtlens.legal::MotionAttachment.filedOn (inherited by every filing subtype)',
    example: '2024-03-15',
    relatedTags: ['receivedOn', 'courtFilingDate', 'courtFiled'],
  },
}

const FILING_RECEIVED_ON_SPEC: TagSpec = {
  name: 'receivedOn',
  tier: 'value',
  doc: 'Date received.',
  valueType: 'date',
  info: {
    whatItIs: 'Date we received this filing into Sound Suite (drop-folder, email ingestion, manual upload).',
    howItWorks: 'Independent of `filedOn`: a filing may be filed on day N with the clerk and received by us days later (mail delay, late forwarding from co-counsel). Used by the inbox / triage views to sort by ingestion recency; the deadline engine never anchors on this date.',
    mapsTo: "tags JSON: '$.receivedOn' (ISO date)",
    xetoSpec: 'cc.courtlens.legal::MotionAttachment.receivedOn (inherited by every filing subtype)',
    example: '2024-03-17',
    relatedTags: ['filedOn', 'received'],
  },
}

/**
 * Helper: the common MotionAttachment-derived tag set every per-filing-type
 * entity inherits. Returns a fresh array each call (the kind marker is
 * type-specific). Order is: markers → refs → values, matching the UI grouping.
 */
function attachmentBaseSpec(kindMarker: string, kindDoc: string): TagSpec[] {
  return [
    // markers
    { name: kindMarker, tier: 'marker', doc: kindDoc, valueType: 'bool' },
    {
      name: 'motion',
      tier: 'marker',
      doc: 'This filing is procedurally a motion (in addition to its specific type).',
      valueType: 'bool',
      info: {
        whatItIs: 'Marker indicating this filing is structurally a motion — asks the court to do something — in addition to whatever specific type it is.',
        howItWorks: 'Many filings are simultaneously a motion and something else: "Motion for Entry of Order" is both a motion AND an order, "Brief in Support of Motion to Disqualify" is both a brief AND a motion. Setting `motion: true` lets the filing surface in motion-shaped searches like `motion and signed`.',
        mapsTo: "tags JSON: '$.motion'",
        xetoSpec: 'cc.courtlens.legal::Motion (cross-applies as marker on attachments)',
        example: 'true (marker)',
        relatedTags: ['motionRef', 'amends', 'motionType'],
      },
    },
    { name: 'attachment', tier: 'marker', doc: 'Marker: attachment to a Motion.', internal: true, valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Filed at the appellate level.', valueType: 'bool' },
    { name: 'urgent', tier: 'marker', doc: 'Flagged as urgent.', valueType: 'bool' },
    { name: 'amended', tier: 'marker', doc: 'This filing amends a prior one.', valueType: 'bool' },
    { name: 'confidential', tier: 'marker', doc: 'Confidential filing.', valueType: 'bool' },
    { name: 'sealed', tier: 'marker', doc: 'Sealed by court order.', valueType: 'bool' },
    // Origin (filing provenance) — derived server-side from authoredBy;
    // a value here is a manual override that wins over derivation.
    ...ORIGIN_MARKERS,
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    FILING_FILE_REF_SPEC,
    { name: 'authoredBy', tier: 'ref', doc: 'Person who authored this filing.', refTarget: 'person' },
    // Court personnel attached to THIS filing. Different filings on the same
    // case can have different clerks/reporters (trial-court clerk vs.
    // appellate-court clerk; record-of-trial reporter vs. appellate reporter).
    {
      name: 'clerkRef',
      tier: 'ref',
      doc: 'Court clerk responsible for this filing (trial vs. appellate court can differ).',
      refTarget: 'person',
      info: {
        whatItIs: 'Reference to the court clerk who certified, filed, or otherwise attests this filing.',
        howItWorks: 'Constrained to Person rows with the `courtClerk` marker. Set per-filing because trial and appellate courts have different clerks; a single case can carry filings from both venues.',
        mapsTo: "tags JSON: '$.clerkRef'",
        xetoSpec: 'cc.courtlens.legal::MotionAttachment.clerkRef',
        example: '@person-jane-doe',
        relatedTags: ['reporterRef', 'caseRef'],
      },
    },
    {
      name: 'reporterRef',
      tier: 'ref',
      doc: 'Court reporter responsible for this filing (typically transcripts and reporter’s records).',
      refTarget: 'person',
      info: {
        whatItIs: 'Reference to the court reporter who produced or certified the transcript / reporter’s-record associated with this filing.',
        howItWorks: 'Constrained to Person rows with the `courtReporter` marker. Set per-filing because volumes within a case can be produced by different reporters (e.g. one per hearing date or per appellate volume).',
        mapsTo: "tags JSON: '$.reporterRef'",
        xetoSpec: 'cc.courtlens.legal::ReportersRecord.reporterRef',
        example: '@person-jeffrey-kyle',
        relatedTags: ['clerkRef', 'caseRef'],
      },
    },
    { name: 'amends', tier: 'ref', doc: 'Attachment this one amends.', refTarget: 'motionAttachment' },
    { name: 'supersedes', tier: 'ref', doc: 'Attachment this one supersedes.', refTarget: 'motionAttachment' },
    // values
    { name: 'revisionSeq', tier: 'value', doc: 'Revision sequence number (1 for original).', valueType: 'number' },
    FILING_FILED_ON_SPEC,
    FILING_RECEIVED_ON_SPEC,
  ];
}

/** Per-entity tag set. Order here is the order shown in the UI. */
export const TAG_SPEC_BY_KIND: Record<EntityKind, TagSpec[]> = {
  case: [
    // markers
    {
      name: 'case',
      tier: 'marker',
      doc: 'Marker: this record is a Case (site).',
      valueType: 'bool',
      info: {
        whatItIs: 'Identity marker — every Case row carries this tag so haystack filters like "case and jurisdictionTx" match.',
        howItWorks: 'Always true on Case rows; the marker is emitted by the read resolver regardless of whether the Prisma row has any tags JSON content.',
        mapsTo: 'computed (haystack resolver) — Prisma row in Case table is the source of truth.',
        xetoSpec: 'cc.courtlens.legal::Case',
        example: 'true (marker)',
        relatedTags: ['site', 'motion', 'motionEvent'],
      },
    },
    { name: 'site', tier: 'marker', doc: 'Project Haystack site marker — Case = site.', valueType: 'bool', internal: true },
    {
      name: 'jurisdictionTx',
      tier: 'marker',
      doc: 'Texas jurisdiction.',
      valueType: 'bool',
      info: {
        whatItIs: 'Marker indicating this case falls under Texas law.',
        howItWorks: 'Mutually exclusive with jurisdictionCa / jurisdictionFed (a case sits in one primary jurisdiction). Used by the procedural-rule engine (proc.tx) to compute deadlines per Texas TRCP/TRAP.',
        mapsTo: "tags JSON: '$.jurisdictionTx'",
        xetoSpec: 'cc.courtlens.legal::Case.jurisdictionTx',
        example: 'true (marker)',
        relatedTags: ['jurisdictionCa', 'jurisdictionFed', 'courtRef'],
      },
    },
    {
      name: 'jurisdictionCa',
      tier: 'marker',
      doc: 'California jurisdiction.',
      valueType: 'bool',
      info: {
        whatItIs: 'Marker indicating this case falls under California law.',
        howItWorks: 'Mutually exclusive with jurisdictionTx / jurisdictionFed. Routes deadline computation through the proc.ca procedural rules.',
        mapsTo: "tags JSON: '$.jurisdictionCa'",
        xetoSpec: 'cc.courtlens.legal::Case.jurisdictionCa',
        example: 'true (marker)',
        relatedTags: ['jurisdictionTx', 'jurisdictionFed', 'courtRef'],
      },
    },
    {
      name: 'jurisdictionFed',
      tier: 'marker',
      doc: 'Federal jurisdiction.',
      valueType: 'bool',
      info: {
        whatItIs: 'Marker indicating this case is in federal court (district / circuit / SCOTUS).',
        howItWorks: 'Mutually exclusive with jurisdictionTx / jurisdictionCa. FRCP / FRAP rules apply.',
        mapsTo: "tags JSON: '$.jurisdictionFed'",
        xetoSpec: 'cc.courtlens.legal::Case.jurisdictionFed',
        example: 'true (marker)',
        relatedTags: ['jurisdictionTx', 'jurisdictionCa', 'courtRef'],
      },
    },
    // refs
    {
      name: 'courtRef',
      tier: 'ref',
      doc: 'Reference to the Court record where this case is filed.',
      refTarget: 'court',
      info: {
        whatItIs: 'Pointer to the Court (venue) where this case is docketed.',
        howItWorks: 'The Court row carries its own courtType marker (trial / appellate / supreme). When you set courtRef, the picker is scoped to courts matching the case-level marker.',
        mapsTo: 'computed (haystack resolver) — derived from Prisma.Case.jurisdictionRel and related Court table.',
        xetoSpec: 'cc.courtlens.legal::Case.courtRef',
        example: '@court-tx-travis-345',
        relatedTags: ['jurisdictionTx', 'jurisdictionCa', 'jurisdictionFed', 'judgeRefs'],
      },
    },
    {
      name: 'judgeRefs',
      tier: 'refs',
      doc: 'List of judges assigned to this case (Persons).',
      refTarget: 'person',
      info: {
        whatItIs: 'Judges assigned to the case across its lifecycle.',
        howItWorks: 'Picker is constrained to Person rows carrying the `judge` intrinsic marker. Order matters — index 0 is conventionally the currently-assigned presiding judge.',
        mapsTo: "tags JSON: '$.judgeRefs' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.judgeRefs',
        example: '["@person-judge-naranjo", "@person-judge-aleman"]',
        relatedTags: ['plaintiffRefs', 'defendantRefs', 'courtClerkRefs'],
      },
    },
    {
      name: 'plaintiffRefs',
      tier: 'refs',
      doc: 'List of plaintiffs (Persons or organizations).',
      refTarget: 'person',
      info: {
        whatItIs: 'The party (or parties) bringing the case.',
        howItWorks: 'Includes natural persons and organizations. Their representing attorneys go in plaintiffLawyers, not here. Used by the persona engine to disambiguate "movant" / "respondent" on derived Motion rows.',
        mapsTo: "tags JSON: '$.plaintiffRefs' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.plaintiffRefs',
        example: '["@person-jane-doe"]',
        relatedTags: ['defendantRefs', 'plaintiffLawyers', 'movantRef'],
      },
    },
    {
      name: 'defendantRefs',
      tier: 'refs',
      doc: 'List of defendants (Persons or organizations).',
      refTarget: 'person',
      info: {
        whatItIs: 'The party (or parties) being sued / prosecuted.',
        howItWorks: 'Mirror of plaintiffRefs. Their attorneys live on defendantLawyers. The persona engine matches defendant identities against signature blocks to attribute filings.',
        mapsTo: "tags JSON: '$.defendantRefs' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.defendantRefs',
        example: '["@person-john-roe"]',
        relatedTags: ['plaintiffRefs', 'defendantLawyers', 'respondentRef'],
      },
    },
    {
      name: 'plaintiffLawyers',
      tier: 'refs',
      doc: 'Attorneys representing the plaintiff(s).',
      refTarget: 'person',
      info: {
        whatItIs: 'Attorneys of record for the plaintiff side.',
        howItWorks: 'Picker is constrained to Person rows carrying the `lawyer` intrinsic marker (clients and witnesses are excluded). Filings authored by these persons are attributed to the plaintiff side.',
        mapsTo: "tags JSON: '$.plaintiffLawyers' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.plaintiffLawyers',
        example: '["@person-lawyer-stuart"]',
        relatedTags: ['plaintiffRefs', 'defendantLawyers'],
      },
    },
    {
      name: 'defendantLawyers',
      tier: 'refs',
      doc: 'Attorneys representing the defendant(s).',
      refTarget: 'person',
      info: {
        whatItIs: 'Attorneys of record for the defendant side.',
        howItWorks: 'Same picker semantics as plaintiffLawyers — scoped to `lawyer`-marker persons. Filings authored by these persons are attributed to the defendant side.',
        mapsTo: "tags JSON: '$.defendantLawyers' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.defendantLawyers',
        example: '["@person-lawyer-rivera"]',
        relatedTags: ['defendantRefs', 'plaintiffLawyers'],
      },
    },
    {
      name: 'courtClerkRefs',
      tier: 'refs',
      doc: 'Court clerks of record.',
      refTarget: 'person',
      info: {
        whatItIs: 'Court clerks who handle stamping and routing for this case.',
        howItWorks: 'Constrained to Person rows with the `courtClerk` marker. The clerk who stamps a filing populates the courtClerkRef on the corresponding MotionEvent.',
        mapsTo: "tags JSON: '$.courtClerkRefs' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.courtClerkRefs',
        example: '["@person-clerk-okeefe"]',
        relatedTags: ['courtReporterRefs', 'judgeRefs'],
      },
    },
    {
      name: 'courtReporterRefs',
      tier: 'refs',
      doc: 'Court reporters of record.',
      refTarget: 'person',
      info: {
        whatItIs: 'Court reporters who transcribe hearings on this case.',
        howItWorks: 'Constrained to Person rows with the `courtReporter` marker. The reporter who produces a transcript populates reporterRef on the resulting transcript / reportersRecord row.',
        mapsTo: "tags JSON: '$.courtReporterRefs' (array of @id strings)",
        xetoSpec: 'cc.courtlens.legal::Case.courtReporterRefs',
        example: '["@person-reporter-vega"]',
        relatedTags: ['courtClerkRefs', 'judgeRefs'],
      },
    },
    // values
    {
      name: 'causeNo',
      tier: 'value',
      doc: 'Official cause number assigned by the court.',
      valueType: 'text',
      info: {
        whatItIs: 'The cause number assigned by the court clerk when the case was filed.',
        howItWorks: 'Texas trial: D-1-FM-21-005611 (district-court-county-year-seq). Appellate: 03-24-00513-CV (court-year-seq-type). Should match the official clerk-stamped identifier.',
        mapsTo: 'Prisma.Case.caseNumber (column)',
        xetoSpec: 'cc.courtlens.legal::Case.causeNo',
        example: 'D-1-FM-21-005611',
        relatedTags: ['causeFiledStamp', 'filedOn'],
      },
    },
    {
      name: 'causeFiledStamp',
      tier: 'value',
      doc: 'Clerk-stamp identifier from initial case filing.',
      valueType: 'text',
      info: {
        whatItIs: 'The clerk-stamp text from the very first filing that opened the case.',
        howItWorks: 'Distinct from causeNo: the cause number may be edited / corrected later, but the stamp on the petition is immutable evidence of original filing. Used to reconcile when clerks renumber cases.',
        mapsTo: "tags JSON: '$.causeFiledStamp'",
        xetoSpec: 'cc.courtlens.legal::Case.causeFiledStamp',
        example: 'D-1-FM-21-005611 (filed 09/15/2021 at 14:32)',
        relatedTags: ['causeNo', 'filedOn'],
      },
    },
    {
      name: 'filedOn',
      tier: 'value',
      doc: 'Case-opening date (when the case was first filed).',
      valueType: 'date',
      info: {
        whatItIs: 'Date the case was opened with the court clerk.',
        howItWorks: 'On Case rows this is the case-opening date (date of the initial petition). On filing rows it means the date THAT filing was filed. Statute-of-limitations and aging metrics anchor on this date.',
        mapsTo: 'computed (haystack resolver) — typically derived from the earliest MotionEvent with the courtFiled marker.',
        xetoSpec: 'cc.courtlens.legal::Case.filedOn',
        example: '2021-09-15',
        relatedTags: ['causeNo', 'causeFiledStamp', 'courtFilingDate'],
      },
    },
  ],

  motion: [
    // markers
    {
      name: 'motion',
      tier: 'marker',
      doc: 'Marker: this record is a Motion.',
      valueType: 'bool',
      info: {
        whatItIs: 'Identity marker — every Motion row carries this tag.',
        howItWorks: 'In Project Haystack terms Motion = equip (a logical equipment record under a site). Always true on Motion rows; the `equip` marker is the internal Haystack-ontology twin.',
        mapsTo: 'computed (haystack resolver) — Prisma row in Motion table is the source of truth.',
        xetoSpec: 'cc.courtlens.legal::Motion',
        example: 'true (marker)',
        relatedTags: ['case', 'motionEvent', 'subMotion'],
      },
    },
    { name: 'equip', tier: 'marker', doc: 'Project Haystack equip marker — Motion = equip.', valueType: 'bool', internal: true },
    {
      name: 'subMotion',
      tier: 'marker',
      doc: 'Present iff this motion has a parent motionRef (amended motion).',
      valueType: 'bool',
      info: {
        whatItIs: 'Marker emitted when this motion is a child of another motion (amendment, supplement, or re-filing).',
        howItWorks: 'Derived — present iff motionRef on this row points to a sibling Motion. You cannot toggle subMotion directly; setting motionRef causes the resolver to emit it.',
        mapsTo: 'computed (derived from $.motionRef presence)',
        xetoSpec: 'cc.courtlens.legal::Motion.subMotion',
        example: 'true (marker, derived)',
        relatedTags: ['motionRef', 'amends', 'supersedes', 'revisionSeq'],
      },
    },
    {
      name: 'appellate',
      tier: 'marker',
      doc: 'Motion is filed at the appellate level.',
      valueType: 'bool',
      info: {
        whatItIs: 'Indicates this motion was filed in an appellate court (TRAP / FRAP territory).',
        howItWorks: 'Independent of the parent Case appellate marker — a case can transit between trial and appellate phases, and individual motions carry their own level. The deadline engine swaps TRCP for TRAP when this is set.',
        mapsTo: "tags JSON: '$.appellate'",
        xetoSpec: 'cc.courtlens.legal::Motion.appellate',
        example: 'true (marker)',
        relatedTags: ['motionType', 'caseRef'],
      },
    },
    // Origin (filing provenance) — derived server-side from authoredBy;
    // a value here is a manual override that wins over derivation.
    ...ORIGIN_MARKERS,
    // refs
    {
      name: 'caseRef',
      tier: 'ref',
      doc: 'Reference to the parent Case (site).',
      refTarget: 'case',
      info: {
        whatItIs: 'Pointer to the legal Case this motion belongs to.',
        howItWorks: 'Every Motion must belong to exactly one Case. The server derives caseRef from the Prisma caseId column when reading; you set it indirectly by associating the filing with a case.',
        mapsTo: 'Prisma.Motion.caseId (column) — emitted as Haystack ref @<case-id>',
        xetoSpec: 'cc.courtlens.legal::Motion.caseRef',
        example: '@1535c622-8955-4669-8f29-884a4f2b31ea',
        relatedTags: ['motionRef', 'amends', 'supersedes'],
      },
    },
    {
      name: 'motionRef',
      tier: 'ref',
      doc: 'Parent motion (if this is a sub/amended motion).',
      refTarget: 'motion',
      info: {
        whatItIs: 'Pointer to a parent motion when this one is a child (amendment, supplement, sub-motion).',
        howItWorks: 'Setting this causes subMotion to be emitted. The picker is scoped to motions in the same caseRef so you cannot cross-link motions between cases.',
        mapsTo: "tags JSON: '$.motionRef' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::Motion.motionRef',
        example: '@motion-7a3f',
        relatedTags: ['subMotion', 'amends', 'supersedes', 'revisionSeq'],
      },
    },
    {
      name: 'amends',
      tier: 'ref',
      doc: 'Explicit pointer to the motion this one amends.',
      refTarget: 'motion',
      info: {
        whatItIs: 'The earlier motion that this one amends (keeps the original in place but layers changes).',
        howItWorks: 'Scoped to the same caseRef — see inferScopeFilter in tag-panel.tsx. Increment revisionSeq when chaining amendments. Differs from supersedes: amends layers on top; supersedes replaces.',
        mapsTo: "tags JSON: '$.amends' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::Motion.amends',
        example: '@motion-original-d2',
        relatedTags: ['supersedes', 'motionRef', 'revisionSeq'],
      },
    },
    {
      name: 'supersedes',
      tier: 'ref',
      doc: 'Explicit pointer to the motion this one supersedes.',
      refTarget: 'motion',
      info: {
        whatItIs: 'The earlier motion that this one fully replaces.',
        howItWorks: 'Same-case scope as amends. Supersedes is stronger — the prior motion is treated as withdrawn / replaced for deadline purposes, not just amended.',
        mapsTo: "tags JSON: '$.supersedes' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::Motion.supersedes',
        example: '@motion-original-d2',
        relatedTags: ['amends', 'motionRef', 'revisionSeq'],
      },
    },
    {
      name: 'judgeRef',
      tier: 'ref',
      doc: 'The judge assigned to THIS motion.',
      refTarget: 'person',
      info: {
        whatItIs: 'The judge with authority over this specific motion (may differ from case-level judgeRefs after reassignment).',
        howItWorks: 'Picker constrained to `judge`-marker Person rows. Defaults to the case-level presiding judge; override when a motion is referred to a magistrate or visiting judge.',
        mapsTo: "tags JSON: '$.judgeRef' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::Motion.judgeRef',
        example: '@person-judge-naranjo',
        relatedTags: ['movantRef', 'respondentRef'],
      },
    },
    {
      name: 'movantRef',
      tier: 'ref',
      doc: 'The party making this motion.',
      refTarget: 'person',
      info: {
        whatItIs: 'The party (person or org) that filed this motion — the moving party.',
        howItWorks: 'Should be one of the case-level plaintiffRefs or defendantRefs. The persona engine inspects signature blocks and notice headings to suggest a movant when auto-classifying.',
        mapsTo: 'Prisma.Motion.movantId (column) — emitted as Haystack ref',
        xetoSpec: 'cc.courtlens.legal::Motion.movantRef',
        example: '@person-jane-doe',
        relatedTags: ['respondentRef', 'plaintiffRefs', 'defendantRefs'],
      },
    },
    {
      name: 'respondentRef',
      tier: 'ref',
      doc: 'The party responding to this motion.',
      refTarget: 'person',
      info: {
        whatItIs: 'The non-moving party — the one against whom the motion is brought.',
        howItWorks: 'Conventionally the opposing party in the caption. The deadline engine emits a "response due" reminder targeted at this party.',
        mapsTo: 'Prisma.Motion.respondentId (column) — emitted as Haystack ref',
        xetoSpec: 'cc.courtlens.legal::Motion.respondentRef',
        example: '@person-john-roe',
        relatedTags: ['movantRef', 'plaintiffRefs', 'defendantRefs'],
      },
    },
    // values
    {
      name: 'motionType',
      tier: 'value',
      doc: 'Kind of motion (e.g. "disqualify", "summary-judgment").',
      valueType: 'text',
      info: {
        whatItIs: 'The taxonomic kind of motion, drawn from the MotionType choice list.',
        howItWorks: 'A controlled vocabulary backed by the XETO MotionType Choice spec. The MotionTypePicker UI lets you search the slug list. The classifier sets this from the document title/content during ingestion; you can override.',
        mapsTo: "tags JSON: '$.motionType' (string slug)",
        xetoSpec: 'cc.courtlens.legal::Motion.motionType (Choice: MotionType)',
        example: 'summary-judgment',
        relatedTags: ['movantRef', 'respondentRef'],
      },
    },
    {
      name: 'revisionSeq',
      tier: 'value',
      doc: '1 for the original motion; increments per amendment.',
      valueType: 'number',
      info: {
        whatItIs: 'Sequence number tracking the amendment chain. Original = 1, first amendment = 2, etc.',
        howItWorks: 'Set by the user when filing an amendment. The chain is reconstructed via amends/supersedes refs; revisionSeq is the human-readable order. The latest non-superseded motion in a chain is the "live" filing for deadline purposes.',
        mapsTo: "tags JSON: '$.revisionSeq' (number)",
        xetoSpec: 'cc.courtlens.legal::Motion.revisionSeq',
        example: '2',
        relatedTags: ['amends', 'supersedes', 'motionRef'],
      },
    },
    // Universal filing tags — every filing kind carries these (see FILING_*_SPEC).
    // NOTE: Motion has no `documentId` column in Prisma; `fileRef` is tags-only
    // until a schema migration links Motion → Document. Phase-2 work.
    FILING_FILE_REF_SPEC,
    FILING_FILED_ON_SPEC,
    FILING_RECEIVED_ON_SPEC,
  ],

  motionEvent: [
    { name: 'motionEvent', tier: 'marker', doc: 'Marker: lifecycle event on a Motion.', valueType: 'bool', internal: true },
    { name: 'point', tier: 'marker', doc: 'Project Haystack point marker — MotionEvent = point.', valueType: 'bool', internal: true },
    {
      name: 'received',
      tier: 'marker',
      doc: 'Event kind: received (mutually exclusive with other kinds).',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — the document was received by our system (drop-folder, email ingestion, manual upload).',
        howItWorks: 'Mutually exclusive with the other EventKind markers (filed, courtFiled, responded, signed, granted, denied, hearingHeld). One MotionEvent = one kind. Use `received` when you have the document but no clerk stamp yet.',
        mapsTo: "tags JSON: '$.received' (and kind=\"received\")",
        xetoSpec: 'cc.courtlens.legal::Received (EventKind)',
        example: 'true (marker)',
        relatedTags: ['filed', 'courtFiled', 'kind', 'occurredOn'],
      },
    },
    {
      name: 'filed',
      tier: 'marker',
      doc: 'Event kind: party-filed (e-filed). Not the legally-operative date.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — a party submitted the filing (e-file portal, mail, hand-delivery).',
        howItWorks: 'CRITICAL: this is NOT the operative deadline date. The clerk-stamp date (courtFiled) is what legally counts. The e-file timestamp may precede courtFiled by hours or days. Mutually exclusive with other EventKind markers.',
        mapsTo: "tags JSON: '$.filed' (and kind=\"filed\")",
        xetoSpec: 'cc.courtlens.legal::Filed (EventKind)',
        example: 'true (marker)',
        relatedTags: ['courtFiled', 'received', 'occurredOn', 'kind'],
      },
    },
    {
      name: 'courtFiled',
      tier: 'marker',
      doc: 'Event kind: clerk-stamped. THIS is when the deadline clock starts.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — the clerk stamped the filing (officially "filed of record").',
        howItWorks: 'THIS is the legally-operative date for deadline computation. courtFilingDate stores the timestamp. The deadline engine anchors all relative dates (e.g. "response due 21 days after") on this event, not on `filed`.',
        mapsTo: "tags JSON: '$.courtFiled' (and kind=\"courtFiled\")",
        xetoSpec: 'cc.courtlens.legal::CourtFiled (EventKind)',
        example: 'true (marker)',
        relatedTags: ['filed', 'courtFilingDate', 'courtClerkRef', 'causeNoStamp'],
      },
    },
    {
      name: 'responded',
      tier: 'marker',
      doc: 'Event kind: a response was filed.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — a response/opposition was filed to the parent motion.',
        howItWorks: 'Closes out the "response due" deadline computed from the parent motion`s courtFiled event. The actual response document is linked via fileRef; the responding party via authoredBy.',
        mapsTo: "tags JSON: '$.responded' (and kind=\"responded\")",
        xetoSpec: 'cc.courtlens.legal::Responded (EventKind)',
        example: 'true (marker)',
        relatedTags: ['filed', 'authoredBy', 'occurredOn'],
      },
    },
    {
      name: 'signed',
      tier: 'marker',
      doc: 'Event kind: signed by judge.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — a judge signed an order on this motion.',
        howItWorks: 'judgeRef identifies which judge signed. occurredOn carries the signature date. Often precedes granted/denied — judges may sign an order then file it separately.',
        mapsTo: "tags JSON: '$.signed' (and kind=\"signed\")",
        xetoSpec: 'cc.courtlens.legal::Signed (EventKind)',
        example: 'true (marker)',
        relatedTags: ['granted', 'denied', 'judgeRef'],
      },
    },
    {
      name: 'granted',
      tier: 'marker',
      doc: 'Event kind: motion granted.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — the court granted the motion in full or in part.',
        howItWorks: 'Terminal outcome for this motion`s lifecycle. judgeRef carries the deciding judge. occurredOn = order date. Partial grants are still represented as granted; the nuance lives in the attached order document.',
        mapsTo: "tags JSON: '$.granted' (and kind=\"granted\")",
        xetoSpec: 'cc.courtlens.legal::Granted (EventKind)',
        example: 'true (marker)',
        relatedTags: ['denied', 'signed', 'judgeRef'],
      },
    },
    {
      name: 'denied',
      tier: 'marker',
      doc: 'Event kind: motion denied.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — the court denied the motion.',
        howItWorks: 'Terminal outcome. Mutually exclusive with granted. judgeRef + occurredOn carry the order metadata. Denials may be with or without prejudice — that detail lives in the attached order document, not on the marker.',
        mapsTo: "tags JSON: '$.denied' (and kind=\"denied\")",
        xetoSpec: 'cc.courtlens.legal::Denied (EventKind)',
        example: 'true (marker)',
        relatedTags: ['granted', 'signed', 'judgeRef'],
      },
    },
    {
      name: 'hearingHeld',
      tier: 'marker',
      doc: 'Event kind: a hearing on this motion was held.',
      valueType: 'bool',
      info: {
        whatItIs: 'Event kind marker — a hearing on this motion took place.',
        howItWorks: 'Used to record the act of holding a hearing. The Hearing record (separate entity) carries the full scheduling/transcript/duration data; this MotionEvent is the link back to the motion`s timeline.',
        mapsTo: "tags JSON: '$.hearingHeld' (and kind=\"hearingHeld\")",
        xetoSpec: 'cc.courtlens.legal::HearingHeld (EventKind)',
        example: 'true (marker)',
        relatedTags: ['signed', 'granted', 'denied', 'occurredOn'],
      },
    },
    // Origin (filing provenance) — derived server-side from authoredBy;
    // a value here is a manual override that wins over derivation.
    ...ORIGIN_MARKERS,
    {
      name: 'motionRef',
      tier: 'ref',
      doc: 'Reference to the parent motion.',
      refTarget: 'motion',
      info: {
        whatItIs: 'Pointer to the Motion this event belongs to.',
        howItWorks: 'Every MotionEvent is anchored to exactly one Motion. The motion`s caseRef is inherited (caseRef on the event must match motion.caseRef). Read-only after creation in normal flows.',
        mapsTo: 'Prisma.MotionEvent.motionId (column) → Haystack ref',
        xetoSpec: 'cc.courtlens.legal::MotionEvent.motionRef',
        example: '@motion-7a3f',
        relatedTags: ['caseRef', 'fileRef'],
      },
    },
    {
      name: 'caseRef',
      tier: 'ref',
      doc: 'Reference to the parent case.',
      refTarget: 'case',
      info: {
        whatItIs: 'Pointer to the Case this event ultimately belongs to.',
        howItWorks: 'Denormalized from the parent motion`s caseRef for query efficiency. The resolver enforces motionRef.caseRef === caseRef on write; if they disagree, the motion`s value wins.',
        mapsTo: 'computed (inherited from motionRef.caseRef)',
        xetoSpec: 'cc.courtlens.legal::MotionEvent.caseRef',
        example: '@1535c622-8955-4669-8f29-884a4f2b31ea',
        relatedTags: ['motionRef'],
      },
    },
    {
      name: 'fileRef',
      tier: 'ref',
      doc: 'Reference to the document (PDF) for this event.',
      refTarget: 'doc',
      info: {
        whatItIs: 'Pointer to the underlying PDF document evidencing this event.',
        howItWorks: 'For courtFiled events, this is the stamped PDF. For signed/granted/denied, the signed order. The doc row carries the actual file path, hash, and OCR results.',
        mapsTo: "tags JSON: '$.fileRef' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.fileRef',
        example: '@doc-stamped-petition-a31',
        relatedTags: ['motionRef', 'authoredBy'],
      },
    },
    {
      name: 'authoredBy',
      tier: 'ref',
      doc: 'Person who authored / filed this event.',
      refTarget: 'person',
      info: {
        whatItIs: 'The person who authored or initiated this event (signing lawyer, filing party, etc.).',
        howItWorks: 'The persona engine resolves this from the signature block / e-file metadata during ingestion. You can override. For courtFiled events the clerk goes in courtClerkRef, not authoredBy.',
        mapsTo: "tags JSON: '$.authoredBy' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.authoredBy',
        example: '@person-lawyer-stuart',
        relatedTags: ['judgeRef', 'courtClerkRef'],
      },
    },
    {
      name: 'judgeRef',
      tier: 'ref',
      doc: 'Judge for this event (e.g. on signed/granted/denied).',
      refTarget: 'person',
      info: {
        whatItIs: 'The judge associated with this event (signing judge, deciding judge).',
        howItWorks: 'Required on signed/granted/denied events. Picker constrained to `judge`-marker Person rows. Default suggestion is the parent motion`s judgeRef.',
        mapsTo: "tags JSON: '$.judgeRef' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.judgeRef',
        example: '@person-judge-naranjo',
        relatedTags: ['signed', 'granted', 'denied'],
      },
    },
    {
      name: 'courtClerkRef',
      tier: 'ref',
      doc: 'Court clerk who stamped (on courtFiled events).',
      refTarget: 'person',
      info: {
        whatItIs: 'The court clerk who stamped this filing (only meaningful on courtFiled events).',
        howItWorks: 'Picker constrained to `courtClerk`-marker Person rows. Optional — many clerk stamps are illegible or anonymous; leave blank if unknown.',
        mapsTo: "tags JSON: '$.courtClerkRef' (Haystack ref)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.courtClerkRef',
        example: '@person-clerk-okeefe',
        relatedTags: ['courtFiled', 'causeNoStamp'],
      },
    },
    {
      name: 'occurredOn',
      tier: 'value',
      doc: 'When the event occurred.',
      valueType: 'date',
      info: {
        whatItIs: 'The date (and optionally time) the event occurred.',
        howItWorks: 'Semantics depend on the EventKind marker: for `filed` it`s the e-file submission, for `courtFiled` it duplicates courtFilingDate, for `signed` it`s the signature date, etc. This is the canonical timestamp for the event row.',
        mapsTo: "tags JSON: '$.occurredOn' (ISO date)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.occurredOn',
        example: '2024-03-15T14:32:00Z',
        relatedTags: ['courtFilingDate', 'kind'],
      },
    },
    {
      name: 'courtFilingDate',
      tier: 'value',
      doc: 'Official clerk-stamp date (on courtFiled events).',
      valueType: 'date',
      info: {
        whatItIs: 'The clerk-stamp timestamp — the legally-operative filing date.',
        howItWorks: 'Only populated on courtFiled events. Often equals occurredOn, but kept distinct so reports can pull "clerk-of-record date" without inspecting the kind marker. Deadline engine uses this as the anchor for all relative deadlines.',
        mapsTo: "tags JSON: '$.courtFilingDate' (ISO date)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.courtFilingDate',
        example: '2024-03-15T14:32:00Z',
        relatedTags: ['courtFiled', 'courtClerkRef', 'causeNoStamp'],
      },
    },
    { name: 'causeNoStamp', tier: 'value', doc: "Clerk's stamp identifier for this filing.", valueType: 'text' },
    {
      name: 'kind',
      tier: 'value',
      doc: 'The EventKind value (e.g. "filed", "signed", "granted").',
      valueType: 'text',
      info: {
        whatItIs: 'String form of the EventKind marker for this row.',
        howItWorks: 'Convenience denormalization — the marker (e.g. `courtFiled`) is the source of truth, but `kind: "courtFiled"` is easier to query in haystack filters. Always matches one of the EventKind markers exactly.',
        mapsTo: "tags JSON: '$.kind' (string slug)",
        xetoSpec: 'cc.courtlens.legal::MotionEvent.kind (Choice: EventKind)',
        example: 'courtFiled',
        relatedTags: ['received', 'filed', 'courtFiled', 'responded', 'signed', 'granted', 'denied', 'hearingHeld'],
      },
    },
  ],

  motionAttachment: [
    { name: 'attachment', tier: 'marker', doc: 'Marker: attachment to a Motion.', internal: true, valueType: 'bool' },
    // Attachment-kind markers (mutually-exclusive set; reflects MotionAttachment.attachmentKind).
    { name: 'proposedOrder', tier: 'marker', doc: 'Attachment kind: proposed order.', valueType: 'bool' },
    { name: 'brief', tier: 'marker', doc: 'Attachment kind: brief.', valueType: 'bool' },
    { name: 'response', tier: 'marker', doc: 'Attachment kind: response (opposition / reply).', valueType: 'bool' },
    { name: 'email', tier: 'marker', doc: 'Attachment kind: email correspondence.', valueType: 'bool' },
    { name: 'evidence', tier: 'marker', doc: 'Attachment kind: evidence.', valueType: 'bool' },
    { name: 'exhibit', tier: 'marker', doc: 'Attachment kind: exhibit.', valueType: 'bool' },
    { name: 'supportingDoc', tier: 'marker', doc: 'Attachment kind: supporting document.', valueType: 'bool' },
    { name: 'order', tier: 'marker', doc: 'Attachment kind: signed order.', valueType: 'bool' },
    { name: 'transcript', tier: 'marker', doc: 'Attachment kind: transcript (deposition / hearing).', valueType: 'bool' },
    { name: 'affidavit', tier: 'marker', doc: 'Attachment kind: affidavit.', valueType: 'bool' },
    { name: 'subpoena', tier: 'marker', doc: 'Attachment kind: subpoena.', valueType: 'bool' },
    { name: 'judgment', tier: 'marker', doc: 'Attachment kind: judgment.', valueType: 'bool' },
    { name: 'settlement', tier: 'marker', doc: 'Attachment kind: settlement.', valueType: 'bool' },
    { name: 'notice', tier: 'marker', doc: 'Attachment kind: notice.', valueType: 'bool' },
    { name: 'rfa', tier: 'marker', doc: 'Attachment kind: request for admissions.', valueType: 'bool' },
    { name: 'billOfReview', tier: 'marker', doc: 'Attachment kind: bill of review.', valueType: 'bool' },
    { name: 'petition', tier: 'marker', doc: 'Attachment kind: petition.', valueType: 'bool' },
    // Origin (filing provenance) — derived server-side from authoredBy;
    // a value here is a manual override that wins over derivation.
    ...ORIGIN_MARKERS,
    // Refs
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    FILING_FILE_REF_SPEC,
    { name: 'amends', tier: 'ref', doc: 'Attachment this one amends.', refTarget: 'motionAttachment' },
    { name: 'supersedes', tier: 'ref', doc: 'Attachment this one supersedes.', refTarget: 'motionAttachment' },
    { name: 'authoredBy', tier: 'ref', doc: 'Person who authored this attachment.', refTarget: 'person' },
    // Values
    { name: 'revisionSeq', tier: 'value', doc: 'Revision sequence number.', valueType: 'number' },
    { name: 'attachmentKind', tier: 'value', doc: 'The attachment-kind value (e.g. "proposedOrder").', valueType: 'text' },
    // Universal filing tags — every filing kind carries these.
    FILING_FILED_ON_SPEC,
    FILING_RECEIVED_ON_SPEC,
  ],

  hearing: [
    { name: 'hearing', tier: 'marker', doc: 'Marker: shared Hearing record.', valueType: 'bool' },
    { name: 'hybrid', tier: 'marker', doc: 'Present iff this hearing spans ≥2 cases.', valueType: 'bool' },
    { name: 'remote', tier: 'marker', doc: 'Hearing held telephonically or by video.', valueType: 'bool' },
    { name: 'caseRefs', tier: 'refs', doc: 'Cases this hearing applies to.', refTarget: 'case' },
    { name: 'motionRefs', tier: 'refs', doc: 'Motions this hearing applies to.', refTarget: 'motion' },
    { name: 'judgeRef', tier: 'ref', doc: 'Presiding judge.', refTarget: 'person' },
    { name: 'courtReporterRef', tier: 'ref', doc: 'Court reporter on record.', refTarget: 'person' },
    { name: 'courtClerkRef', tier: 'ref', doc: 'Court clerk on record.', refTarget: 'person' },
    { name: 'transcriptRef', tier: 'ref', doc: 'Transcript document.', refTarget: 'doc' },
    { name: 'scheduledFor', tier: 'value', doc: 'Originally-scheduled date/time.', valueType: 'date' },
    { name: 'heldOn', tier: 'value', doc: 'Actual date/time held.', valueType: 'date' },
    { name: 'durationMin', tier: 'value', doc: 'Duration in minutes.', valueType: 'number' },
    { name: 'location', tier: 'value', doc: 'Courtroom / location.', valueType: 'text' },
    { name: 'hearingType', tier: 'value', doc: 'Hearing type (e.g. "motion", "trial").', valueType: 'text' },
  ],

  clerksRecord: [
    // markers
    { name: 'clerksRecord', tier: 'marker', doc: "Marker: this record is a Clerk's Record (appellate compilation of trial-court papers).", valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Filed at the appellate level.', valueType: 'bool' },
    { name: 'supplemental', tier: 'marker', doc: 'Supplemental clerk’s record (added after the original).', valueType: 'bool' },
    // Origin (filing provenance) — usually courtIssued for clerk's records,
    // but the full quartet is offered for manual override.
    ...ORIGIN_MARKERS,
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    FILING_FILE_REF_SPEC,
    // `documentRef` is the legacy alias for this kind; kept for back-compat
    // with consumers that still read it. Both names resolve to the same
    // Document row server-side (see synthesizeRefsFromColumns).
    { name: 'documentRef', tier: 'ref', doc: 'Reference to the underlying PDF document (alias of fileRef).', refTarget: 'doc' },
    { name: 'preparedBy', tier: 'ref', doc: 'Court clerk who prepared this volume.', refTarget: 'person' },
    // Multi-person attributions for the volume — courts often list several
    // clerks/reporters on an appellate Clerk's Record cover sheet. Constrained
    // to Person rows with the matching intrinsic marker.
    { name: 'courtClerkRefs', tier: 'refs', doc: 'Court clerks attributed on this volume.', refTarget: 'person' },
    { name: 'courtReporterRefs', tier: 'refs', doc: 'Court reporters attributed on this volume.', refTarget: 'person' },
    // values
    { name: 'volume', tier: 'value', doc: 'Volume number of the clerk’s record.', valueType: 'number' },
    { name: 'supplementalOrder', tier: 'value', doc: 'Order of this supplemental clerk’s record (1 = first supplemental, 2 = second, etc.). Only meaningful when the `supplemental` marker is set.', valueType: 'number' },
    // Universal filing tags — every filing kind carries these.
    FILING_FILED_ON_SPEC,
    FILING_RECEIVED_ON_SPEC,
    { name: 'preparedOn', tier: 'value', doc: 'Date prepared by the clerk.', valueType: 'date' },
  ],

  reportersRecord: [
    // markers
    { name: 'reportersRecord', tier: 'marker', doc: "Marker: this record is a Reporter's Record (court-reporter transcript volumes).", valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Filed at the appellate level.', valueType: 'bool' },
    { name: 'supplemental', tier: 'marker', doc: 'Supplemental reporter’s record.', valueType: 'bool' },
    // Origin (filing provenance) — usually courtIssued for reporter's records,
    // but the full quartet is offered for manual override.
    ...ORIGIN_MARKERS,
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'reporterRef', tier: 'ref', doc: 'Court reporter who produced this volume.', refTarget: 'person' },
    // Multi-person attributions — hearings can list multiple reporters or
    // clerks on the cover sheet.
    { name: 'courtReporterRefs', tier: 'refs', doc: 'Court reporters attributed on this volume.', refTarget: 'person' },
    { name: 'courtClerkRefs', tier: 'refs', doc: 'Court clerks attributed on this volume.', refTarget: 'person' },
    FILING_FILE_REF_SPEC,
    // `documentRef` is the legacy alias for this kind; kept for back-compat
    // with consumers that still read it. Both names resolve to the same
    // Document row server-side (see synthesizeRefsFromColumns).
    { name: 'documentRef', tier: 'ref', doc: 'Reference to the underlying PDF document (alias of fileRef).', refTarget: 'doc' },
    // values
    { name: 'volume', tier: 'value', doc: 'Volume number of the reporter’s record.', valueType: 'number' },
    { name: 'supplementalOrder', tier: 'value', doc: 'Order of this supplemental reporter’s record (1 = first supplemental, 2 = second, etc.). Only meaningful when the `supplemental` marker is set.', valueType: 'number' },
    { name: 'hearingDate', tier: 'value', doc: 'Date of the hearing/proceeding transcribed.', valueType: 'date' },
    // Universal filing tags — every filing kind carries these.
    FILING_FILED_ON_SPEC,
    FILING_RECEIVED_ON_SPEC,
  ],

  notice: [
    ...attachmentBaseSpec('notice', 'Marker: this record is a Notice filing.'),
    { name: 'from', tier: 'ref', doc: 'Sender of the notice.', refTarget: 'person' },
    { name: 'to', tier: 'refs', doc: 'Recipients of the notice.', refTarget: 'person' },
    { name: 'noticeType', tier: 'value', doc: 'Kind of notice (e.g. "hearing", "appearance").', valueType: 'text' },
    { name: 'sentOn', tier: 'value', doc: 'Date the notice was sent.', valueType: 'date' },
  ],

  letter: [
    ...attachmentBaseSpec('letter', 'Marker: this record is a Letter.'),
    { name: 'from', tier: 'ref', doc: 'Author of the letter.', refTarget: 'person' },
    { name: 'to', tier: 'refs', doc: 'Recipients of the letter.', refTarget: 'person' },
    { name: 'sentOn', tier: 'value', doc: 'Date the letter was sent.', valueType: 'date' },
    { name: 'subject', tier: 'value', doc: 'Subject line / topic.', valueType: 'text' },
  ],

  order: [
    ...attachmentBaseSpec('order', 'Marker: this record is a court Order.'),
    { name: 'signedBy', tier: 'ref', doc: 'Judge who signed the order.', refTarget: 'person' },
    { name: 'orderType', tier: 'value', doc: 'Type of order (e.g. "scheduling", "protective").', valueType: 'text' },
    { name: 'signedOn', tier: 'value', doc: 'Date the order was signed.', valueType: 'date' },
  ],

  proposedOrder: [
    ...attachmentBaseSpec('proposedOrder', 'Marker: this record is a Proposed Order.'),
    { name: 'signedBy', tier: 'ref', doc: 'Judge who would sign the order if granted.', refTarget: 'person' },
    { name: 'orderType', tier: 'value', doc: 'Type of order proposed.', valueType: 'text' },
    { name: 'signedOn', tier: 'value', doc: 'Date the order was signed (if granted).', valueType: 'date' },
  ],

  petition: [
    ...attachmentBaseSpec('petition', 'Marker: this record is a Petition.'),
    { name: 'petitionType', tier: 'value', doc: 'Kind of petition (e.g. "divorce", "habeas").', valueType: 'text' },
  ],

  affidavit: [
    ...attachmentBaseSpec('affidavit', 'Marker: this record is an Affidavit.'),
    { name: 'affiant', tier: 'ref', doc: 'Person making the sworn statement.', refTarget: 'person' },
    { name: 'notarizedBy', tier: 'ref', doc: 'Notary who acknowledged the affidavit.', refTarget: 'person' },
    { name: 'swornOn', tier: 'value', doc: 'Date the affidavit was sworn.', valueType: 'date' },
  ],

  subpoena: [
    ...attachmentBaseSpec('subpoena', 'Marker: this record is a Subpoena.'),
    { name: 'servedOn', tier: 'ref', doc: 'Person served with the subpoena.', refTarget: 'person' },
    { name: 'subpoenaType', tier: 'value', doc: 'Kind of subpoena (e.g. "duces tecum", "ad testificandum").', valueType: 'text' },
    { name: 'servedAt', tier: 'value', doc: 'Location where served.', valueType: 'text' },
    { name: 'returnDate', tier: 'value', doc: 'Date by which the subpoena must be answered.', valueType: 'date' },
  ],

  brief: [
    ...attachmentBaseSpec('brief', 'Marker: this record is a Brief.'),
    { name: 'briefType', tier: 'value', doc: 'Kind of brief (e.g. "opening", "reply", "amicus").', valueType: 'text' },
    { name: 'wordCount', tier: 'value', doc: 'Word count (for length-limit compliance).', valueType: 'number' },
  ],

  response: [
    ...attachmentBaseSpec('response', 'Marker: this record is a Response filing.'),
    { name: 'respondingTo', tier: 'ref', doc: 'The motion/filing this responds to.', refTarget: 'motion' },
  ],

  reply: [
    ...attachmentBaseSpec('reply', 'Marker: this record is a Reply filing.'),
    { name: 'replyingTo', tier: 'ref', doc: 'The response this replies to.', refTarget: 'motionAttachment' },
  ],

  judgment: [
    ...attachmentBaseSpec('judgment', 'Marker: this record is a Judgment.'),
    { name: 'signedBy', tier: 'ref', doc: 'Judge who signed the judgment.', refTarget: 'person' },
    { name: 'judgmentType', tier: 'value', doc: 'Kind of judgment (e.g. "default", "summary", "final").', valueType: 'text' },
    { name: 'signedOn', tier: 'value', doc: 'Date the judgment was signed.', valueType: 'date' },
  ],

  decree: [
    ...attachmentBaseSpec('decree', 'Marker: this record is a Decree.'),
    { name: 'signedBy', tier: 'ref', doc: 'Judge who signed the decree.', refTarget: 'person' },
    { name: 'decreeType', tier: 'value', doc: 'Kind of decree (e.g. "divorce", "adoption").', valueType: 'text' },
    { name: 'signedOn', tier: 'value', doc: 'Date the decree was signed.', valueType: 'date' },
  ],

  transcript: [
    ...attachmentBaseSpec('transcript', 'Marker: this record is a Transcript.'),
    { name: 'reporter', tier: 'ref', doc: 'Court reporter who produced the transcript.', refTarget: 'person' },
    { name: 'hearingDate', tier: 'value', doc: 'Date of the proceeding transcribed.', valueType: 'date' },
    { name: 'pageCount', tier: 'value', doc: 'Number of pages in the transcript.', valueType: 'number' },
  ],

  settlement: [
    ...attachmentBaseSpec('settlement', 'Marker: this record is a Settlement.'),
    { name: 'parties', tier: 'refs', doc: 'Parties to the settlement.', refTarget: 'person' },
    { name: 'settledOn', tier: 'value', doc: 'Date the settlement was reached.', valueType: 'date' },
  ],

  billOfReview: [
    ...attachmentBaseSpec('billOfReview', 'Marker: this record is a Bill of Review.'),
  ],

  returnOfService: [
    ...attachmentBaseSpec('returnOfService', 'Marker: this record is a Return of Service.'),
    { name: 'servedOn', tier: 'ref', doc: 'Person served.', refTarget: 'person' },
    { name: 'servedBy', tier: 'ref', doc: 'Process server.', refTarget: 'person' },
    { name: 'servedAt', tier: 'value', doc: 'Location where service was effected.', valueType: 'text' },
    { name: 'servedMethod', tier: 'value', doc: 'Method of service (personal, substituted, mail, etc.).', valueType: 'text' },
  ],

  demandLetter: [
    ...attachmentBaseSpec('demandLetter', 'Marker: this record is a Demand Letter.'),
    { name: 'from', tier: 'ref', doc: 'Sender of the demand.', refTarget: 'person' },
    { name: 'to', tier: 'refs', doc: 'Recipients of the demand.', refTarget: 'person' },
    { name: 'sentOn', tier: 'value', doc: 'Date the demand letter was sent.', valueType: 'date' },
    { name: 'demandAmount', tier: 'value', doc: 'Amount demanded (in dollars).', valueType: 'number' },
  ],

  objection: [
    ...attachmentBaseSpec('objection', 'Marker: this record is an Objection.'),
    { name: 'objectionTo', tier: 'ref', doc: 'The filing being objected to.', refTarget: 'motionAttachment' },
    { name: 'basis', tier: 'value', doc: 'Legal basis for the objection.', valueType: 'text' },
  ],

  request: [
    ...attachmentBaseSpec('request', 'Marker: this record is a Request (e.g. discovery, admissions).'),
    { name: 'requestType', tier: 'value', doc: 'Kind of request (e.g. "admissions", "production", "interrogatories").', valueType: 'text' },
  ],

  supplement: [
    ...attachmentBaseSpec('supplement', 'Marker: this record is a Supplement to a prior filing.'),
    { name: 'supplements', tier: 'ref', doc: 'The filing this supplements.', refTarget: 'motionAttachment' },
  ],

  designation: [
    ...attachmentBaseSpec('designation', 'Marker: this record is a Designation (e.g. of expert, of record).'),
    { name: 'designatedRef', tier: 'ref', doc: 'The person/record being designated.', refTarget: 'person' },
    { name: 'designationOf', tier: 'value', doc: 'What is being designated (e.g. "expert witness", "record on appeal").', valueType: 'text' },
  ],

  other: [
    ...attachmentBaseSpec('other', 'Marker: this filing did not match a known type.'),
  ],
};

export const TIER_LABEL: Record<TagTier, string> = {
  marker: 'Markers',
  ref: 'References',
  refs: 'References',
  value: 'Values',
};

/** Group tag specs by tier (refs and ref merged into one group). */
export function groupByTier(specs: TagSpec[]): Record<'marker' | 'ref' | 'value', TagSpec[]> {
  const out: Record<'marker' | 'ref' | 'value', TagSpec[]> = { marker: [], ref: [], value: [] };
  for (const s of specs) {
    if (s.tier === 'marker') out.marker.push(s);
    else if (s.tier === 'ref' || s.tier === 'refs') out.ref.push(s);
    else out.value.push(s);
  }
  return out;
}
