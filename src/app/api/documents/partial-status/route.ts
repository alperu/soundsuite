import { NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';
import { computeDocumentCoverage } from '@/lib/ingestion/partial-detection';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';

/**
 * GET /api/documents/partial-status
 * Returns IDs of documents whose indexed page coverage falls short of
 * pageCount, ignoring pages that are blank by design.
 *
 * This route used to carry its own copy of the distinct-pages-vs-pageCount
 * comparison. `partial-detection.ts` was extracted precisely because that
 * comparison existed twice with the same gap (see that module's header), but
 * only `src/app/page.tsx` was migrated — this copy was left behind and kept
 * both defects:
 *
 *  1. No blank-by-design allowance, so a document with legitimately blank
 *     pages reported partial forever. There is no text on a blank page to
 *     embed, so no amount of re-indexing could ever clear it.
 *
 *  2. `status: 'INDEXED'` only. A document mid-repair is FIXING_PARTIAL, so
 *     it dropped out of this list entirely — the moment a repair stalled or
 *     failed, the document became invisible to the very list that would flag
 *     it, and a stuck repair looked like a fixed document. `page.tsx` already
 *     scopes to `['INDEXED', 'FIXING_PARTIAL']` and explains why; this route
 *     disagreed with the dashboard it was supposed to mirror.
 *
 * Both are fixed by delegating. Keep it delegating.
 */
export async function GET() {
  try {
    const docs = await prisma.document.findMany({
      // Same scope as the dashboard (src/app/page.tsx): a repair in flight
      // does not make the coverage gap go away.
      where: {
        status: { in: ['INDEXED', 'FIXING_PARTIAL'] },
        pageCount: { gt: 0 },
      },
      select: { id: true, pageCount: true },
    });

    if (docs.length === 0) {
      return NextResponse.json({ partialDocumentIds: [], nothingToRepairDocumentIds: [] });
    }

    const { partial, nothingToRepair } = await computeDocumentCoverage(
      docs.map((d) => ({ id: d.id, pageCount: d.pageCount! })),
      {
        prisma: prisma as unknown as Parameters<typeof computeDocumentCoverage>[1]['prisma'],
        lancedb: lancedb as unknown as Parameters<typeof computeDocumentCoverage>[1]['lancedb'],
        lancedbPath: LANCEDB_PATH,
        tableName: process.env.LANCEDB_TABLE || 'chunks',
      },
    );

    return NextResponse.json({
      partialDocumentIds: [...partial],
      /**
       * Accounted for, but not every page is in the index: blank by design or
       * image-only. Reported separately so the dashboard can say "Indexed
       * (Nothing to repair)" instead of either implying a closable gap or
       * claiming plain INDEXED when some pages hold no text.
       */
      nothingToRepairDocumentIds: [...nothingToRepair],
    });
  } catch (error) {
    console.error('Partial status error:', error);
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error' } },
      { status: 500 }
    );
  }
}
