/**
 * POST /api/admin/filings/reclassify
 *
 * Re-classify existing Filings using the header-aware hybrid classifier.
 * Originally added to fix filings that the filename-only classifier
 * mislabeled (e.g. a Response opposing a Petition stored as a Petition).
 *
 * Body (all optional):
 *   {
 *     dryRun?: boolean;    // default true — report intended changes only
 *     caseId?: string;     // limit to one case
 *     filingId?: string;   // limit to a single filing
 *     limit?: number;      // cap how many filings to scan (default 100)
 *   }
 *
 * For each Filing the route picks its first Document, re-extracts the
 * header (first 5 pages) via quickExtractHeader, runs classifyFilingHybrid,
 * and proposes a new filingType. With dryRun=true (default) no DB writes
 * happen. With dryRun=false the Filing.filingType is updated in place;
 * the slug is intentionally NOT regenerated to avoid breaking existing
 * URLs / bookmarks (per the task spec).
 *
 * This endpoint is operator-triggered. It is NEVER invoked automatically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  quickExtractHeader,
  classifyFilingHybrid,
} from '@/services/filing-detector';

interface FilingDiff {
  filingId: string;
  caseId: string;
  title: string;
  before: string;
  after: string;
  source: string;
  confidence: number;
  matched?: string;
  documentPath?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  let body: {
    dryRun?: boolean;
    caseId?: string;
    filingId?: string;
    limit?: number;
  } = {};
  try {
    body = await request.json();
  } catch { /* empty body is fine */ }

  const dryRun = body.dryRun !== false; // default TRUE — safe by default
  const limit = Math.max(1, Math.min(body.limit ?? 100, 1000));

  const where: any = {};
  if (body.caseId) where.caseId = body.caseId;
  if (body.filingId) where.id = body.filingId;

  const filings = await (prisma as any).filing.findMany({
    where,
    take: limit,
    include: {
      documents: {
        select: { id: true, filePath: true },
        take: 1,
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const diffs: FilingDiff[] = [];
  const unchanged: string[] = [];
  let scanned = 0;
  let changed = 0;
  let errors = 0;

  for (const filing of filings) {
    scanned++;
    const doc = (filing.documents ?? [])[0];
    if (!doc?.filePath) {
      diffs.push({
        filingId: filing.id,
        caseId: filing.caseId,
        title: filing.title,
        before: filing.filingType,
        after: filing.filingType,
        source: 'skipped',
        confidence: 0,
        error: 'no documents on filing',
      });
      continue;
    }

    let headerText = '';
    try {
      headerText = await quickExtractHeader(doc.filePath);
    } catch (err) {
      errors++;
      diffs.push({
        filingId: filing.id,
        caseId: filing.caseId,
        title: filing.title,
        before: filing.filingType,
        after: filing.filingType,
        source: 'error',
        confidence: 0,
        documentPath: doc.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const hybrid = classifyFilingHybrid({
      fileName: doc.filePath.split('/').pop() ?? doc.filePath,
      headerText,
    });

    if (hybrid.filingType === filing.filingType) {
      unchanged.push(filing.id);
      continue;
    }

    changed++;
    diffs.push({
      filingId: filing.id,
      caseId: filing.caseId,
      title: filing.title,
      before: filing.filingType,
      after: hybrid.filingType,
      source: hybrid.source,
      confidence: hybrid.confidence,
      matched: hybrid.matched,
      documentPath: doc.filePath,
    });

    if (!dryRun) {
      await (prisma as any).filing.update({
        where: { id: filing.id },
        data: { filingType: hybrid.filingType },
      });
    }
  }

  return NextResponse.json({
    dryRun,
    scanned,
    changed,
    unchanged: unchanged.length,
    errors,
    diffs,
  });
}
