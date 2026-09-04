/**
 * scripts/backfill-draft-status.ts
 *
 * Backfill the draft-record guard for documents indexed before the
 * `draft-detection` ingestion stage existed. For every Document:
 *
 *   1. Gather text: PageCache rows when present (first 5 + last 2 pages),
 *      otherwise the LanceDB chunks of those pages (PageCache is normally
 *      wiped after a successful ingest, so chunks are the usual source).
 *   2. Run `detectDraftStatus` (same heuristics as ingestion).
 *   3. With --apply: write `tags.recordStatus` / `recordStatusConfidence` /
 *      `recordStatusSignals` / `recordStatusSource='auto'` on the Document
 *      and stamp `record_status` on every chunk row of that document.
 *
 * Documents whose tags carry `recordStatusSource: 'manual'` are never
 * overwritten. Dry-run by default — prints a per-status tally and the
 * documents that would change.
 *
 * Usage:
 *   npx tsx scripts/backfill-draft-status.ts              # dry run
 *   npx tsx scripts/backfill-draft-status.ts --apply      # write tags + chunk stamps
 *   npx tsx scripts/backfill-draft-status.ts --case=<caseId> [--apply]
 *   npx tsx scripts/backfill-draft-status.ts --only-changed   # print only docs whose status changes
 *
 * Privacy: output shows document ids and record status only; pass --names to
 * include file names (do not paste that output into tracked files).
 */

import { prisma } from '../src/lib/db/prisma';
import { VectorStore } from '../src/lib/vector/vector-store';
import { detectDraftStatus, recordStatusFromTags, type RecordStatus } from '../src/lib/ingestion/draft-detector';

const APPLY = process.argv.includes('--apply');
const SHOW_NAMES = process.argv.includes('--names');
const ONLY_CHANGED = process.argv.includes('--only-changed');
const caseArg = process.argv.find((a) => a.startsWith('--case='));
const CASE_ID = caseArg ? caseArg.slice('--case='.length) : undefined;

const FIRST_PAGES = 5;
const LAST_PAGES = 2;

interface PageText { pageNumber: number; text: string }

async function pagesFromPageCache(documentId: string): Promise<PageText[]> {
  const rows = await prisma.pageCache.findMany({
    where: { documentId },
    select: { pageNumber: true, text: true },
    orderBy: { pageNumber: 'asc' },
  });
  return rows.map((r) => ({ pageNumber: r.pageNumber, text: r.text }));
}

async function pagesFromChunks(vs: VectorStore, documentId: string): Promise<PageText[]> {
  // findByDocument returns up to `limit` chunks; drafts are short, RR volumes
  // are not — 2000 covers a ~500-page document at 4 chunks/page.
  const chunks = await vs.findByDocument(documentId, 2000);
  const byPage = new Map<number, string[]>();
  for (const c of chunks) {
    const p = c.metadata.pageNumber ?? 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p)!.push(c.text);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber, texts]) => ({ pageNumber, text: texts.join('\n') }));
}

function splitHeadTail(pages: PageText[]): { first: string; last: string } {
  const first = pages.slice(0, FIRST_PAGES).map((p) => p.text).join('\n\n');
  const last = pages.length > FIRST_PAGES
    ? pages.slice(-LAST_PAGES).map((p) => p.text).join('\n\n')
    : '';
  return { first, last };
}

async function main() {
  const vs = new VectorStore({
    dbPath: process.env.LANCEDB_PATH || './data/lancedb',
    tableName: 'chunks',
  });
  await vs.initialize();

  const docs = await prisma.document.findMany({
    where: { ...(CASE_ID ? { caseId: CASE_ID } : {}), status: 'INDEXED' },
    select: { id: true, fileName: true, pageCount: true, tags: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${docs.length} indexed document(s)${CASE_ID ? ` in case ${CASE_ID}` : ''}`);

  const tally: Record<RecordStatus, number> = { filed: 0, draft: 0, unknown: 0 };
  let changed = 0;
  let skippedManual = 0;
  let noText = 0;

  for (const doc of docs) {
    const tags = (doc.tags && typeof doc.tags === 'object' ? doc.tags : {}) as Record<string, unknown>;
    const previous = recordStatusFromTags(tags);
    const label = SHOW_NAMES ? `${doc.id} (${doc.fileName})` : doc.id;

    if (tags.recordStatusSource === 'manual') {
      skippedManual++;
      tally[previous]++;
      if (!ONLY_CHANGED) console.log(`  ${label}: ${previous} (manual — kept)`);
      continue;
    }

    let pages = await pagesFromPageCache(doc.id);
    let source = 'pagecache';
    if (pages.length === 0) {
      pages = await pagesFromChunks(vs, doc.id);
      source = 'chunks';
    }
    if (pages.length === 0) {
      noText++;
      tally[previous]++;
      if (!ONLY_CHANGED) console.log(`  ${label}: ${previous} (no text available — skipped)`);
      continue;
    }

    const { first, last } = splitHeadTail(pages);
    const detection = detectDraftStatus({
      fileName: doc.fileName,
      firstPagesText: first,
      lastPagesText: last,
      pageCount: doc.pageCount ?? pages.length,
    });
    tally[detection.recordStatus]++;
    const isChange = detection.recordStatus !== previous;
    if (isChange) changed++;

    if (!ONLY_CHANGED || isChange) {
      console.log(
        `  ${label}: ${previous} → ${detection.recordStatus}` +
        ` (draftConf ${detection.confidence.toFixed(2)}, via ${source}${detection.signals.length ? `; ${detection.signals.join(', ')}` : ''})`,
      );
    }

    if (APPLY) {
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          tags: {
            ...tags,
            recordStatus: detection.recordStatus,
            // Draft-confidence, not confidence in the status: a 'filed'
            // document scores 0 because nothing argued it was a draft.
            recordStatusConfidence: detection.confidence,
            recordStatusSignals: detection.signals,
            recordStatusSource: 'auto',
          } as any,
        },
      });
      await vs.stampRecordStatus(doc.id, detection.recordStatus);
    }
  }

  console.log('\nTally:', tally);
  console.log(`Changed: ${changed}   manual (kept): ${skippedManual}   no text: ${noText}`);
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write Document.tags and stamp chunk rows.');

  await vs.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
