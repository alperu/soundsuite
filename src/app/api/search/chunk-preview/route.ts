/**
 * Chunk-preview endpoint — fast SQL-only filter against the LanceDB chunks
 * table. Used by the right-panel ChunkPreviewGrid.
 *
 * Unlike /api/search/unified (which embeds the query, runs vector + rerank,
 * etc.), this route only:
 *   1. Parses the boolean filter into AST
 *   2. Extracts SQL where-clauses + prisma-traverse requests
 *   3. Resolves traversals to caseId sets and merges them as `case_id IN (...)`
 *   4. Runs a `.where(...).limit(...)` query on the chunks table
 *
 * Result: rows back in ~50-200ms instead of hanging on embedding/rerank.
 *
 * POST body: { filter: string, limit?: number }
 * Response:  { rows: ChunkRow[], total: number, where?: string, error?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { parseBooleanQuery } from '@/lib/search/boolean-query';
import { extractFieldFilters, resolvePrismaFilters } from '@/lib/search/boolean-to-fts';
import { prisma } from '@/lib/db/prisma';

interface Body {
  filter: string;
  limit?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ rows: [], total: 0, error: 'invalid JSON body' }, { status: 400 });
  }
  const filter = (body.filter ?? '').trim();
  const limit = Math.min(Math.max(body.limit ?? 30, 1), 200);
  if (!filter) {
    return NextResponse.json({ rows: [], total: 0 });
  }

  // Parse
  const parsed = parseBooleanQuery(filter);
  if (!parsed.ok) {
    return NextResponse.json({ rows: [], total: 0, error: `parse: ${parsed.error}` }, { status: 400 });
  }

  // Extract field filters
  const { whereClauses, prismaRequests } = extractFieldFilters(parsed.ast);

  // Resolve any prisma-traverse requests (e.g. judge->displayName==Roberts)
  let extraWhere: string[] = [];
  if (prismaRequests.length > 0) {
    try {
      const resolved = await resolvePrismaFilters(prismaRequests, prisma as any);
      extraWhere = resolved.whereClauses;
    } catch (e) {
      // Non-fatal — log via response.
       
      console.warn('[chunk-preview] prisma resolve failed', e);
    }
  }

  const allWhere = [...whereClauses, ...extraWhere];
  if (allWhere.length === 0) {
    return NextResponse.json({
      rows: [],
      total: 0,
      error: 'No SQL where-clauses extracted from filter — the chunk preview needs at least one structured field constraint.',
    });
  }

  const where = allWhere.join(' AND ');

  // Open LanceDB and run the query
  let lancedb: typeof import('@lancedb/lancedb');
  try {
    lancedb = await import('@lancedb/lancedb');
  } catch (e) {
    return NextResponse.json(
      { rows: [], total: 0, error: `lancedb import failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
  const dbPath = path.resolve(process.cwd(), 'data/lancedb');
  try {
    const db = await lancedb.connect(dbPath);
    const tbl = await db.openTable('chunks');
    const rowsRaw: unknown[] = await tbl.query().where(where).limit(limit).toArray();
    // Total: a second query without limit, capped at 10k for safety.
    const allRows = await tbl.query().where(where).limit(10_000).toArray();
    const total = allRows.length;

    // Strip the embedding vector (huge) and select interesting columns.
    const rows = (rowsRaw as Array<Record<string, unknown>>).map((r) => {
      const out: Record<string, unknown> = {
        document_id: r.document_id,
        case_id: r.case_id,
        filing_id: r.filing_id,
        page_number: r.page_number,
        chunk_index: r.chunk_index,
        case_number: r.case_number,
        document_type: r.document_type,
        filing_type: r.filing_type,
        text: typeof r.text === 'string' ? r.text.slice(0, 400) : undefined,
        // Structural provenance (docparse §6.3) — the operator preview must
        // show what search sees. Empty string = column default = absent.
        block_type: r.block_type || null,
        heading_path: r.heading_path || null,
        speakers: r.speakers || null,
        table_markdown: typeof r.table_markdown === 'string' && r.table_markdown ? r.table_markdown.slice(0, 400) : null,
        readiness_score: (typeof r.readiness_score === 'number' || typeof r.readiness_score === 'bigint') && Number(r.readiness_score) >= 0
          ? Number(r.readiness_score)
          : null,
      };
      return out;
    });
    return NextResponse.json({ rows, total, where });
  } catch (e) {
    return NextResponse.json(
      { rows: [], total: 0, error: `lancedb query failed: ${(e as Error).message}`, where },
      { status: 500 },
    );
  }
}
