/**
 * Action Logs API Route
 *
 * GET  /api/admin/action-logs — list action logs with optional filters
 * POST /api/admin/action-logs — create a new action log entry
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const caseId = sp.get('caseId');
    const logType = sp.get('logType');
    const status = sp.get('status');
    const limit = Math.min(parseInt(sp.get('limit') || '100', 10), 500);
    const offset = parseInt(sp.get('offset') || '0', 10);
    const search = sp.get('search');

    const where: Record<string, unknown> = {};
    if (caseId) where.caseId = caseId;
    if (logType) where.logType = logType;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { action: { contains: search } },
        { target: { contains: search } },
        { detail: { contains: search } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.actionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.actionLog.count({ where }),
    ]);

    return NextResponse.json({ logs, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch action logs' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/action-logs
 *
 * Filters (all optional, AND-ed):
 *   caseId       — restrict to this case
 *   logType      — restrict to one log type (e.g. 'tag-fill')
 *   filingId     — match rows whose `detail` JSON contains
 *                  `"filingId":"<id>"` substring OR whose `target` equals
 *                  `<filingTitle>` / starts with `<filingTitle> · ` (the same
 *                  filter the filing-detail page applies on read).
 *   filingTitle  — used together with `filingId` for the title-based match.
 *
 * Refuses to wipe the entire table — at least one of caseId or filingId must
 * be present. Returns `{ deleted: number }`.
 */
export async function DELETE(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const caseId = sp.get('caseId');
    const logType = sp.get('logType');
    const filingId = sp.get('filingId');
    const filingTitle = sp.get('filingTitle');

    if (!caseId && !filingId) {
      return NextResponse.json(
        { error: 'At least one of caseId or filingId is required (refusing to wipe the table)' },
        { status: 400 },
      );
    }

    const where: Record<string, unknown> = {};
    if (caseId) where.caseId = caseId;
    if (logType) where.logType = logType;

    if (filingId) {
      // Mirror the panel's filter: detail substring OR target prefix.
      const orClauses: Array<Record<string, unknown>> = [
        { detail: { contains: `"filingId":"${filingId}"` } },
      ];
      if (filingTitle) {
        orClauses.push({ target: filingTitle });
        orClauses.push({ target: { startsWith: `${filingTitle} · ` } });
      }
      where.OR = orClauses;
    }

    const result = await (prisma as any).actionLog.deleteMany({ where });
    return NextResponse.json({ deleted: result.count });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete action logs' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { caseId, action, target, status, detail, logType } = body;

    if (!action || !target) {
      return NextResponse.json(
        { error: 'action and target are required' },
        { status: 400 }
      );
    }

    const log = await prisma.actionLog.create({
      data: {
        caseId: caseId || null,
        action,
        target,
        status: status || 'success',
        detail: detail || null,
        logType: logType || 'general',
      },
    });

    return NextResponse.json({ log });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create action log' },
      { status: 500 }
    );
  }
}
