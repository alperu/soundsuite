/**
 * POST /api/redis/warm — Warm the Redis cache.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json({ message: 'Cache warm not yet implemented' }, { status: 501 });
}
