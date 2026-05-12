import { NextResponse } from 'next/server';
import { getRerankerHealthSnapshot } from '@/lib/search/reranker-watchdog';

/**
 * GET /api/admin/reranker-health
 * Read-only snapshot of the deep-health watchdog. See reranker-watchdog.ts.
 */
export async function GET() {
  try {
    return NextResponse.json({ hosts: getRerankerHealthSnapshot() });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
