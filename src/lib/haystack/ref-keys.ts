/**
 * Which tag keys hold Haystack refs, and what each one points at.
 *
 * Kept in its own dependency-free module because two layers need it and one
 * of them cannot reach the other: `@/lib/haystack/refs` imports Prisma, and
 * Prisma's client extension imports the XETO namespace, so a direct
 * `xeto-namespace → refs` import would close the cycle
 * `prisma → validate → xeto-namespace → refs → prisma`. This file imports
 * nothing, so both sides can depend on it. `refs.ts` re-exports
 * `REF_TARGET_TABLE` for its existing callers.
 */

/**
 * Map a ref key name → the Prisma model that ref points at. Mirrors the
 * `refTarget` slot on each TagSpec so the panel and the server agree on
 * how to format the label for a given ref slot.
 *
 * Multi-target refs (scopeRef is polymorphic per PersonRole.scopeKind) are
 * resolved dynamically — see `resolveScopeRef`.
 */
export const REF_TARGET_TABLE: Record<string, 'Case' | 'Motion' | 'MotionAttachment' | 'Person' | 'Court' | 'Hearing' | 'Document'> = {
  caseRef: 'Case',
  caseRefs: 'Case',
  motionRef: 'Motion',
  motionRefs: 'Motion',
  amends: 'Motion',
  supersedes: 'Motion',
  // Filing-to-filing edges. Both live in tags JSON only (no Prisma column) —
  // `respondingTo` points a response at the motion it answers, `replyingTo`
  // points a reply at the response it answers. Without these entries the
  // pickers save fine but `inlineRefLabels` skips them and the panel renders
  // the raw cuid, and `collectRefIdsFromPatch` never busts the label cache.
  respondingTo: 'Motion',
  replyingTo: 'MotionAttachment',
  // The ruling edge and its derived inverse. `resolves` lives on the order /
  // judgment / decree row and points AT the motion it decides; `orderRefs` is
  // synthesized onto the Motion at read time and points BACK at those
  // attachment rows. Opposite targets on purpose — miss either entry and that
  // side of the pair renders raw cuids.
  resolves: 'Motion',
  orderRefs: 'MotionAttachment',
  judgeRef: 'Person',
  judgeRefs: 'Person',
  movantRef: 'Person',
  movantRefs: 'Person',
  respondentRef: 'Person',
  respondentRefs: 'Person',
  authoredBy: 'Person',
  servedOn: 'Person',
  courtClerkRef: 'Person',
  courtClerkRefs: 'Person',
  // `clerkRef` is the tag name used on Order / Decree / clerk-stamped entries
  // (introduced with the clerkRef extractor — commits 12596cb / beda95b).
  // Without this entry inlineRefLabels skips it and the panel renders the
  // raw cuid instead of the resolved Person name.
  clerkRef: 'Person',
  clerkRefs: 'Person',
  courtReporterRef: 'Person',
  courtReporterRefs: 'Person',
  reporterRef: 'Person',
  personRef: 'Person',
  plaintiffRefs: 'Person',
  defendantRefs: 'Person',
  plaintiffLawyers: 'Person',
  defendantLawyers: 'Person',
  // Notice / Letter / Demand-letter sender + recipient refs. Without these
  // entries `inlineRefLabels` would skip them and the panel would render the
  // raw cuid (e.g. `cmpfjm2i800009zuu5uieqzcu`) instead of the resolved
  // person name (Task #6).
  from: 'Person',
  to: 'Person',
  courtRef: 'Court',
  hearingRef: 'Hearing',
  fileRef: 'Document',
  transcriptRef: 'Document',
}

/**
 * Does this tag key hold a ref (or a list of refs)?
 *
 * The key, not the value shape, is the discriminator. A bare id and a plain
 * string are indistinguishable, and `@`-prefixing is a convention the writers
 * don't apply uniformly — but every ref slot in this domain is named here or
 * is the polymorphic `scopeRef`. Verified against the corpus: no `@`-prefixed
 * string is stored under a key outside this map.
 */
export function isRefKey(key: string): boolean {
  return key in REF_TARGET_TABLE || key === 'scopeRef'
}
