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
export type EntityKind = 'case' | 'motion' | 'motionEvent' | 'motionAttachment' | 'hearing';

export interface TagSpec {
  name: string;
  tier: TagTier;
  /** XETO doc string — shown in the (?) tooltip. */
  doc: string;
  /** Value type hint for the editor (text/number/date/bool/ref). */
  valueType?: 'text' | 'number' | 'date' | 'bool' | 'ref';
  /** For ref-typed tags, which entityKind the target should be. */
  refTarget?: 'person' | 'motion' | 'case' | 'court' | 'hearing' | 'doc' | 'motionAttachment';
}

/** Per-entity tag set. Order here is the order shown in the UI. */
export const TAG_SPEC_BY_KIND: Record<EntityKind, TagSpec[]> = {
  case: [
    // markers
    { name: 'case', tier: 'marker', doc: 'Marker: this record is a Case (site).', valueType: 'bool' },
    { name: 'site', tier: 'marker', doc: 'Project Haystack site marker — Case = site.', valueType: 'bool' },
    { name: 'jurisdictionTx', tier: 'marker', doc: 'Texas jurisdiction.', valueType: 'bool' },
    { name: 'jurisdictionCa', tier: 'marker', doc: 'California jurisdiction.', valueType: 'bool' },
    { name: 'jurisdictionFed', tier: 'marker', doc: 'Federal jurisdiction.', valueType: 'bool' },
    // refs
    { name: 'courtRef', tier: 'ref', doc: 'Reference to the Court record where this case is filed.', refTarget: 'court' },
    { name: 'judgeRefs', tier: 'refs', doc: 'List of judges assigned to this case (Persons).', refTarget: 'person' },
    { name: 'plaintiffRefs', tier: 'refs', doc: 'List of plaintiffs (Persons or organizations).', refTarget: 'person' },
    { name: 'defendantRefs', tier: 'refs', doc: 'List of defendants (Persons or organizations).', refTarget: 'person' },
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
    { name: 'equip', tier: 'marker', doc: 'Project Haystack equip marker — Motion = equip.', valueType: 'bool' },
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
    { name: 'motionEvent', tier: 'marker', doc: 'Marker: lifecycle event on a Motion.', valueType: 'bool' },
    { name: 'point', tier: 'marker', doc: 'Project Haystack point marker — MotionEvent = point.', valueType: 'bool' },
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
    { name: 'attachment', tier: 'marker', doc: 'Marker: attachment to a Motion.', valueType: 'bool' },
    { name: 'proposedOrder', tier: 'marker', doc: 'Attachment kind: proposed order.', valueType: 'bool' },
    { name: 'brief', tier: 'marker', doc: 'Attachment kind: brief.', valueType: 'bool' },
    { name: 'evidence', tier: 'marker', doc: 'Attachment kind: evidence.', valueType: 'bool' },
    { name: 'exhibit', tier: 'marker', doc: 'Attachment kind: exhibit.', valueType: 'bool' },
    { name: 'affidavit', tier: 'marker', doc: 'Attachment kind: affidavit.', valueType: 'bool' },
    { name: 'motionRef', tier: 'ref', doc: 'Reference to the parent motion.', refTarget: 'motion' },
    { name: 'caseRef', tier: 'ref', doc: 'Reference to the parent case.', refTarget: 'case' },
    { name: 'fileRef', tier: 'ref', doc: 'Reference to the document (PDF).', refTarget: 'doc' },
    { name: 'amends', tier: 'ref', doc: 'Attachment this one amends.', refTarget: 'motionAttachment' },
    { name: 'supersedes', tier: 'ref', doc: 'Attachment this one supersedes.', refTarget: 'motionAttachment' },
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
