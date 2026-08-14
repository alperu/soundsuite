import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * GET /api/scope/unfiled?caseId=&q=&offset=&limit=
 *
 * The documents that hang off no filing, itemised and paged. These run to the
 * hundreds per case, which is why they are their own endpoint rather than more
 * payload on `/api/scope/graph` — the filtering canvas never needs them, and
 * the editor's panel only ever shows a page at a time.
 *
 * Read-only.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const caseId = params.get('caseId')?.trim() || undefined;
    const query = params.get('q')?.trim() || undefined;
    const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
    );

    const where = {
      filingId: null,
      ...(caseId ? { caseId } : {}),
      ...(query ? { fileName: { contains: query } } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.findMany({
        where,
        select: { id: true, caseId: true, fileName: true, status: true },
        orderBy: [{ caseId: 'asc' }, { fileName: 'asc' }],
        skip: offset,
        take: limit,
      }),
    ]);

    return NextResponse.json({
      total,
      offset,
      limit,
      rows: rows.map(r => ({
        id: r.id,
        caseId: r.caseId,
        label: r.fileName,
        status: r.status,
      })),
    });
  } catch (err) {
    console.error('[scope/unfiled] failed', err);
    return NextResponse.json(
      {
        error: {
          message: err instanceof Error ? err.message : 'Failed to list unfiled documents',
        },
      },
      { status: 500 },
    );
  }
}
