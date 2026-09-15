import { NextResponse } from 'next/server';
import { handleRelease } from '@/lib/handlers';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    // leaseId is optional: a master that echoes the id it got from
    // /acquire gets exact accounting; one that sends only a role closes that
    // role's oldest open lease.
    const result = await handleRelease(body.role, typeof body.leaseId === 'string' ? body.leaseId : undefined);
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
