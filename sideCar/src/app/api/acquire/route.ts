import { NextResponse } from 'next/server';
import { authorityAssigned } from '@/lib/ws-client';
import { handleAcquire } from '@/lib/handlers';

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
    const result = await handleAcquire(body.role, 'http');
    if (result.error) {
      return NextResponse.json(result, {
        status: 404,
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
