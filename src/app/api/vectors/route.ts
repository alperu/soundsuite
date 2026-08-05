import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50')));
    const caseId = searchParams.get('caseId');
    const filingId = searchParams.get('filingId');
    const documentId = searchParams.get('documentId');
    const isExhibit = searchParams.get('isExhibit');
    const textSearch = searchParams.get('textSearch');
    const pageMin = searchParams.get('pageMin');
    const pageMax = searchParams.get('pageMax');
    const sortBy = searchParams.get('sortBy');
    const sortDir = searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc';

    const db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();

    if (!tableNames.includes(TABLE_NAME)) {
      return NextResponse.json({ chunks: [], total: 0, page, limit, totalPages: 0 });
    }

    const table = await db.openTable(TABLE_NAME);

    // Resolve filingId → document IDs (LanceDB doesn't store filingId)
    let filingDocIds: string[] | null = null;
    if (filingId) {
      const docs = await prisma.document.findMany({
        where: { filingId },
        select: { id: true },
      });
      filingDocIds = docs.map(d => d.id);
      if (filingDocIds.length === 0) {
        return NextResponse.json({ chunks: [], total: 0, page, limit, totalPages: 0 });
      }
    }

    // Build WHERE clause
    const conditions: string[] = [];
    if (caseId) conditions.push(`case_id = '${caseId.replace(/'/g, "''")}'`);
    if (documentId) {
      conditions.push(`document_id = '${documentId.replace(/'/g, "''")}'`);
    } else if (filingDocIds) {
      const escaped = filingDocIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      conditions.push(`document_id IN (${escaped})`);
    }
    if (isExhibit === 'true') conditions.push('is_exhibit = true');
    if (isExhibit === 'false') conditions.push('is_exhibit = false');
    if (textSearch) conditions.push(`text LIKE '%${textSearch.replace(/'/g, "''")}%'`);
    if (pageMin) conditions.push(`page_number >= ${parseInt(pageMin)}`);
    if (pageMax) conditions.push(`page_number <= ${parseInt(pageMax)}`);

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : undefined;

    // Get total count
    const total = whereClause
      ? await table.countRows(whereClause)
      : await table.countRows();

    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    // Fetch page of data — exclude vector column. readiness_score only
    // exists on tables that have been scored/backfilled at least once.
    const schema = await table.schema();
    const hasReadiness = schema.fields.some((f: { name: string }) => f.name === 'readiness_score');
    const columns = ['id', 'text', 'document_id', 'case_id', 'page_number', 'chunk_index', 'is_exhibit', 'exhibit_path', 'created_at'];
    if (hasReadiness) columns.push('readiness_score');
    // Server-side sort. LanceDB's JS query API has no orderBy, so sorting is
    // two-phase: (A) project id + sort column for ALL matching rows (cheap —
    // no text/vector), sort in memory, slice the page of ids; (B) fetch full
    // rows for just those ids. Without sortBy, the original natural-order
    // offset slice is kept (no extra cost).
    const SORT_COLUMNS: Record<string, string> = {
      pageNumber: 'page_number',
      chunkIndex: 'chunk_index',
      isExhibit: 'is_exhibit',
      createdAt: 'created_at',
      documentId: 'document_id',
      readinessScore: 'readiness_score',
    };
    const sortCol = sortBy && SORT_COLUMNS[sortBy] && (sortBy !== 'readinessScore' || hasReadiness)
      ? SORT_COLUMNS[sortBy]
      : null;

    let pageRows: any[];
    if (sortCol) {
      let idQuery = table.query().select(['id', sortCol]);
      if (whereClause) idQuery = idQuery.where(whereClause);
      const all = await idQuery.limit(Math.max(total, 1)).toArray();
      const mult = sortDir === 'desc' ? -1 : 1;
      // readiness_score stores "not scored" as -1 — treat as null (sorts last)
      const norm = (v: any) =>
        sortCol === 'readiness_score' && v != null && Number(v) < 0 ? null : v;
      all.sort((a: any, b: any) => {
        const av = norm(a[sortCol]); const bv = norm(b[sortCol]);
        // nulls/unscored always last regardless of direction
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string' || typeof bv === 'string') {
          return mult * String(av).localeCompare(String(bv));
        }
        return mult * (Number(av) - Number(bv));
      });
      const pageIds: string[] = all.slice(offset, offset + limit).map((r: any) => r.id);
      if (pageIds.length === 0) {
        pageRows = [];
      } else {
        const escaped = pageIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        const rows = await table.query().select(columns).where(`id IN (${escaped})`).limit(pageIds.length).toArray();
        const order = new Map(pageIds.map((id, i) => [id, i]));
        pageRows = rows.slice().sort((a: any, b: any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
    } else {
      let query = table.query().select(columns);
      if (whereClause) {
        query = query.where(whereClause);
      }
      const rows = await query.limit(offset + limit).toArray();
      pageRows = rows.slice(offset);
    }

    const chunks = pageRows.map((row: any) => ({
      id: row.id,
      text: row.text,
      documentId: row.document_id,
      caseId: row.case_id,
      pageNumber: row.page_number,
      chunkIndex: row.chunk_index,
      isExhibit: row.is_exhibit,
      exhibitPath: row.exhibit_path || null,
      createdAt: row.created_at,
      // -1 = not yet scored → null for the UI. Number() also handles the
      // BigInt that LanceDB returns for Int64 columns.
      readinessScore: (() => {
        if (!hasReadiness || row.readiness_score == null) return null;
        const score = Number(row.readiness_score);
        return Number.isFinite(score) && score >= 0 ? score : null;
      })(),
    }));

    return NextResponse.json({ chunks, total, page, limit, totalPages });
  } catch (error) {
    console.error('Vector browse error:', error);
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error' } },
      { status: 500 }
    );
  }
}
