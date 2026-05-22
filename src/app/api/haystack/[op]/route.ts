/**
 * Haystack HTTP API — peer to MCP.
 *
 * Routing: dynamic `[op]` segment dispatches to one of the standard Haystack
 * ops. v1 implements: about, ops, libs, defs, filetypes, nav, read, close.
 * Deferred to v2: commit, watchSub/watchPoll/watchUnsub, SCRAM auth, Zinc.
 *
 * Wire format: Hayson (application/json or application/vnd.haystack+json;version=4).
 * Zinc requests get 415 with `Accept` pointing at JSON.
 *
 * Error convention: HTTP 200 with a grid whose meta carries an `err` marker.
 * Only transport-level errors (auth, malformed body, unknown op) get non-200.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  HAYSON_MIME,
  encodeGrid,
  errGrid,
  okGrid,
  singletonGrid,
  toHayson,
} from '@/lib/legal/hayson'
import { tableFromFilter, navHierarchy, findCase, findMotion, findMotionEvent, findMotionAttachment, findPerson, findPersonRole, findHearing, findClerksRecord, findReportersRecord } from '@/lib/legal/repo'
import { db } from '@/lib/legal/kysely'
import { prisma } from '@/lib/db/prisma'
import { PER_FILING_TYPE_KINDS } from '@/lib/filings/classify-entity-kind'

export const dynamic = 'force-dynamic'

const SUPPORTED_OPS = [
  'about',
  'ops',
  'libs',
  'defs',
  'filetypes',
  'nav',
  'read',
  'close',
  'commit',
] as const
type Op = (typeof SUPPORTED_OPS)[number]

// ---------- transport helpers ----------------------------------------------

function jsonResponse(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'content-type': HAYSON_MIME },
  })
}

function checkAuth(req: NextRequest): { ok: true } | { ok: false; res: NextResponse } {
  const expected = process.env.HAYSTACK_API_KEY ?? process.env.MCP_API_KEY
  if (!expected) {
    // No key configured — refuse rather than running open.
    return {
      ok: false,
      res: new NextResponse('Haystack API key not configured (set HAYSTACK_API_KEY)', { status: 401 }),
    }
  }
  const hdr = req.headers.get('authorization') ?? ''
  // Format: "BEARER authToken=<token>"  (Haystack convention)
  // Also accept plain "Bearer <token>" for ergonomics.
  let token: string | null = null
  const m1 = hdr.match(/^bearer\s+authToken\s*=\s*(\S+)/i)
  if (m1) token = m1[1]
  else {
    const m2 = hdr.match(/^bearer\s+(\S+)/i)
    if (m2) token = m2[1]
  }
  if (!token || token !== expected) {
    return {
      ok: false,
      res: new NextResponse('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'BEARER realm="haystack"' },
      }),
    }
  }
  return { ok: true }
}

function rejectZinc(req: NextRequest): NextResponse | null {
  const accept = (req.headers.get('accept') ?? '').toLowerCase()
  const ctype = (req.headers.get('content-type') ?? '').toLowerCase()
  if (accept.includes('text/zinc') || ctype.includes('text/zinc')) {
    return new NextResponse('Zinc not supported; use Hayson (application/json)', {
      status: 415,
      headers: { accept: `${HAYSON_MIME}, application/json` },
    })
  }
  return null
}

// ---------- op implementations ---------------------------------------------

async function opAbout(): Promise<string> {
  const now = new Date().toISOString()
  let version = '0.1.0'
  try {
    // Best-effort read of package.json
    const pkg = await import('../../../../../package.json' as any).catch(() => null)
    if (pkg && typeof pkg === 'object' && 'version' in pkg) version = String((pkg as any).version)
  } catch { /* ignore */ }
  return singletonGrid({
    haystackVersion: '4.0',
    productName: 'Sound Suite',
    productVersion: version,
    productUri: { _kind: 'uri', val: 'https://soundsuite.ai' },
    vendorName: 'Sound Suite',
    vendorUri: { _kind: 'uri', val: 'https://soundsuite.ai' },
    projName: 'court-lens-mcp',
    tz: 'UTC',
    serverTime: { _kind: 'dateTime', val: now, tz: 'UTC' },
    serverBootTime: { _kind: 'dateTime', val: now, tz: 'UTC' },
    whoAmI: 'anonymous',
  })
}

function opOps(): string {
  const rows = SUPPORTED_OPS.map((name) => ({
    name,
    def: `op:${name}`,
    dis: name,
  }))
  return encodeGrid(rows)
}

async function opLibs(): Promise<string> {
  // Try Agent 2's namespace singleton; if missing, return a stub list of the
  // libs we plan to load.
  let libs: any[] = []
  try {
    const mod: any = await (import('@/lib/legal/xeto-namespace' as any) as Promise<any>).catch(() => null)
    const ns = mod?.ns ?? mod?.getNamespace?.() ?? null
    if (ns && Array.isArray(ns.libs)) {
      libs = ns.libs.map((l: any) => ({
        name: l.name ?? String(l),
        version: l.version ?? '0.0.0',
      }))
    }
  } catch { /* ignore */ }
  if (!libs.length) {
    libs = [
      { name: 'sys', version: '0.0.0' },
      { name: 'ph', version: '4.0' },
      { name: 'proc.core', version: '0.0.0' },
      { name: 'cc.courtlens.legal', version: '0.0.0' },
      { name: 'proc.tx', version: '0.0.0' },
    ]
  }
  return encodeGrid(libs.map((l) => ({ name: l.name, version: l.version, lib: { _kind: 'marker' } })))
}

async function opDefs(): Promise<string> {
  // Marshal whatever the namespace exposes; otherwise return an empty grid.
  try {
    const mod: any = await (import('@/lib/legal/xeto-namespace' as any) as Promise<any>).catch(() => null)
    const ns = mod?.ns ?? mod?.getNamespace?.() ?? null
    const defs: any[] = []
    if (ns?.libs) {
      for (const lib of ns.libs) {
        const specs = lib.specs ?? lib.types ?? lib.defs ?? []
        for (const s of specs) {
          defs.push({
            def: `${lib.name}::${s.name ?? s.qname}`,
            lib: lib.name,
            doc: s.doc ?? '',
          })
        }
      }
    }
    return encodeGrid(defs)
  } catch {
    return encodeGrid([])
  }
}

function opFiletypes(): string {
  return encodeGrid([
    { filetype: 'hayson', mime: HAYSON_MIME, dis: 'Hayson (JSON)' },
    { filetype: 'json', mime: 'application/json', dis: 'JSON' },
  ])
}

async function opNav(params: URLSearchParams, body: any): Promise<string> {
  const navId = params.get('navId') ?? body?.navId?.val ?? body?.navId ?? undefined
  const rows = await navHierarchy(typeof navId === 'string' ? navId : undefined)
  return encodeGrid(rows)
}

/**
 * Marker → entity-kind map used for the panel's filter strings. Tag-panel sends
 * `filter=<kind>` where `<kind>` is the camelCase EntityKind (case, motion,
 * motionEvent, motionAttachment, hearing, personRole). `tableFromFilter` is
 * already case-insensitive on bare markers, but we normalize defensively.
 */
function normalizeFilter(filter: string): string {
  return filter.trim()
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
function synthesizeRefsFromColumns(table: string, row: any): Record<string, unknown> {
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
      out.motionRef = ref(row.motionId)
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
      out.documentRef = ref(row.documentId)
      break
    case 'ReportersRecord':
      out.caseRef = ref(row.caseId)
      out.reporterRef = ref(row.reporterId)
      out.documentRef = ref(row.documentId)
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
const REF_TARGET_TABLE: Record<string, 'Case' | 'Motion' | 'Person' | 'Court' | 'Hearing' | 'Document'> = {
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
  courtReporterRef: 'Person',
  courtReporterRefs: 'Person',
  reporterRef: 'Person',
  personRef: 'Person',
  plaintiffRefs: 'Person',
  defendantRefs: 'Person',
  plaintiffLawyers: 'Person',
  defendantLawyers: 'Person',
  courtRef: 'Court',
  hearingRef: 'Hearing',
  fileRef: 'Document',
  documentRef: 'Document',
  transcriptRef: 'Document',
}

/**
 * Tiny in-memory LRU for ref → label lookups. The case-management UI hits
 * /api/haystack/read on every panel render; without caching a Motion row
 * with 8 refs would issue 8 queries per page-view. Capped at 5000 entries,
 * 60s TTL (labels rarely change and read-staleness here is acceptable).
 */
const LABEL_CACHE = new Map<string, { label: string; expiresAt: number }>()
const LABEL_CACHE_MAX = 5000
const LABEL_CACHE_TTL_MS = 60_000

function cacheGet(key: string): string | undefined {
  const hit = LABEL_CACHE.get(key)
  if (!hit) return undefined
  if (hit.expiresAt < Date.now()) {
    LABEL_CACHE.delete(key)
    return undefined
  }
  // touch — refresh insertion order for naive LRU
  LABEL_CACHE.delete(key)
  LABEL_CACHE.set(key, hit)
  return hit.label
}

function cacheSet(key: string, label: string): void {
  if (LABEL_CACHE.size >= LABEL_CACHE_MAX) {
    const firstKey = LABEL_CACHE.keys().next().value
    if (firstKey !== undefined) LABEL_CACHE.delete(firstKey)
  }
  LABEL_CACHE.set(key, { label, expiresAt: Date.now() + LABEL_CACHE_TTL_MS })
}

/**
 * Invalidate any cached labels for the given ids across every known target
 * table. Called from `commitEntity` after a write so a previously-cached
 * "(missing)" sentinel can't poison the next read for an id whose target
 * row was just created/attached. Bus-busts across tables since the caller
 * doesn't always know which target the id resolves to.
 */
function invalidateLabelCache(ids: Iterable<string>): void {
  const targets = new Set<string>(Object.values(REF_TARGET_TABLE))
  for (const id of ids) {
    if (!id) continue
    for (const target of targets) LABEL_CACHE.delete(`${target}:${id}`)
  }
}

/**
 * Collect every ref-id mentioned in a patch (single or list-valued) so the
 * commit hook can bust their label-cache entries. Tolerates `string`,
 * `@<id>`, and `{_kind:'ref', val:'<id>'}` shapes.
 */
function collectRefIdsFromPatch(patch: Record<string, unknown>): string[] {
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
function tableForKind(kind: string): string {
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
function refToId(v: unknown): string | null {
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
function asYmd(v: unknown): string | null {
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
function computeDis(table: string, row: any): string | null {
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
      return merged.fileName || merged.id || null
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
function formatLabelFor(target: string, row: any): string {
  if (!row) return '(missing)'
  return computeDis(target, row) || row.id || '(missing)'
}

/**
 * Resolve a polymorphic scopeRef on a PersonRole row. Looks at the parent
 * row's `scopeKind` to know which table to hit. Falls back to no lookup if
 * scopeKind is unknown.
 */
function scopeRefTarget(parentRow: any): keyof typeof REF_TARGET_TABLE | null {
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
async function inlineRefLabels(row: any, _table: string): Promise<any> {
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
      const p = prisma as any
      switch (target) {
        case 'Case':
          rows = await p.case.findMany({ where: { id: { in: missing } } })
          break
        case 'Motion':
          rows = await p.motion.findMany({ where: { id: { in: missing } } })
          break
        case 'Person':
          rows = await p.person.findMany({ where: { id: { in: missing } } })
          break
        case 'Court':
          rows = await p.court.findMany({ where: { id: { in: missing } } })
          break
        case 'Hearing':
          rows = await p.hearing.findMany({ where: { id: { in: missing } } })
          break
        case 'Document':
          rows = await p.document.findMany({ where: { id: { in: missing } } })
          break
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
 * Sniff an attachmentKind out of a Haystack filter string. The tag panel sends
 * `filter=<kind>` where `<kind>` is one of the per-filing-type EntityKinds
 * (notice, brief, letter, …). Case-insensitive on the bare word; returns the
 * canonical camelCase attachmentKind, or null if the filter isn't one of the
 * known kinds. (Polymorphic camelCase markers like `proposedOrder` /
 * `billOfReview` / `returnOfService` / `demandLetter` arrive lowercased from
 * the panel's normalizeFilter, so we match on lowercase keys.)
 */
function attachmentKindFromFilter(filter: string): string | null {
  const text = ` ${filter.toLowerCase()} `
  // Pre-compute lowercase → canonical lookup once per call. Cheap; ~22 entries.
  for (const [canonical] of Object.entries(KIND_TO_ATTACHMENT_KIND)) {
    const lc = canonical.toLowerCase()
    if (new RegExp(`[^a-z_]${lc}[^a-z_]`).test(text)) return canonical
  }
  return null
}

async function opRead(params: URLSearchParams, body: any): Promise<string> {
  const filter = normalizeFilter(
    params.get('filter') ??
      (typeof body?.filter === 'string' ? body.filter : body?.filter?.val) ??
      '',
  )
  if (!filter) {
    console.log('[haystack/read] err=missing-filter')
    return errGrid('read requires a filter parameter')
  }
  const limitRaw = params.get('limit') ?? body?.limit
  const limit = limitRaw != null ? Number(limitRaw) : undefined

  // Direct id lookup — bypass the haystack-core filter compiler since `id`
  // lives in a column, not the `tags` JSON. Tag-panel sends `id=@<id>`.
  const idParam = params.get('id') ?? body?.id
  const idValue = typeof idParam === 'string' ? idParam.replace(/^@/, '') : null

  // Court is owned by the courts module (Prisma-direct), not the kysely
  // DB type used by tableFromFilter. Intercept `filter=court` here so
  // /api/haystack/read?filter=court returns Court rows for the ref-picker.
  if (/(^|[^a-z_])court([^a-z_]|$)/i.test(filter)) {
    const grid = await opReadCourt(params, body, limit, idValue)
    console.log(`[haystack/read] filter=${JSON.stringify(filter)} id=${idValue ?? '-'} table=Court rows=${countGridRows(grid)}`)
    return grid
  }

  const table = tableFromFilter(filter)
  if (!table) {
    console.log(`[haystack/read] err=no-marker filter=${JSON.stringify(filter)}`)
    return errGrid(
      'filter must contain an entity marker (motion, motionEvent, person, personRole, hearing, case, court)',
    )
  }
  try {
    let rows: any[]
    if (idValue) {
      // Read-by-id: skip the filter compiler entirely. ClerksRecord/ReportersRecord
      // are not in the Kysely DB type map (yet), so go through Prisma for those.
      if (table === ('ClerksRecord' as any)) {
        const row = await (prisma as any).clerksRecord.findUnique({ where: { id: idValue } })
        rows = row ? [row] : []
      } else if (table === ('ReportersRecord' as any)) {
        const row = await (prisma as any).reportersRecord.findUnique({ where: { id: idValue } })
        rows = row ? [row] : []
      } else {
        rows = await (db as any)
          .selectFrom(table as any)
          .selectAll()
          .where('id' as any, '=', idValue as any)
          .limit(1)
          .execute()
        // Mirror the commit-path auto-upsert: when the panel reads a Motion
        // by Filing.id and no Motion row exists yet, materialize one so the
        // panel sees an empty-but-real record instead of an empty grid.
        if (rows.length === 0 && table === 'Motion') {
          const created = await ensureMotionForFiling(idValue)
          if (created) rows = [created]
        }
        // Same for MotionAttachment: per-filing-type kinds (notice/brief/…)
        // need their row materialized on first read so the panel surfaces the
        // marker section instead of the "unavailable" banner. Filter string
        // carries the EntityKind (e.g. `filter=notice`), which we map back
        // to an attachmentKind.
        if (rows.length === 0 && table === 'MotionAttachment') {
          const ak = attachmentKindFromFilter(filter)
          if (ak) {
            const created = await ensureMotionAttachmentForFiling(idValue, ak)
            if (created) rows = [created]
          }
        }
      }
    } else {
      switch (table) {
        case 'Motion': rows = await findMotion(filter, limit); break
        case 'MotionEvent': rows = await findMotionEvent(filter, limit); break
        case 'MotionAttachment': rows = await findMotionAttachment(filter, limit); break
        case 'Person': rows = await findPerson(filter, limit); break
        case 'PersonRole': rows = await findPersonRole(filter, limit); break
        case 'Hearing': rows = await findHearing(filter, limit); break
        case 'Case': rows = await findCase(filter, limit); break
        case 'ClerksRecord' as any: rows = await findClerksRecord(filter, limit); break
        case 'ReportersRecord' as any: rows = await findReportersRecord(filter, limit); break
        default:
          console.log(`[haystack/read] err=not-implemented filter=${JSON.stringify(filter)} table=${String(table)}`)
          return errGrid(`entity ${table} not implemented in v1`)
      }
    }
    // Inline the tags JSON + synthesize Haystack refs from FK columns onto
    // each row. Order matters:
    //   1. spread the raw row (columns)
    //   2. layer synthesized refs (e.g. `caseRef: '@' + caseId`) — fallback only
    //   3. layer the parsed JSON tags — these WIN over column-derived refs
    //      so legacy/explicit tag values aren't clobbered.
    const inlined = rows.map((r: any) => {
      const out: any = { ...r }
      const synth = synthesizeRefsFromColumns(table, r)
      for (const [k, v] of Object.entries(synth)) {
        if (out[k] == null && v != null) out[k] = v
      }
      if (typeof r?.tags === 'string') {
        try {
          const parsed = JSON.parse(r.tags)
          if (parsed && typeof parsed === 'object') Object.assign(out, parsed)
        } catch { /* ignore malformed tags */ }
      } else if (r?.tags && typeof r.tags === 'object') {
        Object.assign(out, r.tags)
      }
      // Synthesize `dis` (Haystack display-string convention) so ref pickers
      // have a single canonical label field to render. The pickers fall back to
      // entity-specific fields (name/title/displayName), but `dis` lets them
      // (and any future Haystack-aware client) treat all kinds uniformly.
      // Re-uses `computeDis` so row.dis stays identical to <ref>Label values
      // pointing at the same row.
      if (out.dis == null) {
        const d = computeDis(table, out)
        if (d) out.dis = d
      }
      return out
    })
    // Resolve every ref-shaped value (caseRef, judgeRef, ...) into a
    // sibling `<refName>Label` string the panel can render in read mode.
    // Batched per-target so we issue at most one Prisma query per table.
    const withLabels = await Promise.all(inlined.map((r: any) => inlineRefLabels(r, table)))
    const grid = encodeGrid(withLabels, { table: table as any })
    console.log(`[haystack/read] filter=${JSON.stringify(filter)} id=${idValue ?? '-'} table=${table} rows=${inlined.length}`)
    return grid
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.log(`[haystack/read] err filter=${JSON.stringify(filter)} table=${String(table)} msg=${msg}`)
    // Missing table in v1 schema → clean err grid, not 500.
    if (/no such table|no such column/i.test(msg)) {
      return errGrid(`schema not yet migrated: ${msg}`)
    }
    return errGrid(`read failed: ${msg}`)
  }
}

/**
 * Count the rows in an encoded grid string. Cheap — parses once for the log
 * line. Returns -1 on parse failure (so the log line stays readable).
 */
function countGridRows(gridJson: string): number {
  try {
    const g = JSON.parse(gridJson)
    return Array.isArray(g?.rows) ? g.rows.length : 0
  } catch {
    return -1
  }
}

/**
 * Court read — Prisma-direct, since Court isn't in the kysely DB type.
 * Supports `id=@<id>` direct lookup, `q=<name>` LIKE search, and
 * `courtType=<type>` filtering inferred from the filter string.
 */
async function opReadCourt(
  params: URLSearchParams,
  body: any,
  limit: number | undefined,
  idValue: string | null,
): Promise<string> {
  try {
    if (idValue) {
      const row = await prisma.court.findUnique({ where: { id: idValue } })
      if (!row) return encodeGrid([], { table: 'Court' as any })
      const withLabels = await inlineRefLabels(inlineCourt(row), 'Court')
      return encodeGrid([withLabels], { table: 'Court' as any })
    }
    const q = (params.get('q') ?? body?.q ?? '').toString().trim()
    // Heuristic: pluck a courtType marker (`trial`/`appellate`/`supreme`/`magistrate`)
    // out of the filter string if present. The ref-picker just sends `court`,
    // but the admin UI may send `court and courtType=="appellate"`.
    const filterStr = (params.get('filter') ?? '').toString().toLowerCase()
    let courtType: string | null = null
    for (const t of ['trial', 'appellate', 'supreme', 'magistrate']) {
      if (filterStr.includes(`"${t}"`) || new RegExp(`courttype\\s*==\\s*"?${t}"?`).test(filterStr)) {
        courtType = t
        break
      }
    }
    const where: any = {}
    if (q) where.name = { contains: q }
    if (courtType) where.courtType = courtType
    const rows = await prisma.court.findMany({
      where,
      orderBy: { name: 'asc' },
      take: typeof limit === 'number' && Number.isFinite(limit) ? Math.min(limit, 500) : 100,
    })
    const inlined = rows.map(inlineCourt)
    const withLabels = await Promise.all(inlined.map((r: any) => inlineRefLabels(r, 'Court')))
    return encodeGrid(withLabels, { table: 'Court' as any })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (/no such table|no such column/i.test(msg)) {
      return errGrid(`schema not yet migrated: ${msg}`)
    }
    return errGrid(`court read failed: ${msg}`)
  }
}

function inlineCourt(c: any): any {
  let tags: any = c?.tags
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags) } catch { tags = {} }
  }
  const out: any = { ...c, ...(tags && typeof tags === 'object' ? tags : {}) }
  // Synthesize Haystack `dis` so clients have one canonical label per row.
  if (out.dis == null) {
    const d = computeDis('Court', out)
    if (d) out.dis = d
  }
  return out
}

/**
 * Auto-upsert a Motion row mirroring a motion-typed Filing.
 *
 * Background: the case-management UI keys filings (events) by `Filing.id`,
 * but tags live on the XETO entity (Motion / MotionAttachment / etc.). For
 * motion-typed Filings we adopt the convention `Motion.id === Filing.id`, so
 * the panel can read/write tags against the Filing id without the caller
 * needing to know whether a Motion row has been materialized yet.
 *
 * Returns the (possibly freshly-created) Motion row, or null if no Filing
 * exists for `filingId` or the Filing isn't motion-typed.
 *
 * Idempotency: races between two concurrent saves can both reach the
 * `create` call. We catch the unique-violation on the second one and
 * re-read the row.
 */
async function ensureMotionForFiling(
  filingId: string,
  opts: { anyFilingType?: boolean } = {},
): Promise<any | null> {
  const existing = await (prisma as any).motion.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } })
  if (!filing) return null
  // Default behavior (motion-typed Filings only): preserves Task #10 semantics
  // where `kind:'motion'` reads/commits materialize a Motion row.
  //
  // When called from `ensureMotionAttachmentForFiling` (anyFilingType: true)
  // we relax this so per-filing-type kinds (notice/brief/letter/…) can hang
  // their MotionAttachment row off a parent Motion. `MotionAttachment.motionId`
  // is a required FK, so we need a Motion regardless of filing type. The
  // Motion's `motion` marker is still seeded — for non-motion filings it's a
  // structural shadow row, but harmless: the panel reads MotionAttachment for
  // those kinds, not Motion.
  if (!opts.anyFilingType && !/motion/i.test(filing.filingType ?? '')) return null
  try {
    return await (prisma as any).motion.create({
      data: {
        id: filing.id,
        filingId: filing.id,
        caseId: filing.caseId,
        title: filing.title ?? '',
        description: filing.description ?? null,
        // schema requires startPage (Int). Use 1 as a benign default; the
        // real page range is on the underlying Document, not the Motion
        // entity-level container.
        startPage: 1,
        endPage: null,
        // XETO Motion spec requires the `motion` marker. Seed it so the
        // create passes validation; if the caller's patch also sets it
        // (the common case for the "tag motion=true" panel save), the
        // tag merge is idempotent.
        tags: { motion: { _kind: 'marker' } } as any, // marker; `dict()` also accepts `true` but Hayson form is explicit
      },
    })
  } catch (e: any) {
    // Likely a unique-violation race — another request created it first.
    const row = await (prisma as any).motion.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}

/**
 * EntityKind → MotionAttachment.attachmentKind. Identity mapping for the 22
 * per-filing-type kinds. `motion` is NOT in here — that goes through
 * `ensureMotionForFiling`, not MotionAttachment.
 *
 * Single source of truth: `PER_FILING_TYPE_KINDS` in
 * `src/lib/filings/classify-entity-kind.ts`. Both this map and
 * `tableFromFilter` import from there so the read-side and commit-side stay
 * in sync.
 */
const KIND_TO_ATTACHMENT_KIND: Record<string, string> = PER_FILING_TYPE_KINDS

/**
 * Auto-upsert a `MotionAttachment` row mirroring a non-motion-typed Filing.
 * Parallel to `ensureMotionForFiling` for the Motion case.
 *
 * The tag panel keys per-filing-type tag edits by `Filing.id`, but tags live
 * on `MotionAttachment.tags` (rows discriminated by `attachmentKind`). For a
 * fresh Notice / Brief / Letter / … Filing no MotionAttachment row exists
 * yet, so the panel's `read?filter=notice&id=@<filing-id>` returns an empty
 * grid and the subsequent `commit` finds nothing to update.
 *
 * We adopt the convention `MotionAttachment.id === Filing.id` (same trick as
 * Motion). Because `MotionAttachment.motionId` is a required FK, we also
 * materialize a parent Motion row using the relaxed `ensureMotionForFiling`
 * (anyFilingType: true). The shadow Motion exists only to satisfy the FK;
 * the tag panel reads MotionAttachment for these kinds.
 *
 * Idempotent — catches unique-violation races and re-reads.
 */
async function ensureMotionAttachmentForFiling(
  filingId: string,
  attachmentKind: string,
): Promise<any | null> {
  const existing = await (prisma as any).motionAttachment.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } })
  if (!filing) return null

  // Ensure a parent Motion row exists for the FK.
  const motion = await ensureMotionForFiling(filingId, { anyFilingType: true })
  if (!motion) return null

  try {
    return await (prisma as any).motionAttachment.create({
      data: {
        id: filingId,
        motionId: motion.id,
        caseId: filing.caseId,
        attachmentKind,
        revisionSeq: filing.supplementalOrder ?? 1,
        // Seed XETO markers so the row passes any future validator hooks. The
        // `attachment` umbrella marker plus the specific kind marker mirror
        // what the tag-spec entries for each kind define.
        tags: {
          attachment: { _kind: 'marker' },
          [attachmentKind]: { _kind: 'marker' },
        } as any,
      },
    })
  } catch (e: any) {
    const row = await (prisma as any).motionAttachment.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}

/**
 * commit — single source of truth for Case and Filing data.
 *
 * Accepts `{ id, kind, patch }` (panel shape) or a Haystack-style grid row
 * with `id` + tag fields. Splits the patch into a column-patch (real Prisma
 * columns) and a tag-patch (everything else), and writes BOTH in one update.
 *
 * Create semantics: when `id` is missing OR equals "new", an INSERT is
 * performed; structural keys (`id`, `createdAt`, `updatedAt`) are dropped
 * from the column patch and required-fields are validated per kind.
 *
 * XETO validation runs automatically if the Prisma extension is wired
 * (`src/lib/db/prisma.ts`); otherwise this just persists.
 */

// Map EntityKind → Prisma model name (camelCase). Module-level so the legacy
// shim (and any other internal caller) can reuse it.
//
// Per-filing-type EntityKinds (notice/brief/response/…) all serialize to the
// MotionAttachment Prisma table — the table's `attachmentKind` discriminator
// column (set at row creation, not here) carries the type. The tag panel only
// mutates `tags` JSON via this commit op. The full list of per-filing-type
// kinds is pulled from `PER_FILING_TYPE_KINDS` so adding a new EntityKind
// only requires touching one constant.
const KIND_MODEL_MAP: Record<string, string> = {
  case: 'case',
  motion: 'motion',
  motionEvent: 'motionEvent',
  motionAttachment: 'motionAttachment',
  hearing: 'hearing',
  person: 'person',
  personRole: 'personRole',
  court: 'court',
  clerksRecord: 'clerksRecord',
  reportersRecord: 'reportersRecord',
  ...Object.fromEntries(
    Object.keys(PER_FILING_TYPE_KINDS).map((k) => [k, 'motionAttachment'] as const),
  ),
}

// Columns that hold DateTime values. JSON arrives as ISO strings; Prisma
// requires `Date` instances. Per Prisma model.
const DATE_COLUMNS: Record<string, Set<string>> = {
  motionEvent: new Set(['occurredOn', 'courtFilingDate']),
  personRole: new Set(['appearedOn', 'withdrewOn']),
  hearing: new Set(['scheduledFor', 'heldOn']),
  clerksRecord: new Set(['filedOn']),
  reportersRecord: new Set(['hearingDate']),
}

// Per-kind required column-fields for CREATE. Validated before Prisma so the
// err grid is clear instead of a P2002/P2025 surprise.
const REQUIRED_ON_CREATE: Record<string, string[]> = {
  case: ['name', 'path'],
  motion: ['caseId', 'title'],
  motionEvent: ['motionId', 'caseId', 'kind', 'occurredOn'],
  motionAttachment: ['motionId', 'caseId', 'attachmentKind'],
  person: ['displayName'],
  personRole: ['personId', 'scopeKind', 'scopeId'],
  hearing: ['scheduledFor'],
  court: ['name'],
  clerksRecord: ['caseId'],
  reportersRecord: ['caseId'],
}

/**
 * Split an incoming patch into `columnPatch` (real Prisma columns) and
 * `tagPatch` (everything else, destined for the `tags` JSON bag). Also
 * coerces dates from ISO strings → `Date`. Drops structural keys
 * (`id`/`tags`/`createdAt`/`updatedAt`) from the column patch.
 */
function splitPatch(
  model: string,
  patch: any,
): { columnPatch: Record<string, unknown>; tagPatch: Record<string, unknown> } {
  const columnPatch: Record<string, unknown> = {}
  const tagPatch: Record<string, unknown> = {}
  if (!patch || typeof patch !== 'object') return { columnPatch, tagPatch }

  const colSet = NON_TAG_COLUMNS[model] ?? new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const structural = new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const dateCols = DATE_COLUMNS[model] ?? new Set<string>()

  for (const [k, vRaw] of Object.entries(patch)) {
    if (structural.has(k)) continue
    // Read-only server-inlined ref-label siblings (`caseRefLabel`, …) must
    // never reach the tags JSON. The client strips these too; this is belt-
    // and-suspenders for any other caller of commitEntity.
    if (k.endsWith('Label')) continue
    // `dis` is server-synthesized on read (via computeDis) — never persist it.
    if (k === 'dis') continue
    if (colSet.has(k)) {
      let v = vRaw
      // Normalize empty strings on nullable columns to null so the form's
      // "clear the field" UX actually clears the column.
      if (typeof v === 'string') v = v.trim()
      if (v === '') v = null
      // Coerce ISO date strings to Date for DateTime columns.
      if (dateCols.has(k) && typeof v === 'string') {
        const d = new Date(v)
        v = isNaN(d.getTime()) ? null : d
      } else if (dateCols.has(k) && v != null && (v as any) instanceof Date === false) {
        // Hayson date wrappers like { _kind: 'dateTime', val: '...' }
        const inner = (v as any)?.val
        if (typeof inner === 'string') {
          const d = new Date(inner)
          v = isNaN(d.getTime()) ? null : d
        }
      }
      columnPatch[k] = v
    } else {
      tagPatch[k] = vRaw
    }
  }
  return { columnPatch, tagPatch }
}

/**
 * Post-commit hooks for Case path changes. Mirrors the legacy
 * `PATCH /api/cases/[id]` behavior: when `path` changes (or a new case is
 * created), reconcile the FileWatcher.
 *
 * Errors from the reattach call are swallowed and logged — a saved path
 * change with a stale watcher is still better than rolling back the commit.
 * Operators can recover by restarting the service.
 */
async function applyCaseSideEffects(
  before: { path?: string | null } | null,
  after: { id?: string | null; path?: string | null } | null,
): Promise<void> {
  const afterPath = typeof after?.path === 'string' ? after.path.trim() : null
  if (!afterPath) return
  const beforePath = typeof before?.path === 'string' ? before.path.trim() : null
  try {
    const { getServicesManager } = await import('@/lib/services-manager')
    const fileWatcher = getServicesManager().getFileWatcher()
    if (!fileWatcher) {
      console.log(
        `[haystack/commit] case-path change: file-watcher not registered, skipping reattach (case=${after?.id ?? '?'} new=${JSON.stringify(afterPath)})`,
      )
      return
    }
    if (!before) {
      console.log(`[haystack/commit] case create: attaching file-watcher (case=${after?.id ?? '?'} path=${JSON.stringify(afterPath)})`)
      await fileWatcher.reattachCase({ oldPath: null, newPath: afterPath, caseId: after?.id ?? null })
    } else if (beforePath && beforePath !== afterPath) {
      console.log(`[haystack/commit] case-path changed, reattach: ${JSON.stringify(beforePath)} -> ${JSON.stringify(afterPath)} (case=${after?.id ?? '?'})`)
      await fileWatcher.reattachCase({ oldPath: beforePath, newPath: afterPath, caseId: after?.id ?? null })
      if (after?.id) {
        try {
          const { migrateDocumentsForCasePath } = await import('@/services/document-path-migrator')
          const result = await migrateDocumentsForCasePath(after.id, beforePath, afterPath)
          console.log(`[doc-migrate] case=${after.id} updated=${result.updated} skipped=${result.skipped}`)
        } catch (e) {
          console.warn(`[doc-migrate] failed case=${after?.id ?? '?'}: ${e instanceof Error ? e.message : e}`)
        }
      }
    }
  } catch (e: any) {
    console.log(`[haystack/commit] file-watcher reattach failed (case=${after?.id ?? '?'}): ${e?.message ?? e}`)
  }
}

/**
 * Map Prisma errors → user-friendly err grids. P2002 is unique-violation,
 * P2025 is record-not-found, etc.
 */
function prismaErrToGrid(e: any, kind: string): string {
  const code = e?.code
  if (code === 'P2002') {
    const tgt = e?.meta?.target
    const fields = Array.isArray(tgt) ? tgt.join(', ') : String(tgt ?? 'unique field')
    return errGrid(`${kind} ${fields} must be unique (constraint violation)`)
  }
  if (code === 'P2025') return errGrid(`${kind} not found`)
  if (code === 'P2003') return errGrid(`${kind} foreign key constraint failed: ${e?.meta?.field_name ?? ''}`)
  return errGrid(`commit failed: ${e?.message ?? e}`)
}

/**
 * Core commit function — exported so legacy `/api/cases/*` endpoints can
 * call into the same write path.
 */
export async function commitEntity(input: {
  id?: string | null
  kind: string
  patch: Record<string, unknown>
}): Promise<{ ok: true; row: any } | { ok: false; errGridJson: string }> {
  const { kind } = input
  let id = input.id
  if (typeof id === 'string') id = id.replace(/^@/, '')
  if (id === 'new' || id === '') id = null

  const model = KIND_MODEL_MAP[kind]
  if (!model) return { ok: false, errGridJson: errGrid(`unknown kind: ${kind}`) }
  const client = (prisma as any)[model]
  if (!client?.update || !client?.create) {
    return { ok: false, errGridJson: errGrid(`Prisma model ${model} not available`) }
  }

  const patch = input.patch ?? {}
  if (!patch || typeof patch !== 'object') {
    return { ok: false, errGridJson: errGrid('commit requires a patch object') }
  }

  const { columnPatch, tagPatch } = splitPatch(model, patch)

  // ─── CREATE ─────────────────────────────────────────────────────────────
  if (!id) {
    const required = REQUIRED_ON_CREATE[kind] ?? []
    const missing = required.filter((k) => {
      const v = columnPatch[k]
      return v == null || (typeof v === 'string' && v === '')
    })
    if (missing.length) {
      return { ok: false, errGridJson: errGrid(`${kind} create missing required: ${missing.join(', ')}`) }
    }

    // Case-specific defaults & path validation
    if (kind === 'case') {
      if (columnPatch.country == null) columnPatch.country = 'United States'
      const pathOk = await validateCasePath(columnPatch.path as string)
      if (pathOk !== true) return { ok: false, errGridJson: errGrid(pathOk) }
      // Trim trailing slashes
      columnPatch.path = (columnPatch.path as string).replace(/\/+$/, '')
    }

    const createData: any = { ...columnPatch }
    if (Object.keys(tagPatch).length) createData.tags = tagPatch

    try {
      const created = await client.create({ data: createData })
      if (kind === 'case') await applyCaseSideEffects(null, created)
      // Bust any cached "(missing)" labels for ids the patch attached, so the
      // resolver below picks up the freshly-created targets instead of stale
      // negatives.
      invalidateLabelCache(collectRefIdsFromPatch(patch))
      // Inline ref labels into the response so the panel can render display
      // names immediately after save (without forcing a follow-up read).
      const row = await inlineRefLabels(inlineRow(created), tableForKind(kind))
      return { ok: true, row }
    } catch (e: any) {
      return { ok: false, errGridJson: prismaErrToGrid(e, kind) }
    }
  }

  // ─── UPDATE ─────────────────────────────────────────────────────────────
  try {
    let existing = await client.findUnique({ where: { id } })
    if (!existing && kind === 'motion') {
      existing = await ensureMotionForFiling(id)
    }
    if (!existing && model === 'motionAttachment') {
      // Per-filing-type kinds (notice/brief/letter/…) all resolve to the
      // motionAttachment Prisma model. Auto-upsert the row from the Filing
      // on first save so the panel doesn't have to pre-create it.
      const ak = KIND_TO_ATTACHMENT_KIND[kind]
      if (ak) existing = await ensureMotionAttachmentForFiling(id, ak)
    }
    if (!existing) {
      return { ok: false, errGridJson: errGrid(`${kind} ${id} not found`) }
    }

    // Case path validation only when path actually changed
    if (kind === 'case' && typeof columnPatch.path === 'string' && columnPatch.path !== existing.path) {
      const pathOk = await validateCasePath(columnPatch.path)
      if (pathOk !== true) return { ok: false, errGridJson: errGrid(pathOk) }
      columnPatch.path = (columnPatch.path as string).replace(/\/+$/, '')
    }

    const currentTags = recoverTagObject(existing.tags)
    const merged: Record<string, unknown> = { ...currentTags, ...tagPatch }
    for (const k of Object.keys(merged)) {
      if (merged[k] == null) delete merged[k]
    }

    const data: any = { ...columnPatch }
    // Only write the `tags` column when the patch actually contains tag
    // fields. Otherwise leave it untouched — the legacy PATCH /api/cases
    // path never touched tags, and re-sending the existing tag bag would
    // re-trigger the XETO validator on legacy/un-migrated tag keys.
    if (Object.keys(tagPatch).length > 0) {
      data.tags = merged
    }

    const updated = await client.update({ where: { id }, data })
    if (kind === 'case') await applyCaseSideEffects(existing, updated)
    // Bust label-cache for any ref id the patch touched. The read-side LRU
    // ages at 60s, but if a previously-empty Person row was just attached
    // here, an earlier "(missing)" sentinel would still hide the new label
    // until TTL — fix by dropping the entry before re-resolving.
    invalidateLabelCache(collectRefIdsFromPatch(patch))
    // Re-resolve labels on the returned row so the client's `setRecord(rec)`
    // after `hsCommit` lands rows with `<refName>Label` arrays present — the
    // bug that made plaintiffRefs render as UUIDs immediately post-save.
    const row = await inlineRefLabels(inlineRow(updated), tableForKind(kind))
    return { ok: true, row }
  } catch (e: any) {
    return { ok: false, errGridJson: prismaErrToGrid(e, kind) }
  }
}

function inlineRow(updated: any): any {
  const tags = recoverTagObject(updated.tags)
  return { ...updated, ...tags, tags }
}

/**
 * Validate that a Case.path points at an existing directory.
 * Returns `true` on success, or an error string on failure.
 */
async function validateCasePath(p: unknown): Promise<true | string> {
  if (typeof p !== 'string' || p.trim() === '') return 'case path is required'
  const fs = await import('fs/promises')
  try {
    const stat = await fs.stat(p.trim())
    if (!stat.isDirectory()) return `path is not a directory: ${p}`
    return true
  } catch {
    return `folder does not exist: ${p}`
  }
}

async function opCommit(_params: URLSearchParams, body: any): Promise<string> {
  if (!body || typeof body !== 'object') return errGrid('commit requires a JSON body')

  const idRaw: unknown =
    typeof body.id === 'string' ? body.id :
    body.id?.val != null ? String(body.id.val) : null

  const kind: string | null =
    typeof body.kind === 'string' ? body.kind :
    typeof body._kind === 'string' ? body._kind : null
  if (!kind) return errGrid('commit requires a kind (case|motion|motionEvent|motionAttachment|hearing|person|personRole|...)')

  const patch: any = body.patch ?? (() => {
    const { id: _i, kind: _k, _kind, ...rest } = body
    return rest
  })()

  const result = await commitEntity({ id: idRaw as string | null, kind, patch })
  if (!result.ok) return result.errGridJson
  return encodeGrid([result.row], { table: kind as any })
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
function recoverTagObject(raw: unknown): Record<string, unknown> {
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

/**
 * Strip column-level fields from the patch. The tag panel sends back
 * the full draft record (columns + inlined tags), so the patch may
 * contain `name`, `caseNumber`, `path`, etc. — those are real DB
 * columns, not tags, and must not be merged into the JSON.
 */
const NON_TAG_COLUMNS: Record<string, Set<string>> = {
  case: new Set(['id', 'tags', 'name', 'path', 'caseNumber', 'jurisdiction', 'country', 'state', 'county', 'createdAt', 'updatedAt']),
  motion: new Set(['id', 'tags', 'filingId', 'caseId', 'parentMotionId', 'amendsId', 'supersedesId', 'revisionSeq', 'judgeId', 'movantId', 'respondentId', 'title', 'description', 'startPage', 'endPage', 'createdAt', 'updatedAt']),
  motionEvent: new Set(['id', 'tags', 'motionId', 'caseId', 'kind', 'occurredOn', 'courtFilingDate', 'causeNoStamp', 'documentId', 'authoredById', 'servedOnId', 'courtClerkId', 'courtReporterId', 'hearingId', 'createdAt', 'updatedAt']),
  motionAttachment: new Set(['id', 'tags', 'motionId', 'caseId', 'attachmentKind', 'documentId', 'amendsId', 'supersedesId', 'revisionSeq', 'authoredById', 'createdAt', 'updatedAt']),
  person: new Set(['id', 'tags', 'displayName', 'email', 'barNumber', 'jurisdictionId', 'createdAt', 'updatedAt']),
  personRole: new Set(['id', 'tags', 'personId', 'scopeKind', 'scopeId', 'appearedOn', 'withdrewOn', 'createdAt', 'updatedAt']),
  hearing: new Set(['id', 'tags', 'judgeId', 'courtReporterId', 'courtClerkId', 'scheduledFor', 'heldOn', 'durationMin', 'location', 'transcriptDocumentId', 'hearingType', 'createdAt', 'updatedAt']),
  court: new Set(['id', 'tags', 'name', 'shortName', 'jurisdictionId', 'courtType', 'address', 'phone', 'website', 'createdAt', 'updatedAt']),
  clerksRecord: new Set(['id', 'tags', 'caseId', 'volume', 'filedOn', 'documentId', 'createdAt', 'updatedAt']),
  reportersRecord: new Set(['id', 'tags', 'caseId', 'reporterId', 'volume', 'hearingDate', 'documentId', 'createdAt', 'updatedAt']),
}

function filterToTagFields(model: string, patch: any): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') return {}
  const skip = NON_TAG_COLUMNS[model] ?? new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (skip.has(k)) continue
    out[k] = v
  }
  return out
}

function opClose(): string {
  // No session state in v1.
  return okGrid()
}

// ---------- dispatch --------------------------------------------------------

/**
 * Shared dispatcher. The public route enforces bearer auth; the same-origin
 * proxy at `/api/haystack-proxy/[op]` passes `skipAuth: true` so the browser
 * tag panel can read without shipping a token. The proxy is the only legitimate
 * caller that should set `skipAuth`.
 */
export async function dispatchHaystack(
  req: NextRequest,
  op: string,
  { skipAuth = false }: { skipAuth?: boolean } = {},
): Promise<NextResponse> {
  const zinc = rejectZinc(req)
  if (zinc) return zinc
  if (!skipAuth) {
    const auth = checkAuth(req)
    if (!auth.ok) return auth.res
  }

  if (!SUPPORTED_OPS.includes(op as Op)) {
    return new NextResponse(errGrid(`unknown op: ${op}`), {
      status: 404,
      headers: { 'content-type': HAYSON_MIME },
    })
  }

  // Parse body if present (POST); otherwise use query params (GET).
  const url = new URL(req.url)
  let body: any = null
  if (req.method !== 'GET') {
    try {
      const text = await req.text()
      body = text ? JSON.parse(text) : null
    } catch (e: any) {
      return new NextResponse(`Malformed JSON: ${e?.message}`, { status: 400 })
    }
    // Hayson grid bodies have a `rows[0]` carrying the params.
    if (body?._kind === 'grid' && Array.isArray(body.rows) && body.rows.length) {
      body = body.rows[0]
    }
  }

  try {
    switch (op as Op) {
      case 'about': return jsonResponse(await opAbout())
      case 'ops': return jsonResponse(opOps())
      case 'libs': return jsonResponse(await opLibs())
      case 'defs': return jsonResponse(await opDefs())
      case 'filetypes': return jsonResponse(opFiletypes())
      case 'nav': return jsonResponse(await opNav(url.searchParams, body))
      case 'read': return jsonResponse(await opRead(url.searchParams, body))
      case 'close': return jsonResponse(opClose())
      case 'commit': return jsonResponse(await opCommit(url.searchParams, body))
    }
  } catch (e: any) {
    return jsonResponse(errGrid(`op ${op} failed: ${e?.message ?? e}`))
  }

  // unreachable
  return jsonResponse(errGrid('dispatch fell through'))
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return dispatchHaystack(req, params.op)
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return dispatchHaystack(req, params.op)
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return dispatchHaystack(req, params.op)
}

// silence unused-import warning if toHayson tree-shakes out
void toHayson
