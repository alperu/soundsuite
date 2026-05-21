/**
 * Same-origin proxy for the Haystack HTTP API.
 *
 * Why this exists: the browser tag-panel needs to read/write Haystack records
 * but should not ship an API key to every visitor. The Next.js server is on the
 * same origin as the panel, so any same-origin request is implicitly trusted
 * — we dispatch to the same handler logic as `/api/haystack/[op]` but skip the
 * bearer-auth check.
 *
 * External Haystack clients (SkySpark, Haxall, curl from another host) must
 * keep hitting `/api/haystack/[op]` with `Authorization: BEARER authToken=…`.
 * This proxy is intentionally limited to same-origin XHR/fetch.
 *
 * Same-origin guard: Next.js doesn't enforce CORS for our own routes, but we
 * defend in depth by rejecting cross-origin requests when an Origin header is
 * present. Server-to-server calls (no Origin) are allowed; the host running
 * the box already controls the server process.
 */
import { NextRequest, NextResponse } from 'next/server'
import { dispatchHaystack } from '../../haystack/[op]/route'

export const dynamic = 'force-dynamic'

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  // No Origin header — server-side call or curl from the host. Allow.
  if (!origin) return true
  try {
    const reqUrl = new URL(req.url)
    const oUrl = new URL(origin)
    return oUrl.host === reqUrl.host
  } catch {
    return false
  }
}

async function handle(req: NextRequest, op: string): Promise<NextResponse> {
  if (!isSameOrigin(req)) {
    const origin = req.headers.get('origin') ?? '-'
    console.log(`[haystack-proxy/${op}] rejected cross-origin origin=${origin}`)
    return new NextResponse('Forbidden: haystack-proxy is same-origin only', { status: 403 })
  }
  return dispatchHaystack(req, op, { skipAuth: true })
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return handle(req, params.op)
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return handle(req, params.op)
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ op: string }> | { op: string } }) {
  const params = await (ctx.params as any)
  return handle(req, params.op)
}
