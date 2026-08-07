/**
 * POST /api/admin/structure-backfill  { documentId?: string }
 *
 * Backfills the task-#13 structure columns (block_type, heading_path,
 * speakers, block_orders, block_bbox) onto EXISTING LanceDB chunks with no
 * re-embedding, from PageCache.structuredJson:
 *
 *  - RR pages (producer 'rr'): speakers by exact printed-line interval
 *   overlap against the chunk's stored start_line/end_line. Chunk text is
 *   never read or written — byte-identity by construction.
 *  - Structured pages: re-run the StructuredChunker in memory over the
 *   persisted blocks (deterministic) and align emitted chunks to stored
 *   rows (exact → marker-suffix → tail-200 match). Misaligned chunks are
 *   SKIPPED, never guessed — consumers treat the columns as optional.
 *
 * Template: stampReadinessScore / readiness-backfill (addColumns + update).
 */

import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

const STRUCTURE_COLUMNS = ['block_type', 'heading_path', 'speakers', 'block_orders', 'block_bbox'] as const;

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RowUpdate {
  block_type?: string;
  heading_path?: string;
  speakers?: string;
  block_orders?: string;
  block_bbox?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const onlyDocId: string | undefined = body.documentId;

    const db = await lancedb.connect(LANCEDB_PATH);
    if (!(await db.tableNames()).includes(TABLE_NAME)) {
      return NextResponse.json({ error: 'chunks table missing' }, { status: 400 });
    }
    const table = await db.openTable(TABLE_NAME);

    // Ensure columns exist (idempotent).
    const schema = await table.schema();
    const have = new Set(schema.fields.map((f: { name: string }) => f.name));
    const missing = STRUCTURE_COLUMNS.filter(c => !have.has(c));
    if (missing.length > 0) {
      await table.addColumns(missing.map(name => ({ name, valueSql: "''" })));
    }

    const docs = await prisma.document.findMany({
      where: {
        ...(onlyDocId ? { id: onlyDocId } : {}),
        NOT: { parserVersion: null } as any,
      } as any,
      include: { case: true, filing: true },
    });

    const summary: any[] = [];
    for (const doc of docs) {
      const result = await backfillDocument(table, doc);
      summary.push({ documentId: doc.id, ...result });
    }

    return NextResponse.json({ documents: summary.length, summary });
  } catch (error) {
    console.error('structure-backfill error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

async function backfillDocument(table: any, doc: any) {
  const cacheRows = await (prisma as any).pageCache.findMany({
    where: { documentId: doc.id, structuredJson: { not: null } },
    select: { pageNumber: true, text: true, structuredJson: true },
    orderBy: { pageNumber: 'asc' },
  });
  if (cacheRows.length === 0) return { skipped: 'no structured pages' };

  // Parse pages; split RR turns from chunkable structure.
  const rrTurnsByPage = new Map<number, { speaker: string; lineStart: number; lineEnd: number }[]>();
  const pages: any[] = [];
  for (const row of cacheRows) {
    let parsed: any;
    try { parsed = JSON.parse(row.structuredJson); } catch { continue; }
    const isRR = parsed.producer === 'rr';
    if (isRR) {
      const turns = (parsed.blocks ?? [])
        .filter((b: any) => b.speaker && b.lineStart !== undefined && b.lineEnd !== undefined)
        .map((b: any) => ({ speaker: b.speaker, lineStart: b.lineStart, lineEnd: b.lineEnd }));
      if (turns.length > 0) rrTurnsByPage.set(row.pageNumber, turns);
    }
    pages.push({
      pageNumber: row.pageNumber,
      text: row.text,
      textDensity: row.text?.trim().length ?? 0,
      blocks: parsed.blocks ?? [],
      structureOnly: isRR,
    });
  }

  // Stored chunks for this document.
  const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
  const stored = (await table
    .query()
    .where(`document_id = '${doc.id.replace(/'/g, "''")}'`)
    .select(['id', 'text', 'page_number', 'chunk_index', 'start_line', 'end_line'])
    .limit(50_000)
    .toArray()) as any[];
  if (stored.length === 0) return { skipped: 'no chunks in store' };

  const updates = new Map<string, RowUpdate>();

  // 1. RR speakers — exact interval overlap, no text involved.
  let speakersStamped = 0;
  for (const row of stored) {
    const turns = rrTurnsByPage.get(num(row.page_number));
    if (!turns) continue;
    const s = num(row.start_line);
    const e = num(row.end_line);
    if (s <= 0 || e <= 0) continue;
    const speakers = [...new Set(turns.filter(t => t.lineStart <= e && t.lineEnd >= s).map(t => t.speaker))];
    if (speakers.length > 0) {
      updates.set(row.id, { ...(updates.get(row.id) ?? {}), speakers: `|${speakers.join('|')}|` });
      speakersStamped++;
    }
  }

  // 2. Structured pages — deterministic chunker re-run + text alignment.
  let aligned = 0;
  let misaligned = 0;
  const chunkable = pages.filter(p => !p.structureOnly && p.blocks.length > 0);
  if (chunkable.length > 0) {
    const { StructuredChunker } = await import('@/lib/ingestion/structured-chunker');
    const { LangChainTextChunker } = await import('@/lib/ingestion/langchain-text-chunker');
    const chunker = new StructuredChunker(new LangChainTextChunker());
    try {
      const sacContext = {
        caseName: doc.case?.name,
        filingType: doc.filing?.filingType || doc.documentType || undefined,
        documentSummary: doc.documentSummary || undefined,
      };
      const generated = await chunker.chunkPages(chunkable, doc.id, doc.caseId, sacContext);
      const byPage = new Map<number, typeof generated>();
      for (const g of generated) {
        const list = byPage.get(g.metadata.pageNumber) ?? [];
        list.push(g);
        byPage.set(g.metadata.pageNumber, list);
      }
      for (const row of stored) {
        const cands = byPage.get(num(row.page_number));
        if (!cands || typeof row.text !== 'string') continue;
        // exact → annotation-marker suffix → unique tail-200
        let match = cands.find(g => g.text === row.text)
          ?? cands.find(g => row.text.endsWith(g.text));
        if (!match) {
          const tail = row.text.slice(-200);
          const tails = cands.filter(g => g.text.slice(-200) === tail);
          if (tails.length === 1) match = tails[0];
        }
        if (!match) { misaligned++; continue; }
        const m = match.metadata;
        if (!m.blockType && !m.headingPath) continue;
        updates.set(row.id, {
          ...(updates.get(row.id) ?? {}),
          ...(m.blockType ? { block_type: m.blockType } : {}),
          ...(m.headingPath ? { heading_path: m.headingPath } : {}),
          ...(m.blockOrders?.length ? { block_orders: JSON.stringify(m.blockOrders) } : {}),
          ...(m.blockBbox ? { block_bbox: JSON.stringify(m.blockBbox) } : {}),
        });
        aligned++;
      }
    } finally {
      chunker.dispose();
    }
  }

  // 3. Apply.
  let updated = 0;
  for (const [id, values] of updates) {
    if (Object.keys(values).length === 0) continue;
    await table.update({ where: `id = '${id.replace(/'/g, "''")}'`, values });
    updated++;
  }

  return { chunks: stored.length, speakersStamped, aligned, misaligned, updated };
}
