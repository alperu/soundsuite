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
    { name: 'attachment', tier: 'marker', doc: 'Marker: attachment to a Motion.', internal: true, valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Filed at the appellate level.', valueType: 'bool' },
    { name: 'urgent', tier: 'marker', doc: 'Flagged as urgent.', valueType: 'bool' },
    { name: 'amended', tier: 'marker', doc: 'This filing amends a prior one.', valueType: 'bool' },
    { name: 'confidential', tier: 'marker', doc: 'Confidential filing.', valueType: 'bool' },
    { name: 'sealed', tier: 'marker', doc: 'Sealed by court order.', valueType: 'bool' },
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    { name: 'fileRef', tier: 'ref', doc: 'Reference to the document (PDF).', refTarget: 'doc' },
    { name: 'authoredBy', tier: 'ref', doc: 'Person who authored this filing.', refTarget: 'person' },
    { name: 'amends', tier: 'ref', doc: 'Attachment this one amends.', refTarget: 'motionAttachment' },
    { name: 'supersedes', tier: 'ref', doc: 'Attachment this one supersedes.', refTarget: 'motionAttachment' },
    // values
    { name: 'revisionSeq', tier: 'value', doc: 'Revision sequence number (1 for original).', valueType: 'number' },
    { name: 'filedOn', tier: 'value', doc: 'Date filed with the court.', valueType: 'date' },
    { name: 'receivedOn', tier: 'value', doc: 'Date received.', valueType: 'date' },
  ];
}

/** Per-entity tag set. Order here is the order shown in the UI. */
export const TAG_SPEC_BY_KIND: Record<EntityKind, TagSpec[]> = {
  case: [
    // markers
    { name: 'case', tier: 'marker', doc: 'Marker: this record is a Case (site).', valueType: 'bool' },
    { name: 'site', tier: 'marker', doc: 'Project Haystack site marker — Case = site.', valueType: 'bool', internal: true },
    { name: 'jurisdictionTx', tier: 'marker', doc: 'Texas jurisdiction.', valueType: 'bool' },
    { name: 'jurisdictionCa', tier: 'marker', doc: 'California jurisdiction.', valueType: 'bool' },
    { name: 'jurisdictionFed', tier: 'marker', doc: 'Federal jurisdiction.', valueType: 'bool' },
    // refs
    { name: 'courtRef', tier: 'ref', doc: 'Reference to the Court record where this case is filed.', refTarget: 'court' },
    { name: 'judgeRefs', tier: 'refs', doc: 'List of judges assigned to this case (Persons).', refTarget: 'person' },
    { name: 'plaintiffRefs', tier: 'refs', doc: 'List of plaintiffs (Persons or organizations).', refTarget: 'person' },
    { name: 'defendantRefs', tier: 'refs', doc: 'List of defendants (Persons or organizations).', refTarget: 'person' },
    { name: 'plaintiffLawyers', tier: 'refs', doc: 'Attorneys representing the plaintiff(s).', refTarget: 'person' },
    { name: 'defendantLawyers', tier: 'refs', doc: 'Attorneys representing the defendant(s).', refTarget: 'person' },
    { name: 'courtClerkRefs', tier: 'refs', doc: 'Court clerks of record.', refTarget: 'person' },
    { name: 'courtReporterRefs', tier: 'refs', doc: 'Court reporters of record.', refTarget: 'person' },
    // values
    { name: 'causeNo', tier: 'value', doc: 'Official cause number assigned by the court.', valueType: 'text' },
    { name: 'causeFiledStamp', tier: 'value', doc: 'Clerk-stamp identifier from initial case filing.', valueType: 'text' },
    { name: 'filedOn', tier: 'value', doc: 'Case-opening date (when the case was first filed).', valueType: 'date' },
  ],

  motion: [
    // markers
    { name: 'motion', tier: 'marker', doc: 'Marker: this record is a Motion.', valueType: 'bool' },
    { name: 'equip', tier: 'marker', doc: 'Project Haystack equip marker — Motion = equip.', valueType: 'bool', internal: true },
    { name: 'subMotion', tier: 'marker', doc: 'Present iff this motion has a parent motionRef (amended motion).', valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Motion is filed at the appellate level.', valueType: 'bool' },
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent Case (site).', refTarget: 'case' },
    { name: 'motionRef', tier: 'ref', doc: 'Parent motion (if this is a sub/amended motion).', refTarget: 'motion' },
    { name: 'amends', tier: 'ref', doc: 'Explicit pointer to the motion this one amends.', refTarget: 'motion' },
    { name: 'supersedes', tier: 'ref', doc: 'Explicit pointer to the motion this one supersedes.', refTarget: 'motion' },
    { name: 'judgeRef', tier: 'ref', doc: 'The judge assigned to THIS motion.', refTarget: 'person' },
    { name: 'movantRef', tier: 'ref', doc: 'The party making this motion.', refTarget: 'person' },
    { name: 'respondentRef', tier: 'ref', doc: 'The party responding to this motion.', refTarget: 'person' },
    // values
    { name: 'motionType', tier: 'value', doc: 'Kind of motion (e.g. "disqualify", "summary-judgment").', valueType: 'text' },
    { name: 'revisionSeq', tier: 'value', doc: '1 for the original motion; increments per amendment.', valueType: 'number' },
  ],

  motionEvent: [
    { name: 'motionEvent', tier: 'marker', doc: 'Marker: lifecycle event on a Motion.', valueType: 'bool', internal: true },
    { name: 'point', tier: 'marker', doc: 'Project Haystack point marker — MotionEvent = point.', valueType: 'bool', internal: true },
    { name: 'received', tier: 'marker', doc: 'Event kind: received (mutually exclusive with other kinds).', valueType: 'bool' },
    { name: 'filed', tier: 'marker', doc: 'Event kind: party-filed (e-filed). Not the legally-operative date.', valueType: 'bool' },
    { name: 'courtFiled', tier: 'marker', doc: 'Event kind: clerk-stamped. THIS is when the deadline clock starts.', valueType: 'bool' },
    { name: 'responded', tier: 'marker', doc: 'Event kind: a response was filed.', valueType: 'bool' },
    { name: 'signed', tier: 'marker', doc: 'Event kind: signed by judge.', valueType: 'bool' },
    { name: 'granted', tier: 'marker', doc: 'Event kind: motion granted.', valueType: 'bool' },
    { name: 'denied', tier: 'marker', doc: 'Event kind: motion denied.', valueType: 'bool' },
    { name: 'hearingHeld', tier: 'marker', doc: 'Event kind: a hearing on this motion was held.', valueType: 'bool' },
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'fileRef', tier: 'ref', doc: 'Reference to the document (PDF) for this event.', refTarget: 'doc' },
    { name: 'authoredBy', tier: 'ref', doc: 'Person who authored / filed this event.', refTarget: 'person' },
    { name: 'judgeRef', tier: 'ref', doc: 'Judge for this event (e.g. on signed/granted/denied).', refTarget: 'person' },
    { name: 'courtClerkRef', tier: 'ref', doc: 'Court clerk who stamped (on courtFiled events).', refTarget: 'person' },
    { name: 'occurredOn', tier: 'value', doc: 'When the event occurred.', valueType: 'date' },
    { name: 'courtFilingDate', tier: 'value', doc: 'Official clerk-stamp date (on courtFiled events).', valueType: 'date' },
    { name: 'causeNoStamp', tier: 'value', doc: "Clerk's stamp identifier for this filing.", valueType: 'text' },
    { name: 'kind', tier: 'value', doc: 'The EventKind value (e.g. "filed", "signed", "granted").', valueType: 'text' },
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
    // Refs
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'fileRef', tier: 'ref', doc: 'Reference to the document (PDF).', refTarget: 'doc' },
    { name: 'amends', tier: 'ref', doc: 'Attachment this one amends.', refTarget: 'motionAttachment' },
    { name: 'supersedes', tier: 'ref', doc: 'Attachment this one supersedes.', refTarget: 'motionAttachment' },
    { name: 'authoredBy', tier: 'ref', doc: 'Person who authored this attachment.', refTarget: 'person' },
    // Values
    { name: 'revisionSeq', tier: 'value', doc: 'Revision sequence number.', valueType: 'number' },
    { name: 'attachmentKind', tier: 'value', doc: 'The attachment-kind value (e.g. "proposedOrder").', valueType: 'text' },
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
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'documentRef', tier: 'ref', doc: 'Reference to the underlying PDF document.', refTarget: 'doc' },
    { name: 'preparedBy', tier: 'ref', doc: 'Court clerk who prepared this volume.', refTarget: 'person' },
    // values
    { name: 'volume', tier: 'value', doc: 'Volume number of the clerk’s record.', valueType: 'number' },
    { name: 'filedOn', tier: 'value', doc: 'Date the clerk’s record was filed.', valueType: 'date' },
    { name: 'preparedOn', tier: 'value', doc: 'Date prepared by the clerk.', valueType: 'date' },
  ],

  reportersRecord: [
    // markers
    { name: 'reportersRecord', tier: 'marker', doc: "Marker: this record is a Reporter's Record (court-reporter transcript volumes).", valueType: 'bool' },
    { name: 'appellate', tier: 'marker', doc: 'Filed at the appellate level.', valueType: 'bool' },
    { name: 'supplemental', tier: 'marker', doc: 'Supplemental reporter’s record.', valueType: 'bool' },
    // refs
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'reporterRef', tier: 'ref', doc: 'Court reporter who produced this volume.', refTarget: 'person' },
    { name: 'documentRef', tier: 'ref', doc: 'Reference to the underlying PDF document.', refTarget: 'doc' },
    // values
    { name: 'volume', tier: 'value', doc: 'Volume number of the reporter’s record.', valueType: 'number' },
    { name: 'hearingDate', tier: 'value', doc: 'Date of the hearing/proceeding transcribed.', valueType: 'date' },
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
