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
import { tableFromFilter, navHierarchy, findCase, findMotion, findMotionEvent, findMotionAttachment, findPerson, findPersonRole, findHearing } from '@/lib/legal/repo'
import { db } from '@/lib/legal/kysely'
import { prisma } from '@/lib/db/prisma'

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

async function opRead(params: URLSearchParams, body: any): Promise<string> {
  const filter = normalizeFilter(
    params.get('filter') ??
      (typeof body?.filter === 'string' ? body.filter : body?.filter?.val) ??
      '',
  )
  if (!filter) {
    return errGrid('read requires a filter parameter')
  }
  const limitRaw = params.get('limit') ?? body?.limit
  const limit = limitRaw != null ? Number(limitRaw) : undefined

  // Direct id lookup — bypass the haystack-core filter compiler since `id`
  // lives in a column, not the `tags` JSON. Tag-panel sends `id=@<id>`.
  const idParam = params.get('id') ?? body?.id
  const idValue = typeof idParam === 'string' ? idParam.replace(/^@/, '') : null

  const table = tableFromFilter(filter)
  if (!table) {
    return errGrid(
      'filter must contain an entity marker (motion, motionEvent, person, personRole, hearing, case)',
    )
  }
  try {
    let rows: any[]
    if (idValue) {
      // Read-by-id: skip the filter compiler entirely.
      rows = await (db as any)
        .selectFrom(table as any)
        .selectAll()
        .where('id' as any, '=', idValue as any)
        .limit(1)
        .execute()
    } else {
      switch (table) {
        case 'Motion': rows = await findMotion(filter, limit); break
        case 'MotionEvent': rows = await findMotionEvent(filter, limit); break
        case 'MotionAttachment': rows = await findMotionAttachment(filter, limit); break
        case 'Person': rows = await findPerson(filter, limit); break
        case 'PersonRole': rows = await findPersonRole(filter, limit); break
        case 'Hearing': rows = await findHearing(filter, limit); break
        case 'Case': rows = await findCase(filter, limit); break
        default: return errGrid(`entity ${table} not implemented in v1`)
      }
    }
    // Inline the tags JSON onto each row so the client can read tag values
    // directly from row.<tag> (the panel binds to record[spec.name]).
    const inlined = rows.map((r: any) => {
      const out: any = { ...r }
      if (typeof r?.tags === 'string') {
        try {
          const parsed = JSON.parse(r.tags)
          if (parsed && typeof parsed === 'object') Object.assign(out, parsed)
        } catch { /* ignore malformed tags */ }
      } else if (r?.tags && typeof r.tags === 'object') {
        Object.assign(out, r.tags)
      }
      // Surface displayName-ish fields
      return out
    })
    return encodeGrid(inlined, { table: table as any })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    // Missing table in v1 schema → clean err grid, not 500.
    if (/no such table|no such column/i.test(msg)) {
      return errGrid(`schema not yet migrated: ${msg}`)
    }
    return errGrid(`read failed: ${msg}`)
  }
}

/**
 * commit — minimal v1 stub. Accepts `{ id, kind, patch }` (panel shape) or a
 * Haystack-style grid row with `id` + tag fields. Merges `patch` (or the row
 * minus `id`/`kind`) into the target record's `tags` JSON via Prisma.
 *
 * XETO validation runs automatically if the Prisma extension is wired
 * (`src/lib/db/prisma.ts`); otherwise this just persists.
 */
async function opCommit(_params: URLSearchParams, body: any): Promise<string> {
  if (!body || typeof body !== 'object') return errGrid('commit requires a JSON body')

  const id: string | null =
    typeof body.id === 'string' ? body.id.replace(/^@/, '') :
    body.id?.val ? String(body.id.val) : null
  if (!id) return errGrid('commit requires an id')

  const kind: string | null =
    typeof body.kind === 'string' ? body.kind :
    typeof body._kind === 'string' ? body._kind : null
  if (!kind) return errGrid('commit requires a kind (case|motion|motionEvent|motionAttachment|hearing|person|personRole)')

  const patch: any = body.patch ?? (() => {
    // Build patch from body, excluding control fields
    const { id: _i, kind: _k, _kind, ...rest } = body
    return rest
  })()
  if (!patch || typeof patch !== 'object') return errGrid('commit requires a patch object')

  // Map EntityKind → Prisma model name (camelCase)
  const modelMap: Record<string, string> = {
    case: 'case',
    motion: 'motion',
    motionEvent: 'motionEvent',
    motionAttachment: 'motionAttachment',
    hearing: 'hearing',
    person: 'person',
    personRole: 'personRole',
  }
  const model = modelMap[kind]
  if (!model) return errGrid(`unknown kind: ${kind}`)

  const client = (prisma as any)[model]
  if (!client?.findUnique || !client?.update) {
    return errGrid(`Prisma model ${model} not available`)
  }

  try {
    const existing = await client.findUnique({ where: { id } })
    if (!existing) return errGrid(`${kind} ${id} not found`)
    let currentTags: any = {}
    if (typeof existing.tags === 'string') {
      try { currentTags = JSON.parse(existing.tags) } catch { currentTags = {} }
    } else if (existing.tags && typeof existing.tags === 'object') {
      currentTags = existing.tags
    }
    // Patch values: strip control/column fields; only tag-shaped keys go in.
    const { id: _i, tags: _t, createdAt: _c, updatedAt: _u, ...tagPatch } = patch
    const merged = { ...currentTags, ...tagPatch }
    // Remove keys explicitly set to null/undefined.
    for (const k of Object.keys(merged)) {
      if (merged[k] == null) delete merged[k]
    }
    const updated = await client.update({
      where: { id },
      data: { tags: JSON.stringify(merged) },
    })
    const row: any = { ...updated, ...merged }
    return encodeGrid([row], { table: kind as any })
  } catch (e: any) {
    return errGrid(`commit failed: ${e?.message ?? e}`)
  }
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
