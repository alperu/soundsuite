import { NextRequest, NextResponse } from 'next/server';
import {
  listSessions,
  pruneStaleSessions,
  type SessionSource,
  type SessionStatusFilter,
} from '@/lib/admin/session-store';
import { requireAdminAuth } from '@/lib/admin/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/sessions?status=active|revoked|all&source=mcp|dashboard
 * Lists MCP/dashboard sessions, most recent activity first.
 */
export async function GET(req: NextRequest) {
  try {
    if (!(await requireAdminAuth(req))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const sp = req.nextUrl.searchParams;
    const statusParam = sp.get('status');
    const sourceParam = sp.get('source');

    const status: SessionStatusFilter =
      statusParam === 'active' || statusParam === 'revoked' ? statusParam : 'all';
    const source: SessionSource | undefined =
      sourceParam === 'mcp' || sourceParam === 'dashboard' ? sourceParam : undefined;

    // Opportunistic cleanup — drop sessions idle for >30 days.
    await pruneStaleSessions().catch(() => 0);

    const sessions = await listSessions({ status, source });
    return NextResponse.json({ sessions });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
