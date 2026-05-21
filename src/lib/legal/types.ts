/**
 * Hand-written TypeScript types for the v1 legal-domain tag dicts.
 *
 * These mirror the XETO specs in `src/xeto/cc.courtlens.legal/` and
 * `src/xeto/proc.core/`. The runtime authority is still `@haxall/haxall`
 * (via {@link import('./xeto-namespace').validateTags}); these types
 * exist only for compile-time narrowing.
 *
 * **Codegen is future work.** Agent 5 owns the
 * `xeto compile → JSON Schema → json-schema-to-typescript` pipeline
 * that will generate this file. For v1 we maintain by hand and accept
 * the duplication.
 *
 * @see docs/xeto-haystack-research.md §4.0
 * @see docs/xeto-haystack-research.md §12.2 (type pipeline)
 */

/** Haystack ref string — `@<id>`. We carry it as a plain string. */
export type Ref = string

/** Haystack marker — presence-only tag. `true` means present. */
export type Marker = true

/** ISO-8601 datetime string. */
export type DateTimeStr = string

// ---------------------------------------------------------------------------
// proc.core — Amendable mixin + procedural primitives
// ---------------------------------------------------------------------------

/**
 * Amendable mixin. Reused on Motion + every MotionAttachment subtype.
 * `amends` = semantic predecessor; `supersedes` = procedural replacement.
 */
export interface Amendable {
  amends?: Ref
  supersedes?: Ref
  revisionSeq?: number
}

/** TriggerEvent Choice — exactly one is true on a Rule instance. */
export type TriggerEventTags =
  | { servedOn: Marker; filedOn?: never }
  | { filedOn: Marker; servedOn?: never }

/** Consequence Choice — exactly one is true on a Rule instance. */
export type ConsequenceTags =
  | { deemedAdmitted: Marker; noticeOfDefault?: never; noConsequence?: never }
  | { noticeOfDefault: Marker; deemedAdmitted?: never; noConsequence?: never }
  | { noConsequence: Marker; deemedAdmitted?: never; noticeOfDefault?: never }

/** SupersessionPolicy Choice — exactly one applies per amendment. */
export type SupersessionPolicyTags =
  | { resetsClock: Marker; continuesClock?: never; discharges?: never }
  | { continuesClock: Marker; resetsClock?: never; discharges?: never }
  | { discharges: Marker; resetsClock?: never; continuesClock?: never }

/** proc.core::Rule — instance shape. */
export type RuleTags = {
  rule: Marker
  citation: string
  dueAfterDays: number
  targetFilingType?: string
  notes?: string
} & TriggerEventTags &
  ConsequenceTags

// ---------------------------------------------------------------------------
// cc.courtlens.legal — domain entities
// ---------------------------------------------------------------------------

export interface JurisdictionTags {
  jurisdiction: Marker
  code: string
  displayName: string
  parent?: Ref
}

export interface CourtTags {
  court: Marker
  displayName: string
  jurisdictionRef: Ref
  county?: string
  district?: string
}

/** Canonical immutable identity. Intrinsic markers only. */
export interface PersonTags {
  person: Marker
  displayName: string
  email?: string
  barNumber?: string
  jurisdictionRef?: Ref
  // Intrinsic role markers:
  lawyer?: Marker
  judge?: Marker
  courtClerk?: Marker
  courtReporter?: Marker
  bailiff?: Marker
  proSe?: Marker
  self?: Marker
}

/** Ghost record binding a Person to a scope with contextual roles. */
export interface PersonRoleTags {
  personRole: Marker
  personRef: Ref
  scopeRef: Ref
  // Contextual role markers — any combination:
  movant?: Marker
  respondent?: Marker
  defendant?: Marker
  plaintiff?: Marker
  intervenor?: Marker
  lawyerMovant?: Marker
  lawyerRespondent?: Marker
  judge?: Marker
  appearedOn?: DateTimeStr
  withdrewOn?: DateTimeStr
}

/** Case — Haystack site analog. */
export interface CaseTags {
  case: Marker
  site: Marker
  causeNo: string
  jurisdictionRef: Ref
  courtRef?: Ref
  judgeRefs?: Ref[]
  plaintiffRefs?: Ref[]
  defendantRefs?: Ref[]
  respondentRefs?: Ref[]
  movantRefs?: Ref[]
  courtClerkRefs?: Ref[]
  courtReporterRefs?: Ref[]
  filedOn?: DateTimeStr
  causeFiledStamp?: string
}

/**
 * Motion — Haystack equip analog, nestable, intersects Amendable.
 *
 * Note: ph::Equip requires `siteRef` (the spec lifts the standard
 * Haystack site/equip relationship). Our `caseRef` mirrors `siteRef`
 * semantically — the validator currently accepts `siteRef` alongside
 * `caseRef`; we set both at insert time and treat `caseRef` as the
 * authoritative one for the domain.
 */
export interface MotionTags extends Amendable {
  motion: Marker
  equip: Marker
  caseRef: Ref
  siteRef?: Ref
  motionRef?: Ref
  subMotion?: Marker
  motionType: string
  judgeRef?: Ref
  movantRef?: Ref
  respondentRef?: Ref
}

/** MotionEvent kind — exclusive Choice. */
export type EventKindTags =
  | { received: Marker }
  | { filed: Marker }
  | { courtFiled: Marker }
  | { responded: Marker }
  | { signed: Marker }
  | { granted: Marker }
  | { denied: Marker }
  | { served: Marker }
  | { hearingHeld: Marker }
  | { withdrawn: Marker }
  | { mooted: Marker }

/** MotionEvent — Haystack point analog. */
export type MotionEventTags = {
  motionEvent: Marker
  point: Marker
  motionRef: Ref
  caseRef: Ref
  occurredOn: DateTimeStr
  courtFilingDate?: DateTimeStr
  causeNoStamp?: string
  fileRef?: Ref
  authoredBy?: Ref
  servedOn?: Ref
  courtClerkRef?: Ref
  courtReporterRef?: Ref
  judgeRef?: Ref
  hearingRef?: Ref
} & EventKindTags

/** Hearing — shared cross-motion entity. */
export interface HearingTags {
  hearing: Marker
  hybrid?: Marker
  caseRefs: Ref[]
  motionRefs: Ref[]
  judgeRef: Ref
  courtReporterRef?: Ref
  courtClerkRef?: Ref
  scheduledFor: DateTimeStr
  heldOn?: DateTimeStr
  durationMin?: number
  location?: string
  remote?: Marker
  transcriptRef?: Ref
  hearingType?: string
}

/** MotionAttachment base shape — every subtype intersects Amendable. */
export interface MotionAttachmentBase extends Amendable {
  attachment: Marker
  motionRef: Ref
  caseRef: Ref
  fileRef: Ref
  authoredBy?: Ref
}

export type MotionAttachmentTags =
  | (MotionAttachmentBase & { proposedOrder: Marker })
  | (MotionAttachmentBase & { brief: Marker })
  | (MotionAttachmentBase & { response: Marker })
  | (MotionAttachmentBase & { exhibit: Marker; label?: string })
  | (MotionAttachmentBase & {
      email: Marker
      fromRef?: Ref
      toRefs?: Ref[]
      subject?: string
      sentOn?: DateTimeStr
    })
  | (MotionAttachmentBase & { evidence: Marker })
  | (MotionAttachmentBase & { supportingDoc: Marker })

/**
 * Discriminated union spanning every Prisma model that carries a
 * `tags Json` column. Useful for `repo.writeTagged<TagShape>(...)`
 * call sites where the caller already knows which shape they have.
 */
export type LegalDomainTags =
  | CaseTags
  | MotionTags
  | MotionEventTags
  | MotionAttachmentTags
  | PersonTags
  | PersonRoleTags
  | HearingTags
  | RuleTags
