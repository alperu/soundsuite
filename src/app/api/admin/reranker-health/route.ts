import { NextRequest, NextResponse } from 'next/server';
import { getRerankerHealthSnapshot } from '@/lib/search/reranker-watchdog';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

/**
 * GET /api/admin/reranker-health
 * Read-only snapshot of the deep-health watchdog. See reranker-watchdog.ts.
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'reranker-health');
  if (denied) return denied;

  try {
    return NextResponse.json({ hosts: getRerankerHealthSnapshot() });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
