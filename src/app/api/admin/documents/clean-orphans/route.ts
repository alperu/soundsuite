/**
 * Admin: clean orphan Document rows.
 *
 * GET  /api/admin/documents/clean-orphans            — dry-run, returns count + sample
 * POST /api/admin/documents/clean-orphans?apply=true — delete the matching rows
 *
 * "Orphan" here means a Document with filingId IS NULL AND errorMessage IS NOT NULL
 * (i.e. the indexer tried to process it, but it's not tied to a Filing — typical
 * after a Case.path edit left stale Document.filePath entries behind).
 *
 * No UI surface — operator-only. Call via curl.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

const ORPHAN_WHERE = {
  filingId: null,
  errorMessage: { not: null },
} as const;

export async function GET() {
  try {
    const [count, sample] = await Promise.all([
      prisma.document.count({ where: ORPHAN_WHERE }),
      prisma.document.findMany({
        where: ORPHAN_WHERE,
        select: {
          id: true,
          fileName: true,
          filePath: true,
          status: true,
          errorMessage: true,
        },
        take: 25,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    return NextResponse.json({
      mode: 'dry-run',
      count,
      sample,
      hint: 'POST with ?apply=true to delete.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to scan orphans' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const apply = request.nextUrl.searchParams.get('apply') === 'true';
    const count = await prisma.document.count({ where: ORPHAN_WHERE });

    if (!apply) {
      return NextResponse.json({
        mode: 'dry-run',
        wouldDelete: count,
        hint: 'Re-call with ?apply=true to actually delete.',
      });
    }

    const result = await prisma.document.deleteMany({ where: ORPHAN_WHERE });
    return NextResponse.json({
      mode: 'applied',
      deleted: result.count,
      remaining: await prisma.document.count({ where: ORPHAN_WHERE }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clean orphans' },
      { status: 500 }
    );
  }
}
