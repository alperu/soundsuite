/**
 * Haystack ref/label domain helpers — extracted from `api/haystack/[op]/route.ts`.
 *
 * Pure(-ish) transforms + Prisma-backed label/origin resolution shared by the
 * read and commit paths: ref synthesis from FK columns, ref→label inlining,
 * `dis` (display-string) computation, provenance Origin derivation, and the
 * `recoverTagObject` tags-JSON un-wrapper. The route now just imports these.
 *
 * External deps are intentionally narrow: Prisma (label/origin lookups) and the
 * shared label cache singleton. No HTTP / grid-encoding concerns live here.
 */
import { prisma } from '@/lib/db/prisma'
import { cacheGet, cacheSet, cacheDelete } from './cache'
import { REF_TARGET_MODEL } from './entities'

/**
 * Coerce a ref-shaped value into a bare id string.
 *   - string '@abc'          → 'abc'
 *   - string 'abc'           → 'abc'
 *   - Hayson { _kind:'ref', val:'abc' } → 'abc'
 * Anything else → null.
 */
export function refValueToId(v: unknown): string | null {
  if (typeof v === 'string') {
    if (!v) return null
    return v.startsWith('@') ? v.slice(1) : v
  }
  if (v && typeof v === 'object') {
    const obj = v as { _kind?: unknown; val?: unknown }
    if (obj._kind === 'ref' && typeof obj.val === 'string') {
      return obj.val.startsWith('@') ? obj.val.slice(1) : obj.val
    }
  }
  return null
}

/**
 * Remove self-referential ref tags from a merged record. A row should never
 * reference itself via *Ref / amends / supersedes / authoredBy / respondingTo
 * / motionRefV / personRef / scopeRef etc. We detect by name suffix + a small
 * allowlist so we don't accidentally strip legitimate non-ref tags.
 */
export function stripSelfRefs(out: Record<string, unknown>): void {
  const selfId = typeof out.id === 'string' ? out.id : null
  if (!selfId) return
  const refLikeExact = new Set([
    'amends', 'supersedes', 'authoredBy', 'respondingTo',
    'motionRefV', 'caseRefV', 'fileRefV', 'amendsV', 'supersedesV',
  ])
  for (const k of Object.keys(out)) {
    if (!k.endsWith('Ref') && !k.endsWith('Refs') && !refLikeExact.has(k)) continue
    const v = out[k]
    // List-valued refs: array of refs.
    if (Array.isArray(v)) {
      const filtered = v.filter(x => refValueToId(x) !== selfId)
      if (filtered.length !== v.length) {
        if (filtered.length === 0) delete out[k]
        else out[k] = filtered
      }
      continue
    }
    // motionRefV is a stringified JSON of the ref — handle that too.
    if (k.endsWith('V') && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (refValueToId(parsed) === selfId) delete out[k]
      } catch { /* not JSON — ignore */ }
      continue
    }
    if (refValueToId(v) === selfId) delete out[k]
  }
}

/**
 * Synthesize Haystack `*Ref` tags from a row's foreign-key columns so the tag
 * panel sees them as first-class refs. The Prisma schema stores parent
 * pointers as columns (`caseId`, `motionId`, `judgeId`, …) but the panel
 * binds to `record[spec.name]` where `spec.name` is the Haystack tag
 * (`caseRef`, `motionRef`, `judgeRef`, …). Without this synthesis, refs that
 * live only in columns (the common case for fresh records that haven't been
 * tagged yet) show up as blank in the panel — the original bug for Motion.caseRef.
 *
 * Returned object uses Haystack-ish ref strings (`@<id>`). Callers layer JSON
 * `tags` AFTER these so explicit tag values still win.
 */
export function synthesizeRefsFromColumns(table: string, row: any): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {}
  const ref = (id: unknown): string | undefined =>
    typeof id === 'string' && id.length > 0 ? `@${id}` : undefined
  const out: Record<string, unknown> = {}
  switch (table) {
    case 'Motion':
      out.caseRef = ref(row.caseId)
      out.motionRef = ref(row.parentMotionId)
      out.amends = ref(row.amendsId)
      out.supersedes = ref(row.supersedesId)
      out.judgeRef = ref(row.judgeId)
      out.movantRef = ref(row.movantId)
      out.respondentRef = ref(row.respondentId)
      // Motion has no `documentId` column — fileRef lives in tags only. The
      // tag-merge below (line ~360+) hoists `tags.fileRef` to the top-level
      // `fileRef` key automatically, so we don't need to synthesize anything
      // here. Calling this out explicitly so future maintainers don't add a
      // `ref(row.documentId)` line by analogy with MotionAttachment/RR/CR.
      break
    case 'MotionEvent':
      out.motionRef = ref(row.motionId)
      out.caseRef = ref(row.caseId)
      out.fileRef = ref(row.documentId)
      out.authoredBy = ref(row.authoredById)
      out.judgeRef = ref(row.servedOnId == null ? undefined : undefined) // placeholder, see below
      // (no Motion.judgeId on the event itself — judge on signed/granted comes
      //  from the Motion record, not the event row; surface what we have.)
      out.servedOn = ref(row.servedOnId)
      out.courtClerkRef = ref(row.courtClerkId)
      out.courtReporterRef = ref(row.courtReporterId)
      out.hearingRef = ref(row.hearingId)
      break
    case 'MotionAttachment':
      // `MotionAttachment.motionId` is a required FK that
      // `ensureMotionAttachmentForFiling` seeds equal to the row's own id
      // to satisfy the constraint (no real parent yet — see route.ts:1227
      // and the schema comment on the shadow Motion). Only surface
      // motionRef when it points at a *different* row, i.e. a real parent
      // motion the user actually picked.
      if (typeof row.motionId === 'string' && row.motionId !== row.id) {
        out.motionRef = ref(row.motionId)
      }
      out.caseRef = ref(row.caseId)
      out.fileRef = ref(row.documentId)
      out.amends = ref(row.amendsId)
      out.supersedes = ref(row.supersedesId)
      out.authoredBy = ref(row.authoredById)
      break
    case 'PersonRole': {
      out.personRef = ref(row.personId)
      // Polymorphic scope — synthesize a single scopeRef.
      const sid = typeof row.scopeId === 'string' ? row.scopeId : undefined
      if (sid) out.scopeRef = `@${sid}`
      break
    }
    case 'Hearing':
      out.judgeRef = ref(row.judgeId)
      out.courtClerkRef = ref(row.courtClerkId)
      out.courtReporterRef = ref(row.courtReporterId)
      out.transcriptRef = ref(row.transcriptDocumentId)
      break
    case 'Case':
      // Note: courtRef wiring lands when the Court entity is added (sibling task).
      out.jurisdictionRef = ref(row.jurisdictionId)
      break
    case 'ClerksRecord':
      out.caseRef = ref(row.caseId)
      out.fileRef = ref(row.documentId)
      break
    case 'ReportersRecord':
      out.caseRef = ref(row.caseId)
      out.reporterRef = ref(row.reporterId)
      out.fileRef = ref(row.documentId)
      break
    default:
      break
  }
  // Drop undefineds.
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]
  return out
}

// ---------- ref-label resolution -------------------------------------------

/**
 * Map a ref key name → the Prisma model that ref points at. Mirrors the
 * `refTarget` slot on each TagSpec so the panel and the server agree on
 * how to format the label for a given ref slot.
 *
 * Multi-target refs (scopeRef is polymorphic per PersonRole.scopeKind) are
 * resolved dynamically — see `resolveScopeRef`.
 */
export const REF_TARGET_TABLE: Record<string, 'Case' | 'Motion' | 'Person' | 'Court' | 'Hearing' | 'Document'> = {
  caseRef: 'Case',
  caseRefs: 'Case',
  motionRef: 'Motion',
  motionRefs: 'Motion',
  amends: 'Motion',
  supersedes: 'Motion',
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
 * Invalidate any cached labels for the given ids across every known target
 * table. Called from `commitEntity` after a write so a previously-cached
 * "(missing)" sentinel can't poison the next read for an id whose target
 * row was just created/attached. Bus-busts across tables since the caller
 * doesn't always know which target the id resolves to.
 */
export function invalidateLabelCache(ids: Iterable<string>): void {
  const targets = new Set<string>(Object.values(REF_TARGET_TABLE))
  for (const id of ids) {
    if (!id) continue
    for (const target of targets) cacheDelete(`${target}:${id}`)
  }
}

/**
 * Collect every ref-id mentioned in a patch (single or list-valued) so the
 * commit hook can bust their label-cache entries. Tolerates `string`,
 * `@<id>`, and `{_kind:'ref', val:'<id>'}` shapes.
 */
export function collectRefIdsFromPatch(patch: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (!v) return
    if (typeof v === 'string') {
      const s = v.startsWith('@') ? v.slice(1) : v
      if (s) out.push(s)
      return
    }
    if (typeof v === 'object') {
      const o = v as { _kind?: string; val?: unknown }
      if (o._kind === 'ref' && typeof o.val === 'string') {
        const s = o.val.startsWith('@') ? o.val.slice(1) : o.val
        if (s) out.push(s)
      }
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in REF_TARGET_TABLE) && k !== 'scopeRef') continue
    if (Array.isArray(v)) for (const item of v) push(item)
    else push(v)
  }
  return out
}

/**
 * Map an EntityKind (commit `kind` param) → the Prisma-table name expected
 * by `inlineRefLabels`. Used to wrap the commit response with the same
 * `<refName>Label` arrays the read path produces, so the panel doesn't
 * fall back to UUID display until the user refreshes. Per-filing-type kinds
 * (notice/brief/...) all resolve to MotionAttachment.
 */
export function tableForKind(kind: string): string {
  switch (kind) {
    case 'case': return 'Case'
    case 'motion': return 'Motion'
    case 'motionEvent': return 'MotionEvent'
    case 'motionAttachment': return 'MotionAttachment'
    case 'hearing': return 'Hearing'
    case 'person': return 'Person'
    case 'personRole': return 'PersonRole'
    case 'court': return 'Court'
    case 'clerksRecord': return 'ClerksRecord'
    case 'reportersRecord': return 'ReportersRecord'
    default:
      // Per-filing-type EntityKinds (notice, brief, letter, ...) all live in
      // the MotionAttachment table.
      return 'MotionAttachment'
  }
}

/**
 * Coerce any ref-shaped value to its bare id (no leading `@`). Accepts:
 *   - bare string id ("abc123")
 *   - Haystack-ish `@<id>` string
 *   - Hayson ref object `{_kind:'ref', val:'<id>'}` (with optional leading `@`
 *     inside `val`, since haystack-core preserves it on round-trips)
 *   - Best-effort `{id:'<id>'}` shape from misc emitters
 * Returns null for anything else (numbers, booleans, empty strings, etc.).
 *
 * Replaces the older `stripAt(v)` which only handled bare strings — that
 * variant returned null for Hayson refs, which caused every list-valued ref
 * (plaintiffRefs, defendantRefs, …) and any tag-stored scalar ref to be
 * silently skipped by `inlineRefLabels`.
 */
export function refToId(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') {
    const s = v.startsWith('@') ? v.slice(1) : v
    return s.length > 0 ? s : null
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    if (obj._kind === 'ref' && typeof obj.val === 'string') {
      const s = obj.val.startsWith('@') ? obj.val.slice(1) : obj.val
      return s.length > 0 ? s : null
    }
    if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id
  }
  return null
}

/**
 * Format an ISO-ish YYYY-MM-DD from any date-shaped value. Returns null if
 * the input doesn't parse.
 */
export function asYmd(v: unknown): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v as string | number)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Synthesize a Haystack-canonical `dis` (display-string) for a row. This is
 * the single source-of-truth label per entity type — pickers, the tag panel,
 * the ref-label resolver, and any future Haystack-aware client all read from
 * here. Caller is responsible for stitching it back onto the row.
 *
 * Per-table preference order:
 *   Case            → name → caseNumber → id
 *   Motion          → title → motionType → id
 *   Person          → displayName → email → id
 *   Court           → shortName → name → id
 *   Hearing         → "<hearingType ?? 'Hearing'> on <YYYY-MM-DD>" → id
 *   MotionEvent     → "<kind> on <occurredOn|courtFilingDate as YYYY-MM-DD>" → id
 *   MotionAttachment→ "<attachmentKind ?? 'attachment'>" + " — <title>"? → id
 *   PersonRole      → "<roleMarker> <personDis>" → roleKind → id
 *   Jurisdiction    → displayName → name → code → id
 *   Document        → fileName → id
 *   ClerksRecord    → "Clerk's Record vol <volume>" → id
 *   ReportersRecord → "Reporter's Record vol <volume>" → id
 *
 * Returns a non-empty string on success, or null if the row is unusable.
 */
export function computeDis(table: string, row: any): string | null {
  if (!row || typeof row !== 'object') return null
  // Honour explicit pre-existing `dis` (legacy data may carry one).
  if (typeof row.dis === 'string' && row.dis.length > 0) return row.dis

  // Some legacy rows carry tags as a JSON string. Merge for easier picks.
  let tags: any = row.tags
  if (typeof tags === 'string') { try { tags = JSON.parse(tags) } catch { tags = {} } }
  const merged = (tags && typeof tags === 'object') ? { ...row, ...tags } : row

  switch (table) {
    case 'Case':
      return merged.name || merged.caseNumber || merged.causeNo || merged.id || null
    case 'Motion': {
      const motionType = merged.motionType
      const title = merged.title
      return title || motionType || merged.id || null
    }
    case 'Person':
      return merged.displayName || merged.email || merged.id || null
    case 'Court':
      return merged.shortName || merged.name || merged.id || null
    case 'Hearing': {
      const kind = merged.hearingType || 'Hearing'
      const ymd = asYmd(merged.scheduledFor)
      if (ymd) return `${kind} on ${ymd}`
      return merged.id || null
    }
    case 'MotionEvent': {
      const kind = merged.kind || 'event'
      const ymd = asYmd(merged.occurredOn) || asYmd(merged.courtFilingDate)
      if (ymd) return `${kind} on ${ymd}`
      return kind || merged.id || null
    }
    case 'MotionAttachment': {
      const kind = merged.attachmentKind || merged.kind || 'attachment'
      const title = merged.title || merged.label
      return title ? `${kind} — ${title}` : (kind || merged.id || null)
    }
    case 'PersonRole': {
      // Pick a role-marker from common marker tags; fall back to roleKind.
      const markerKeys = [
        'movant', 'respondent', 'plaintiff', 'defendant', 'judge',
        'courtClerk', 'courtReporter', 'attorney', 'witness',
      ]
      let roleMarker: string | null = null
      for (const k of markerKeys) {
        if (merged[k] === true || merged[k] === 'm:') { roleMarker = k; break }
      }
      roleMarker = roleMarker || merged.roleKind || merged.role || null
      const personDis = merged.personDis || null
      if (roleMarker && personDis) return `${roleMarker} ${personDis}`
      if (personDis) return personDis
      if (roleMarker) return roleMarker
      return merged.id || null
    }
    case 'Jurisdiction':
      return merged.displayName || merged.name || merged.code || merged.id || null
    case 'Document':
      // Full filePath is the canonical "tag value" for fileRef — preserves the
      // disk location so consumers (copy/paste, MCP exports, audit logs) can
      // round-trip it. The panel renders the basename for visual brevity and
      // exposes the full path on hover; see tag-panel.tsx fileRef rendering.
      return merged.filePath || merged.fileName || merged.id || null
    case 'ClerksRecord':
      return merged.volume != null ? `Clerk's Record vol ${merged.volume}` : (merged.id || null)
    case 'ReportersRecord':
      return merged.volume != null ? `Reporter's Record vol ${merged.volume}` : (merged.id || null)
    default:
      return merged.name || merged.title || merged.displayName || merged.id || null
  }
}

/**
 * Format a label for a target row in the convention the ref-picker uses,
 * so the read-mode display matches what users see when picking. Thin wrapper
 * over computeDis — kept for callers that want the "(missing)" sentinel.
 */
export function formatLabelFor(target: string, row: any): string {
  if (!row) return '(missing)'
  return computeDis(target, row) || row.id || '(missing)'
}

//////////////////////////////////////////////////////////////////////////
// Origin derivation (Task #27)
//////////////////////////////////////////////////////////////////////////

export type Origin = 'selfFiled' | 'opposingFiled' | 'courtIssued' | 'thirdParty'
export const ORIGIN_KEYS: readonly Origin[] = ['selfFiled', 'opposingFiled', 'courtIssued', 'thirdParty']

export const ORIGIN_RELEVANT_TABLES = new Set([
  'Motion', 'MotionEvent', 'MotionAttachment', 'ClerksRecord', 'ReportersRecord',
])

/**
 * Resolve the bare id of the "self" Person (the one with `tags.self = true`)
 * once per request. The same Person is referenced by every deriveOrigin call,
 * so memoize at the caller and pass it in.
 */
export async function getSelfPersonId(): Promise<string | null> {
  try {
    const rows = await (prisma as any).$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Person" WHERE json_extract(tags, '$.self') = 1 LIMIT 1
    `
    return rows && rows[0]?.id ? rows[0].id : null
  } catch {
    return null
  }
}

/**
 * Derive a provenance Origin for a Motion / MotionEvent / MotionAttachment /
 * ClerksRecord / ReportersRecord row.
 *
 * Resolution ladder (first match wins):
 *  1. Manual override — one of the four marker keys set true in tags JSON.
 *  2. MotionEvent special case — kind === 'signed' with judge-marker Person
 *     authoredBy ⇒ courtIssued (handled by step 4 once authoredBy is set,
 *     but kept as a fast-path when authoredBy isn't populated yet but the
 *     event kind is unambiguous).
 *  3. No authoredBy ⇒ null (cannot decide).
 *  4. Person.tags.self      ⇒ selfFiled
 *     Person.tags.judge / courtClerk / courtReporter ⇒ courtIssued
 *  5. PersonRole in this case vs self's PersonRole:
 *     opposing side (plaintiff vs defendant / movant vs respondent)
 *                              ⇒ opposingFiled
 *     same side               ⇒ selfFiled (co-counsel)
 *  6. Fallback                 ⇒ thirdParty
 *
 * Returns null when the row isn't an Origin-bearing kind, or when no signal
 * is available. Manual overrides in tags JSON always win, by step 1.
 */
export async function deriveOrigin(
  row: any,
  table: string,
  selfPersonId: string | null,
): Promise<Origin | null> {
  if (!row || typeof row !== 'object') return null
  if (!ORIGIN_RELEVANT_TABLES.has(table)) return null

  const tags = recoverTagObject(row.tags)

  // 1. Manual override wins over derivation. Accept bare bool, numeric 1,
  // and the Hayson marker form `{_kind: 'marker'}`.
  const isMarkerTruth = (v: unknown): boolean => {
    if (v === true || v === 1) return true
    if (v && typeof v === 'object') {
      const k = (v as Record<string, unknown>)._kind
      if (k === 'marker') return true
    }
    return false
  }
  for (const o of ORIGIN_KEYS) {
    if (isMarkerTruth((row as Record<string, unknown>)[o])) return o
    if (isMarkerTruth((tags as Record<string, unknown>)[o])) return o
  }

  // 2 & 3. Need authoredBy to derive anything else.
  const authoredByRaw = (row as any).authoredById ?? (tags as any).authoredBy ?? null
  const authoredById = refToId(authoredByRaw)
  if (!authoredById) {
    // Special case: a MotionEvent with kind='signed' is by convention a
    // court action even when authoredBy isn't yet attributed.
    if (table === 'MotionEvent') {
      const kind = (row as any).kind ?? (tags as any).kind ?? null
      if (kind === 'signed') return 'courtIssued'
    }
    return null
  }

  // 4. Person-marker driven origins.
  const person = await (prisma as any).person.findUnique({ where: { id: authoredById } })
  if (!person) return null
  const pTags = recoverTagObject(person.tags as unknown)
  if (isMarkerTruth(pTags.self)) return 'selfFiled'
  if (isMarkerTruth(pTags.judge) || isMarkerTruth(pTags.courtClerk) || isMarkerTruth(pTags.courtReporter)) {
    return 'courtIssued'
  }

  // 5. Role-in-case detection.
  const caseId = refToId((row as any).caseId ?? (tags as any).caseRef ?? null)
  if (caseId && selfPersonId) {
    const [selfRole, theirRole] = await Promise.all([
      (prisma as any).personRole.findFirst({
        where: { personId: selfPersonId, scopeKind: 'case', scopeId: caseId },
      }),
      (prisma as any).personRole.findFirst({
        where: { personId: person.id, scopeKind: 'case', scopeId: caseId },
      }),
    ])
    const sTags = selfRole ? recoverTagObject(selfRole.tags as unknown) : {}
    const tTags = theirRole ? recoverTagObject(theirRole.tags as unknown) : {}
    const selfIsPlaintiff = isMarkerTruth(sTags.plaintiff) || isMarkerTruth(sTags.movant)
    const selfIsDefendant = isMarkerTruth(sTags.defendant) || isMarkerTruth(sTags.respondent)
    const otherIsPlaintiff = isMarkerTruth(tTags.plaintiff) || isMarkerTruth(tTags.movant)
    const otherIsDefendant = isMarkerTruth(tTags.defendant) || isMarkerTruth(tTags.respondent)
    if ((selfIsPlaintiff && otherIsDefendant) || (selfIsDefendant && otherIsPlaintiff)) {
      return 'opposingFiled'
    }
    if ((selfIsPlaintiff && otherIsPlaintiff) || (selfIsDefendant && otherIsDefendant)) {
      return 'selfFiled'
    }
  }

  // 6. Fallback — authored by someone with no actionable role.
  return 'thirdParty'
}

/**
 * Apply a derived Origin to a row in-place. Emits the bare marker (so a
 * Haystack filter `motion and selfFiled` works) and a single scalar `origin`
 * for clients that prefer the discriminator form.
 */
export function applyOrigin(row: any, origin: Origin | null): any {
  if (!row || typeof row !== 'object' || !origin) return row
  ;(row as any)[origin] = true
  ;(row as any).origin = origin
  return row
}

/**
 * Resolve a polymorphic scopeRef on a PersonRole row. Looks at the parent
 * row's `scopeKind` to know which table to hit. Falls back to no lookup if
 * scopeKind is unknown.
 */
export function scopeRefTarget(parentRow: any): keyof typeof REF_TARGET_TABLE | null {
  const kind = typeof parentRow?.scopeKind === 'string' ? parentRow.scopeKind : null
  if (kind === 'motion') return 'motionRef'
  if (kind === 'case') return 'caseRef'
  if (kind === 'hearing') return 'hearingRef'
  return null
}

/**
 * Walk a row, collect every ref-shaped value into per-target id sets, batch
 * fetch from Prisma, then emit sibling `<refName>Label` fields. Single-valued
 * refs get a string; list-valued refs get an array of strings (matching the
 * input order). Missing targets render as "(missing)".
 *
 * This runs AFTER tags JSON is merged into the row, so explicit tag overrides
 * (e.g. an old row that pinned its own caseRef in tags) are honoured.
 */
export async function inlineRefLabels(row: any, _table: string): Promise<any> {
  if (!row || typeof row !== 'object') return row

  // Collect per-target id sets to batch.
  const buckets: Record<string, Set<string>> = {}
  // Per-key record of (target, ids[]) so we can stitch labels back in order.
  const keyPlans: Array<{ key: string; target: string; ids: (string | null)[]; isList: boolean }> = []

  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue
    if (key === 'id' || key === 'tags' || key.endsWith('Label')) continue

    let target: string | null = null
    if (key === 'scopeRef') {
      const t = scopeRefTarget(row)
      target = t ? REF_TARGET_TABLE[t] : null
    } else if (key in REF_TARGET_TABLE) {
      target = REF_TARGET_TABLE[key]
    }
    if (!target) continue

    const isList = Array.isArray(value)
    const rawList: unknown[] = isList ? (value as unknown[]) : [value]
    // Unwrap each element (string | `@<id>` | Hayson ref object) into a bare id.
    // Nulls in the result represent malformed elements — we keep them in `ids`
    // so we can re-thread them onto the same positions for list-valued refs,
    // but skip the entire key if NONE of the elements yielded a real id.
    const ids = rawList.map((r) => refToId(r))
    if (!ids.some((x) => x)) continue

    keyPlans.push({ key, target, ids, isList })
    const bucket = (buckets[target] ??= new Set<string>())
    for (const id of ids) if (id) bucket.add(id)
  }

  if (keyPlans.length === 0) return row

  // Resolve from cache first, then batch-fetch any leftovers per target.
  const resolved: Record<string, Record<string, string>> = {} // target → id → label
  for (const target of Object.keys(buckets)) {
    resolved[target] = {}
    const missing: string[] = []
    for (const id of buckets[target]) {
      const cached = cacheGet(`${target}:${id}`)
      if (cached !== undefined) resolved[target][id] = cached
      else missing.push(id)
    }
    if (missing.length === 0) continue
    try {
      let rows: any[] = []
      const modelKey = REF_TARGET_MODEL[target]
      if (modelKey) {
        rows = await (prisma as any)[modelKey].findMany({ where: { id: { in: missing } } })
      }
      const byId: Record<string, any> = {}
      for (const r of rows) byId[r.id] = r
      for (const id of missing) {
        const row = byId[id]
        const label = formatLabelFor(target, row)
        resolved[target][id] = label
        // POSITIVE-ONLY caching: only cache hits, never the "(missing)"
        // sentinel. Misses are rare (refs without an FK constraint in the
        // schema rarely dangle), and caching them was poisoning subsequent
        // reads after the target row was finally created — the LRU entry
        // would hold "(missing)" for up to 60s even after `invalidateLabelCache`
        // missed the bus-bust (e.g. created via a path that doesn't pass
        // through `commitEntity`).
        if (row) cacheSet(`${target}:${id}`, label)
      }
    } catch (e: any) {
      // Don't poison the row on lookup failure — emit "(missing)" and move on.
      for (const id of missing) resolved[target][id] = '(missing)'
    }
  }

  // Stitch labels back onto the row.
  const out = { ...row }
  for (const plan of keyPlans) {
    const labels = plan.ids.map((id) => (id ? resolved[plan.target][id] ?? '(missing)' : ''))
    out[`${plan.key}Label`] = plan.isList ? labels : labels[0]
  }
  return out
}

/**
 * Unpeel any number of levels of JSON.stringify wrapping. Defensive
 * against historical bad data from the double-stringify bug: rows
 * saved by the broken commit op stored their tags as a JSON string
 * whose contents were ANOTHER JSON string, and so on. Also handles
 * the "character-indexed object" form where `{...someString}` was
 * accidentally spread into a record. Caps unwrapping at 4 iterations
 * to avoid runaway loops on truly malformed input.
 */
export function recoverTagObject(raw: unknown): Record<string, unknown> {
  let val: unknown = raw
  for (let i = 0; i < 4; i++) {
    if (val == null) return {}
    if (typeof val === 'object' && !Array.isArray(val)) {
      const keys = Object.keys(val as object)
      // Character-spread garbage: keys "0", "1", "2", ... that
      // reassemble into a JSON-stringified object plus a tail of
      // normal keys (the most-recent patch).
      const digitKeys = keys.filter(k => /^\d+$/.test(k))
      if (digitKeys.length > 0 && digitKeys.length >= keys.length / 2) {
        const chars: string[] = []
        const n = digitKeys.length
        for (let j = 0; j < n; j++) {
          const c = (val as Record<string, unknown>)[String(j)]
          if (typeof c !== 'string') break
          chars.push(c)
        }
        const tail: Record<string, unknown> = {}
        for (const k of keys) {
          if (!/^\d+$/.test(k)) tail[k] = (val as Record<string, unknown>)[k]
        }
        try {
          const inner = JSON.parse(chars.join(''))
          if (inner && typeof inner === 'object') {
            return { ...(inner as Record<string, unknown>), ...tail }
          }
        } catch {
          /* fall through */
        }
        return tail
      }
      return val as Record<string, unknown>
    }
    if (typeof val === 'string') {
      try {
        val = JSON.parse(val)
      } catch {
        return {}
      }
      continue
    }
    return {}
  }
  return typeof val === 'object' && val !== null
    ? (val as Record<string, unknown>)
    : {}
}
