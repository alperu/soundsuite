import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { prisma } from '@/lib/db/prisma';
import { listFolderStats } from '@/lib/fs-sidecar/folder-store';

/**
 * GET /api/admin/folder-stats?sidecarId=&root=&caseId=&maxDepth=
 * Folder totals sent by file-system sidecars (`folder-status` profile).
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'folder-stats');
  if (denied) return denied;
  try {
    const q = request.nextUrl.searchParams;
    const depth = q.get('maxDepth');
    const stats = await listFolderStats(prisma as never, {
      sidecarId: q.get('sidecarId') || undefined,
      root: q.get('root') || undefined,
      caseId: q.get('caseId') || undefined,
      maxDepth: depth !== null && /^\d+$/.test(depth) ? Number(depth) : undefined,
    });
    return NextResponse.json({ stats });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message?.slice(0, 300) }, { status: 500 });
  }
}
