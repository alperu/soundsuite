import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * GET /api/scope/filing-documents?filingId=&offset=&limit=
 *
 * The documents a filing claims. The mirror of `/api/scope/unfiled`: that one
 * lists what no filing has taken, this one lists what a given filing holds, so
 * a document can be sent back. Without it a filed document appears nowhere in
 * the editor — a filing block shows a count, not its contents.
 *
 * Read-only.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const filingId = params.get('filingId')?.trim();
    if (!filingId) {
      return NextResponse.json({ error: { message: 'filingId is required' } }, { status: 400 });
    }
    const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
    );

    const where = { filingId };
    const [total, rows] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.findMany({
        where,
        select: { id: true, caseId: true, fileName: true, status: true },
        orderBy: { fileName: 'asc' },
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
    console.error('[scope/filing-documents] failed', err);
    return NextResponse.json(
      {
        error: {
          message: err instanceof Error ? err.message : 'Failed to list filing documents',
        },
      },
      { status: 500 },
    );
  }
}
