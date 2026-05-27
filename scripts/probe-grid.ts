/**
 * probe-grid.ts — server-side probe for the right-panel ChunkPreviewGrid.
 *
 * Mirrors what the unified search endpoint does, but in isolation so we can
 * see exactly what comes back without a live dev server. Useful when the
 * `/api/search/unified` HTTP path hangs or returns zero rows and you need to
 * confirm whether the chunks-matching-this-filter set is actually empty.
 *
 * Run:
 *   npx tsx scripts/probe-grid.ts                                 # default filter
 *   npx tsx scripts/probe-grid.ts "case==@uuid and filing==..."   # custom filter
 *
 * Outputs:
 *   - The parsed AST
 *   - The whereClauses SQL the parser emitted
 *   - The prismaRequests (multi-hop traversals)
 *   - Direct LanceDB query result count (if the chunks table exists)
 *   - First few rows preview
 */

import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (globalThis as any).TextEncoder === 'undefined') (globalThis as any).TextEncoder = NodeTextEncoder;
if (typeof (globalThis as any).TextDecoder === 'undefined') (globalThis as any).TextDecoder = NodeTextDecoder;

import path from 'path';
import { parseBooleanQuery } from '../src/lib/search/boolean-query';
import { extractFieldFilters } from '../src/lib/search/boolean-to-fts';

const DEFAULT_FILTER =
  '(case==@04a8cd94-359c-4feb-be16-979592c3c235 or case==@92b9ad81-040a-4830-8686-7cccaad903a4 or case==@1535c622-8955-4669-8f29-884a4f2b31ea or case==@c608b81a-8479-4890-8670-0d0352c257d8) and (filingRef==@41b364c2-9f34-45b9-a37d-2c709d2b2060 or filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016 or filingRef==@33c9a4f9-41f7-4e24-babb-645c6f249e77)';

async function main(): Promise<void> {
  const filter = process.argv[2] ?? DEFAULT_FILTER;
  console.log('FILTER:', filter.length > 120 ? filter.slice(0, 120) + '…' : filter);
  console.log();

  // Stage 1 — parse + extract
  const parsed = parseBooleanQuery(filter);
  if (!parsed.ok) {
    console.error('parse error:', parsed.error);
    process.exit(1);
  }
  console.log('hasOperators:', parsed.hasOperators);
  const compiled = extractFieldFilters(parsed.ast);
  console.log('whereClauses:');
  for (const w of compiled.whereClauses) console.log('  ·', w);
  console.log('prismaRequests:', compiled.prismaRequests.length);
  for (const r of compiled.prismaRequests) {
    console.log('  ·', r.path.join('->'), r.cmp, r.value);
  }
  console.log('residual FTS:', compiled.ast ? JSON.stringify(compiled.ast).slice(0, 200) : '(none)');
  console.log();

  // Stage 2 — count matching chunks directly from LanceDB.
  if (compiled.whereClauses.length === 0) {
    console.log('No SQL pre-filter clauses — would scan all chunks. Skipping LanceDB probe.');
    return;
  }

  let lancedb: any;
  try {
    lancedb = await import('@lancedb/lancedb');
  } catch (e) {
    console.error('Could not load @lancedb/lancedb:', (e as Error).message);
    return;
  }

  const dbPath = path.resolve(process.cwd(), 'data/lancedb');
  console.log('LanceDB path:', dbPath);
  const db = await lancedb.connect(dbPath);
  const tableNames: string[] = await db.tableNames();
  console.log('tables:', tableNames);

  // Find the chunks table — usually named `document_chunks` or `chunks`.
  const chunksName = tableNames.find((n) => /chunk/i.test(n));
  if (!chunksName) {
    console.error('No chunks table found.');
    return;
  }
  console.log('using table:', chunksName);
  const tbl = await db.openTable(chunksName);

  const where = compiled.whereClauses.join(' AND ');
  console.log('SQL where:', where);
  console.log();

  try {
    const rows = await tbl.query().where(where).limit(5).toArray();
    console.log('matched rows (first 5):');
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      console.log({
        document_id: r.document_id ?? r.documentId,
        case_id: r.case_id ?? r.caseId,
        filing_id: r.filing_id ?? r.filingId,
        page_number: r.page_number ?? r.pageNumber,
        chunk_index: r.chunk_index ?? r.chunkIndex,
        text: typeof r.text === 'string' ? r.text.slice(0, 120) : undefined,
      });
    }
    // Count total
    const allRows = await tbl.query().where(where).limit(10_000).toArray();
    console.log();
    console.log('TOTAL MATCHING CHUNKS:', allRows.length);
  } catch (e) {
    console.error('LanceDB query failed:', (e as Error).message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
