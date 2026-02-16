import { NextResponse } from 'next/server';
import { state } from '@/lib/state';

export async function GET() {
  return NextResponse.json(
    { ok: true, uptime: Math.floor((Date.now() - state.startedAt) / 1000) },
    { headers: { 'Access-Control-Allow-Origin': '*' } },
  );
}
