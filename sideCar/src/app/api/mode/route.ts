import { NextResponse } from 'next/server';
import { switchMode } from '@/lib/containers';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.mode) {
      return NextResponse.json(
        { error: 'mode is required' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }
    const result = await switchMode(body.mode);
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
