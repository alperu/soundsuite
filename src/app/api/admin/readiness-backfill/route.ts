/**
 * Readiness backfill — score already-INDEXED documents that predate the
 * readiness feature (or rescore with force=true).
 *
 * Live ingestion scores from PageCache before it is cleared; for indexed
 * documents that data is gone. This endpoint reconstructs per-page signals
 * from what survives:
 *   - PageCache rows, when they exist (e.g. after reindex-pages) — the
 *     accurate path with OCR provenance.
 *   - Otherwise the LanceDB chunk text grouped by page_number — an
 *     estimate flagged with a BACKFILL_ESTIMATE warning (no OCR
 *     provenance, density measured on indexed text rather than raw
 *     extraction).
 *
 * GET  — count + preview of candidate documents.
 * POST — run the backfill. Body: { caseId?, documentIds?, force?, limit? }.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';
import { getConfig } from '@/lib/db/config';
import { createLogger } from '@/lib/logger';
import { collectSignals } from '@/lib/ingestion/readiness/collect';
import { computeReadiness } from '@/lib/ingestion/readiness/score';
import type { VerificationResult } from '@/lib/ingestion/indexing-verifier';

const logger = createLogger('ReadinessBackfill');

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = process.env.LANCEDB_TABLE || 'chunks';
const DEFAULT_LIMIT = 200;

interface CandidateWhere {
  status: string;
  readinessScore?: null;
  caseId?: string;
  id?: { in: string[] };
}

function candidateWhere(opts: { caseId?: string; documentIds?: string[]; force?: boolean }): CandidateWhere {
  const where: CandidateWhere = { status: 'INDEXED' };
  if (!opts.force) where.readinessScore = null;
  if (opts.caseId) where.caseId = opts.caseId;
  if (opts.documentIds?.length) where.id = { in: opts.documentIds };
  return where;
}

export async function GET(req: NextRequest) {
  try {
    const caseId = req.nextUrl.searchParams.get('caseId') || undefined;
    const force = req.nextUrl.searchParams.get('force') === 'true';
    const where = candidateWhere({ caseId, force });
    const candidates = await prisma.document.count({ where });
    const preview = await prisma.document.findMany({
      where,
      select: { id: true, fileName: true, pageCount: true },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ candidates, preview });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      caseId?: string;
      documentIds?: string[];
      force?: boolean;
      limit?: number;
    };
    const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), 1000);
    const config = await getConfig();
    const ocrThreshold = config.ocrThreshold ?? 50;

    const docs = await prisma.document.findMany({
      where: candidateWhere(body),
      select: { id: true, fileName: true, pageCount: true },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    if (docs.length === 0) {
      return NextResponse.json({ scored: 0, skipped: 0, results: [] });
    }

    // One LanceDB connection for the whole run.
    let table: Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>['openTable']>> | null = null;
    let hasScoreColumn = false;
    try {
      const db = await lancedb.connect(LANCEDB_PATH);
      if ((await db.tableNames()).includes(TABLE_NAME)) {
        table = await db.openTable(TABLE_NAME);
        const schema = await table.schema();
        hasScoreColumn = schema.fields.some((f: { name: string }) => f.name === 'readiness_score');
        if (!hasScoreColumn) {
          try {
            await table.addColumns([{ name: 'readiness_score', valueSql: '-1' }]);
            hasScoreColumn = true;
            logger.info('Added readiness_score column to LanceDB chunks table');
          } catch (err) {
            logger.warn('Could not add readiness_score column — chunk stamping skipped', {
              error: (err as Error).message,
            });
          }
        }
      }
    } catch (err) {
      logger.warn('LanceDB unavailable for backfill — PageCache-only scoring', {
        error: (err as Error).message,
      });
    }

    const results: Array<{ id: string; fileName: string; score: number; band: string; estimated: boolean }> = [];
    const skipped: Array<{ id: string; fileName: string; reason: string }> = [];

    for (const doc of docs) {
      try {
        // Per-page chunk data from LanceDB.
        const pageText = new Map<number, string>();
        let chunkCount = 0;
        if (table) {
          const escapedDocId = doc.id.replace(/'/g, "''");
          const rows = await table
            .query()
            .select(['page_number', 'text'])
            .where(`document_id = '${escapedDocId}'`)
            .toArray();
          chunkCount = rows.length;
          for (const row of rows) {
            const p = row.page_number as number;
            if (!Number.isFinite(p) || p < 1) continue;
            pageText.set(p, (pageText.get(p) ?? '') + ((row.text as string) || '') + '\n');
          }
        }

        // PageCache rows (survive only for docs touched by reindex-pages etc.).
        const cacheRows: Array<{ pageNumber: number; text: string; textDensity: number; source: string; confidence: number | null }> =
          await (prisma as any).pageCache.findMany({
            where: { documentId: doc.id },
            select: { pageNumber: true, text: true, textDensity: true, source: true, confidence: true },
          });

        const pageCount = doc.pageCount || Math.max(0, ...pageText.keys(), ...cacheRows.map((r) => r.pageNumber));
        if (pageCount === 0) {
          skipped.push({ id: doc.id, fileName: doc.fileName, reason: 'no pageCount and no chunks' });
          continue;
        }

        // Prefer PageCache when it covers a meaningful share of pages;
        // it carries OCR provenance and raw extraction density.
        const usePageCache = cacheRows.length >= Math.max(1, Math.floor(pageCount / 2));
        const pages: VerificationResult['pages'] = usePageCache
          ? cacheRows.map((r) => ({
              pageNumber: r.pageNumber,
              text: r.text,
              textDensity: r.textDensity,
              source: r.source === 'ocr' ? 'ocr' : 'extract',
              confidence: r.confidence,
            }))
          : Array.from(pageText.entries()).map(([pageNumber, text]) => ({
              pageNumber,
              text,
              textDensity: text.trim().length,
              source: 'extract' as const,
              confidence: null,
            }));

        const withText = new Set(pages.filter((p) => p.text.trim().length > 0).map((p) => p.pageNumber));
        const gapPages: number[] = [];
        for (let p = 1; p <= pageCount; p++) if (!withText.has(p)) gapPages.push(p);

        const verification: VerificationResult = {
          totalPages: pageCount,
          pagesWithText: withText.size,
          pagesWithoutText: gapPages.length,
          ocrPages: pages.filter((p) => p.source === 'ocr').length,
          gapPages,
          totalChunksIndexed: chunkCount,
          warnings: [],
          pages,
        };

        const signals = collectSignals({ verification, chunkCount, renderFailedCount: 0, ocrThreshold });
        const readiness = computeReadiness(signals);
        const estimated = !usePageCache;
        if (estimated) {
          readiness.warnings.unshift({
            code: 'BACKFILL_ESTIMATE',
            severity: 'info',
            detail:
              'Scored by backfill from indexed chunks — OCR provenance unavailable; reprocess the document for an exact score.',
          });
        }

        await prisma.document.update({
          where: { id: doc.id },
          data: {
            readinessScore: readiness.score,
            readinessBand: readiness.band,
            readinessWarnings: JSON.stringify(readiness.warnings),
            readinessScoredAt: new Date(),
          },
        });

        // Stamp the score onto the chunk rows too (shown on /vectors).
        if (table && hasScoreColumn) {
          try {
            const escapedDocId = doc.id.replace(/'/g, "''");
            await table.update({
              where: `document_id = '${escapedDocId}'`,
              values: { readiness_score: readiness.score },
            });
          } catch (err) {
            logger.warn('Chunk readiness stamp failed', { documentId: doc.id, error: (err as Error).message });
          }
        }
        results.push({ id: doc.id, fileName: doc.fileName, score: readiness.score, band: readiness.band, estimated });
      } catch (err) {
        skipped.push({ id: doc.id, fileName: doc.fileName, reason: (err as Error).message });
      }
    }

    const bands = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.band] = (acc[r.band] ?? 0) + 1;
      return acc;
    }, {});
    logger.info('Readiness backfill complete', { scored: results.length, skipped: skipped.length, bands });

    return NextResponse.json({ scored: results.length, skippedCount: skipped.length, bands, results, skipped });
  } catch (err) {
    logger.error('Readiness backfill failed', { error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
