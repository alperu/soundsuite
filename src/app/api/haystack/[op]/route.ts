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
} from '@/lib/legal/hayson'
import { tableFromFilter, navHierarchy } from '@/lib/legal/repo'
import { db } from '@/lib/legal/kysely'
import { prisma } from '@/lib/db/prisma'
import {
  stripSelfRefs,
  synthesizeRefsFromColumns,
  invalidateLabelCache,
  collectRefIdsFromPatch,
  tableForKind,
  computeDis,
  getSelfPersonId,
  deriveOrigin,
  applyOrigin,
  inlineRefLabels,
  recoverTagObject,
  refToId,
  ORDER_SHAPED_KINDS,
  ORIGIN_RELEVANT_TABLES,
  type Origin,
} from '@/lib/haystack/refs'
import { ENTITY_FINDERS } from '@/lib/haystack/entities'
import {
  ensureMotionForFiling,
  ensureMotionAttachmentForFiling,
  ensureReportersRecordForFiling,
  ensureClerksRecordForFiling,
  KIND_TO_ATTACHMENT_KIND,
} from '@/lib/haystack/ensure-filing'
import { commitEntity } from '@/lib/haystack/commit'
// Re-exported so the legacy `/api/cases/*` endpoints (fill-haystack-tags,
// revert) and the commit tests keep importing it from the route path.
export { commitEntity }

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
      if ((table as string) === 'ClerksRecord') {
        let row = await (prisma as any).clerksRecord.findUnique({ where: { id: idValue } })
        // Mirror Motion / MotionAttachment: when the panel reads a Clerk's
        // Record filing by Filing.id and no ClerksRecord row exists, auto-
        // upsert one from the Filing so the panel sees an empty-but-real
        // record (with caseRef synthesized from the FK column) instead of
        // an empty grid.
        if (!row) row = await ensureClerksRecordForFiling(idValue)
        rows = row ? [row] : []
      } else if ((table as string) === 'ReportersRecord') {
        let row = await (prisma as any).reportersRecord.findUnique({ where: { id: idValue } })
        if (!row) row = await ensureReportersRecordForFiling(idValue)
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
      const finder = ENTITY_FINDERS[table]
      if (!finder) {
        console.log(`[haystack/read] err=not-implemented filter=${JSON.stringify(filter)} table=${String(table)}`)
        return errGrid(`entity ${table} not implemented in v1`)
      }
      rows = await finder(filter, limit)
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
      // Drop self-referential refs: any *Ref / amends / supersedes / authoredBy
      // / respondingTo whose target id equals this row's id. These are leftover
      // self-loops from the shadow-Motion FK convention (see
      // ensureMotionAttachmentForFiling) or from prior commits that
      // round-tripped the seeded motionRef. They are never semantically valid.
      stripSelfRefs(out)
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
    // Backfill auto-fileRef for MotionAttachment rows that pre-date the
    // ensure() fix that sets documentId at creation time (Task #3). Batched
    // single Prisma query so this is cheap for list reads too.
    if (table === 'MotionAttachment') {
      const missingIds: string[] = []
      for (const r of inlined) {
        if (!r.documentId && r.fileRef == null && typeof r.id === 'string') {
          missingIds.push(r.id)
        }
      }
      if (missingIds.length > 0) {
        const docs = await (prisma as any).document.findMany({
          where: { filingId: { in: missingIds } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, filingId: true },
        })
        const byFiling: Record<string, string> = {}
        for (const d of docs) {
          if (d.filingId && !(d.filingId in byFiling)) byFiling[d.filingId] = d.id
        }
        for (const r of inlined) {
          const did = byFiling[r.id as string]
          if (did) {
            r.documentId = did
            if (r.fileRef == null) r.fileRef = `@${did}`
          }
        }
      }
    }
    // Derive `orderRefs` on Motion rows: the inverse of the `resolves` edge
    // that orders / judgments / decrees carry. Assigned AFTER the tag merge
    // and unconditionally — a stale value persisted into tags JSON by an older
    // build must not win over the live derivation (the merge at line ~348
    // gives tags priority over synthesized refs).
    const proposedOrderIds = new Set<string>()
    if (table === 'Motion' && inlined.length > 0) {
      const rulings = await (prisma as any).motionAttachment.findMany({
        where: { attachmentKind: { in: [...ORDER_SHAPED_KINDS] } },
        select: { id: true, motionId: true, attachmentKind: true, tags: true },
      })
      const byMotion = new Map<string, string[]>()
      for (const ruling of rulings) {
        const tags = recoverTagObject(ruling.tags)
        // `resolves` is the real edge; `motionRef` is the fallback for rows
        // tagged before it existed. The shadow-parent sentinel
        // (motionId === own id, seeded by ensureMotionAttachmentForFiling)
        // is not a parent link — without this guard every order that shares a
        // filing id with its shadow Motion would resolve itself.
        const explicit = refToId(tags.resolves)
        const fallback =
          typeof ruling.motionId === 'string' && ruling.motionId !== ruling.id
            ? ruling.motionId
            : null
        const targetId = explicit ?? fallback
        if (!targetId || targetId === ruling.id) continue
        const list = byMotion.get(targetId) ?? []
        list.push(ruling.id)
        byMotion.set(targetId, list)
        if (ruling.attachmentKind === 'proposedOrder') proposedOrderIds.add(ruling.id)
      }
      for (const r of inlined) {
        const ids = byMotion.get(r.id)
        if (ids && ids.length > 0) r.orderRefs = ids.map((id: string) => `@${id}`)
        else delete r.orderRefs
      }
    }
    // Resolve every ref-shaped value (caseRef, judgeRef, ...) into a
    // sibling `<refName>Label` string the panel can render in read mode.
    // Batched per-target so we issue at most one Prisma query per table.
    const withLabels = await Promise.all(inlined.map((r: any) => inlineRefLabels(r, table)))
    // A proposed order and a signed one resolve to the same display string, so
    // mark the proposals in the derived list. Done here rather than in
    // `computeDis` — that label feeds every ref row in the app, and only this
    // list needs the distinction.
    if (proposedOrderIds.size > 0) {
      for (const r of withLabels as any[]) {
        if (!Array.isArray(r.orderRefs) || !Array.isArray(r.orderRefsLabel)) continue
        r.orderRefsLabel = r.orderRefsLabel.map((label: unknown, i: number) => {
          const id = refToId(r.orderRefs[i])
          return id && proposedOrderIds.has(id) && typeof label === 'string'
            ? `Proposed: ${label}`
            : label
        })
      }
    }
    // Materialize the filing-provenance Origin marker (Task #27). No-op when
    // `table` isn't one of the Origin-bearing kinds. selfPersonId is hoisted
    // out of the per-row loop so we do one lookup per request, not per row.
    if (ORIGIN_RELEVANT_TABLES.has(table)) {
      const selfPersonId = await getSelfPersonId()
      await Promise.all(
        withLabels.map(async (r: any) => applyOrigin(r, await deriveOrigin(r, table, selfPersonId))),
      )
    }
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
      const row = await (prisma as any).court.findUnique({ where: { id: idValue } })
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
    const rows = await (prisma as any).court.findMany({
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

function opClose(): string {
  // No session state in v1.
  return okGrid()
}

// ---------- dispatch --------------------------------------------------------

/**
 * Op → handler registry. Each handler returns a Hayson grid string;
 * `dispatchHaystack` wraps it in `jsonResponse`. Typing this as
 * `Record<Op, …>` makes the op set exhaustive at compile time — adding an op
 * to `SUPPORTED_OPS` without a handler here is now a type error (the old
 * `switch` would have silently fallen through).
 */
const HANDLERS: Record<Op, (params: URLSearchParams, body: any) => string | Promise<string>> = {
  about: () => opAbout(),
  ops: () => opOps(),
  libs: () => opLibs(),
  defs: () => opDefs(),
  filetypes: () => opFiletypes(),
  nav: (params, body) => opNav(params, body),
  read: (params, body) => opRead(params, body),
  close: () => opClose(),
  commit: (params, body) => opCommit(params, body),
}

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
    // `op` is validated against SUPPORTED_OPS above, so the lookup is total.
    return jsonResponse(await HANDLERS[op as Op](url.searchParams, body))
  } catch (e: any) {
    return jsonResponse(errGrid(`op ${op} failed: ${e?.message ?? e}`))
  }
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
