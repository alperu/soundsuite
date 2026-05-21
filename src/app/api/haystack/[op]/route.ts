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

async function opRead(params: URLSearchParams, body: any): Promise<string> {
  const filter =
    params.get('filter') ??
    (typeof body?.filter === 'string' ? body.filter : body?.filter?.val) ??
    ''
  if (!filter) {
    return errGrid('read requires a filter parameter')
  }
  const limitRaw = params.get('limit') ?? body?.limit
  const limit = limitRaw != null ? Number(limitRaw) : undefined

  const table = tableFromFilter(filter)
  if (!table) {
    return errGrid(
      'filter must contain an entity marker (motion, motionEvent, person, personRole, hearing, case)',
    )
  }
  try {
    let rows: any[]
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
    return encodeGrid(rows, { table: table as any })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    // Missing table in v1 schema → clean err grid, not 500.
    if (/no such table|no such column/i.test(msg)) {
      return errGrid(`schema not yet migrated: ${msg}`)
    }
    return errGrid(`read failed: ${msg}`)
  }
}

function opClose(): string {
  // No session state in v1.
  return okGrid()
}

// ---------- dispatch --------------------------------------------------------

async function handle(req: NextRequest, op: string): Promise<NextResponse> {
  const zinc = rejectZinc(req)
  if (zinc) return zinc
  const auth = checkAuth(req)
  if (!auth.ok) return auth.res

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
    }
  } catch (e: any) {
    return jsonResponse(errGrid(`op ${op} failed: ${e?.message ?? e}`))
  }

  // unreachable
  return jsonResponse(errGrid('dispatch fell through'))
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return handle(req, params.op)
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return handle(req, params.op)
}

// silence unused-import warning if toHayson tree-shakes out
void toHayson
