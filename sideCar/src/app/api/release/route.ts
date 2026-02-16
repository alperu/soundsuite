import { NextResponse } from 'next/server';
import { handleRelease } from '@/lib/handlers';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await handleRelease(body.role);
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
