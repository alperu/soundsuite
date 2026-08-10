/**
 * GET /api/documents/[id]/chunks?page=N → stored chunks for one page
 *
 * Powers the Meta View chunk overlay (task #4): what the vector store
 * actually holds (SAC prefix, chunk boundaries, line stamps) side by side
 * with the parsed page structure. Reads LanceDB directly, ordered by
 * chunkIndex.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pageParam = request.nextUrl.searchParams.get('page');
    const pageNumber = pageParam ? parseInt(pageParam, 10) : NaN;
    if (!Number.isFinite(pageNumber)) {
      return NextResponse.json({ error: 'page query param required' }, { status: 400 });
    }

    const db = await lancedb.connect(LANCEDB_PATH);
    if (!(await db.tableNames()).includes(TABLE_NAME)) {
      return NextResponse.json({ chunks: [] });
    }
    const table = await db.openTable(TABLE_NAME);
    const rows = await table
      .query()
      .where(`document_id = '${id.replace(/'/g, "''")}' AND page_number = ${pageNumber}`)
      .select(['id', 'text', 'chunk_index', 'page_number', 'start_line', 'end_line', 'is_exhibit', 'readiness_score', 'block_type', 'heading_path', 'speakers', 'table_markdown'])
      .limit(500)
      .toArray();

    const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
    const chunks = rows
      .map((r: any) => ({
        id: r.id,
        text: r.text,
        chunkIndex: num(r.chunk_index) ?? 0,
        pageNumber: num(r.page_number),
        startLine: (num(r.start_line) ?? 0) > 0 ? num(r.start_line) : null,
        endLine: (num(r.end_line) ?? 0) > 0 ? num(r.end_line) : null,
        isExhibit: !!r.is_exhibit,
        readinessScore: num(r.readiness_score),
        // Structural provenance (docparse §6.3) — operator views must show
        // what search sees. Empty string = column default = absent.
        blockType: r.block_type || null,
        headingPath: r.heading_path || null,
        speakers: r.speakers || null,
        tableMarkdown: r.table_markdown || null,
      }))
      .sort((a: any, b: any) => a.chunkIndex - b.chunkIndex);

    return NextResponse.json({ chunks });
  } catch (error) {
    console.error('Chunks API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
