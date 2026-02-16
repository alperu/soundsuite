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
