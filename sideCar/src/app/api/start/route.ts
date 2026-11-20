import { NextResponse } from 'next/server';
import { authorityAssigned } from '@/lib/ws-client';
import { handleStart } from '@/lib/handlers';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    // GPU authority: only roles sidecarmaster assigned to this host may run.
    if (body.role && !authorityAssigned(body.role)) {
      return NextResponse.json(
        { error: `Role "${body.role}" is not assigned to this host in sidecarmaster /roleassign` },
        { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }
    const result = await handleStart(body.role);
    if (result.error) {
      // Only "Unknown role" / not-found errors map to 404; provisioning
      // failures (image pull, container create, host-Ollama unreachable)
      // are 502 so the operator/UI can distinguish a config mistake from
      // an infrastructure failure. Default to 502 for unrecognised errors
      // so we don't keep flying false 404s.
      const msg = String(result.error);
      const isNotFound = /^unknown role:/i.test(msg) || /not found/i.test(msg);
      return NextResponse.json(result, {
        status: isNotFound ? 404 : 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    return NextResponse.json(result, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
