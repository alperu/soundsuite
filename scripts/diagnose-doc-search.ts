#!/usr/bin/env tsx
/**
 * diagnose-doc-search.ts — figure out why a specific document isn't
 * surfacing in /api/search/* even though SQLite says it's INDEXED.
 *
 * Checks, in order:
 *   1. SQLite Document row — exists? status? caseId? fileName?
 *   2. LanceDB chunk count for the documentId.
 *   3. Sample of the actual indexed text (first chunk + a few mid chunks).
 *   4. Does any chunk literally contain the searched substring (case-
 *      insensitive)? If yes → search ranking issue. If no → text-extraction
 *      missed it or document doesn't actually have that content.
 *   5. Hybrid search restricted to this document — does the engine rank a
 *      chunk of this doc above the cutoff for the user's query?
 *   6. Full-fleet hybrid search — top 10 results across the whole corpus
 *      for the query. Is the missing doc in the top N?
 *
 * Usage:
 *   npx tsx scripts/diagnose-doc-search.ts \
 *     --doc 18f5d01a-50f2-4f38-b4d9-7d85b3aab4fd \
 *     --query "May 13 2026 hearing trust fund"
 *
 *   npx tsx scripts/diagnose-doc-search.ts \
 *     --filename "051826 2nd Supp RR Vol 2" \
 *     --query "May 13 2026"
 *
 * Flags:
 *   --doc <id>           documentId to investigate (UUID)
 *   --filename <text>    or pick by filename substring (case-insensitive)
 *   --query <text>       the user's search query (default below)
 *   --substr <text>      string the user expected to find (defaults to query)
 *   --case <id>          restrict full-fleet search to a caseId (optional)
 *   --chunks <n>         how many sample chunks to dump (default 3)
 *   --top <n>            how many top-N hybrid hits to show (default 15)
 */

import Database from 'better-sqlite3';
import * as path from 'path';

// Args
const argv = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DOC_ID = getArg('doc');
const FILENAME_HINT = getArg('filename');
const QUERY = getArg('query') ?? 'May 13 2026 reporter\'s record';
const SUBSTR = (getArg('substr') ?? QUERY).toLowerCase();
const CASE_ID = getArg('case');
const SAMPLE_CHUNKS = Number(getArg('chunks') ?? 3);
const TOP_N = Number(getArg('top') ?? 15);

if (!DOC_ID && !FILENAME_HINT) {
  console.error('Need --doc <uuid> or --filename <substring>. See script header for usage.');
  process.exit(2);
}

const DB_PATH = path.resolve(__dirname, '..', 'prisma', 'data', 'sound-suite.db');
const LANCEDB_PATH = path.resolve(__dirname, '..', 'data', 'lancedb');

// ──────────────────────────────────────────────────────────────────────────
// 1. SQLite — locate the document
// ──────────────────────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  caseId: string;
  fileName: string;
  filePath: string;
  status: string;
  pageCount: number | null;
  errorMessage: string | null;
  documentType: string | null;
  documentSummary: string | null;
  hash: string;
  updatedAt: string;
}

const sqlite = new Database(DB_PATH, { readonly: true });

let docRow: DocRow | undefined;
if (DOC_ID) {
  docRow = sqlite.prepare<unknown[], DocRow>('SELECT id, caseId, fileName, filePath, status, pageCount, errorMessage, documentType, documentSummary, hash, updatedAt FROM Document WHERE id = ?').get(DOC_ID);
} else if (FILENAME_HINT) {
  // Case-insensitive LIKE
  const rows = sqlite.prepare<[string], DocRow>("SELECT id, caseId, fileName, filePath, status, pageCount, errorMessage, documentType, documentSummary, hash, updatedAt FROM Document WHERE LOWER(fileName) LIKE ? ORDER BY updatedAt DESC LIMIT 5").all(`%${FILENAME_HINT.toLowerCase()}%`);
  if (rows.length === 0) {
    console.error(`No document found matching filename "${FILENAME_HINT}"`);
    process.exit(2);
  }
  if (rows.length > 1) {
    console.log(`Found ${rows.length} matches — picking the most recent. All matches:`);
    for (const r of rows) console.log(`  ${r.id.slice(0, 8)}  ${r.status}  ${r.fileName.slice(0, 80)}`);
    console.log();
  }
  docRow = rows[0];
}

if (!docRow) {
  console.error('Document not found in SQLite.');
  process.exit(2);
}

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  Document Search Diagnostic');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`Query:        "${QUERY}"`);
console.log(`Looking for:  "${SUBSTR}"`);
console.log();
console.log('[1] SQLite Document row');
console.log(`  id:           ${docRow.id}`);
console.log(`  fileName:     ${docRow.fileName}`);
console.log(`  caseId:       ${docRow.caseId}`);
console.log(`  status:       ${docRow.status}${docRow.errorMessage ? ` (errorMessage: ${docRow.errorMessage.slice(0, 120)})` : ''}`);
console.log(`  documentType: ${docRow.documentType ?? '-'}`);
console.log(`  pageCount:    ${docRow.pageCount ?? '-'}`);
console.log(`  updatedAt:    ${docRow.updatedAt}`);
console.log(`  filePath:     ${docRow.filePath}`);
if (docRow.documentSummary) {
  console.log(`  summary:      ${docRow.documentSummary.replace(/\s+/g, ' ').slice(0, 200)}...`);
}
console.log();

if (docRow.status !== 'INDEXED') {
  console.warn(`⚠️  status is "${docRow.status}", not INDEXED. The document may not be searchable.`);
  console.log();
}

// ──────────────────────────────────────────────────────────────────────────
// 2-5. LanceDB chunks
// ──────────────────────────────────────────────────────────────────────────

(async function lancedbChecks(): Promise<void> {
  let lancedb: any;
  try {
    lancedb = await import('@lancedb/lancedb');
  } catch (err) {
    console.error(`Failed to import @lancedb/lancedb: ${(err as Error).message}`);
    process.exit(3);
  }

  console.log('[2] LanceDB chunk count');
  const conn = await lancedb.connect(LANCEDB_PATH);
  let table: any;
  try {
    table = await conn.openTable('chunks');
  } catch (err) {
    console.error(`  ✗ cannot open table 'chunks' at ${LANCEDB_PATH}: ${(err as Error).message}`);
    process.exit(3);
  }

  // Pull all rows for this doc — works for small/medium docs. For a 200-page
  // doc with ~600 chunks this is still tiny.
  // LanceDB schema uses snake_case (document_id, page_number, chunk_index);
  // SearchResult API exposes camelCase. See vector-store.ts:229-232.
  const docChunks: any[] = await table.query()
    .where(`document_id = "${docRow!.id}"`)
    .limit(10_000)
    .toArray();
  console.log(`  chunks for documentId: ${docChunks.length}`);
  if (docChunks.length === 0) {
    console.error('  ✗ no chunks found in LanceDB even though SQLite says INDEXED — this is the bug.');
    console.log('    Likely cause: the ingestion finished + status flipped, but vector writes were rolled back');
    console.log('    or the documentId mismatch between SQLite and LanceDB.');
    process.exit(4);
  }

  // Page coverage (LanceDB uses snake_case)
  const pages = new Set<number>();
  for (const c of docChunks) if (typeof c.page_number === 'number') pages.add(c.page_number);
  console.log(`  page coverage: ${pages.size} distinct pages, range [${pages.size ? Math.min(...pages) : '?'}-${pages.size ? Math.max(...pages) : '?'}]`);
  console.log();

  // ────────────────────────────────────────────────────────────────────────
  // 3. Sample chunks
  // ────────────────────────────────────────────────────────────────────────
  console.log(`[3] Sample chunks (${SAMPLE_CHUNKS} of ${docChunks.length})`);
  const ordered = [...docChunks].sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
  const positions = [0, Math.floor(ordered.length / 2), ordered.length - 1].slice(0, SAMPLE_CHUNKS);
  for (const i of positions) {
    const c = ordered[i];
    console.log(`  chunk_index=${c.chunk_index} page_number=${c.page_number} chars=${(c.text ?? '').length}`);
    console.log(`    "${(c.text ?? '').replace(/\s+/g, ' ').slice(0, 280)}…"`);
  }
  console.log();

  // ────────────────────────────────────────────────────────────────────────
  // 4. Substring search inside this doc's chunks
  // ────────────────────────────────────────────────────────────────────────
  console.log(`[4] Does any chunk contain the literal substring "${SUBSTR}"?`);
  const re = new RegExp(SUBSTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const matchingChunks = docChunks.filter(c => typeof c.text === 'string' && re.test(c.text));
  console.log(`  matching chunks: ${matchingChunks.length}`);
  if (matchingChunks.length === 0) {
    // Also try alternative phrasings
    const altPatterns = [
      /\b05[\/\-]13[\/\-]2026?\b/i,
      /\b5[\/\-]13[\/\-]2026?\b/i,
      /\bMay\s+13\s*,?\s*2026\b/i,
      /\b13\s+May\s+2026\b/i,
    ];
    console.log(`  no exact-substring match. Trying date pattern variants:`);
    for (const p of altPatterns) {
      const n = docChunks.filter(c => typeof c.text === 'string' && p.test(c.text)).length;
      console.log(`    ${p.source}: ${n} chunk(s)`);
    }
    console.log();
    console.log('  ⚠️  If none of the date variants match, the text extraction did not capture');
    console.log('      a "May 13, 2026" mention in this document. Possible causes:');
    console.log('        - the document genuinely doesn\'t reference that date');
    console.log('        - OCR failed on the page(s) that do');
    console.log('        - the date is written in an unusual way (numbered list, image-only stamp)');
  } else {
    console.log('  ✓ at least one chunk contains the substring. Sample matches:');
    for (const c of matchingChunks.slice(0, 3)) {
      const idx = (c.text as string).toLowerCase().indexOf(SUBSTR);
      const before = (c.text as string).slice(Math.max(0, idx - 80), idx);
      const after = (c.text as string).slice(idx, idx + SUBSTR.length + 80);
      console.log(`    page=${c.page_number} chunk_index=${c.chunk_index}`);
      console.log(`      "...${before}[MATCH]${after}..."`);
    }
  }
  console.log();

  // ────────────────────────────────────────────────────────────────────────
  // 5. Hybrid search via the live master API — does this doc surface?
  // ────────────────────────────────────────────────────────────────────────
  console.log(`[5] Hybrid search via master API for "${QUERY}"`);
  const apiUrl = (process.env.FLEET_URL ?? 'http://localhost:3000') + '/api/search/semantic';
  const params = new URLSearchParams({ query: QUERY, ...(CASE_ID ? { caseId: CASE_ID } : (docRow!.caseId ? { caseId: docRow!.caseId } : {})), limit: String(TOP_N) });
  try {
    const r = await fetch(`${apiUrl}?${params}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      console.log(`  ✗ HTTP ${r.status}`);
    } else {
      const data = await r.json() as { results?: any[] };
      const results = data.results ?? [];
      console.log(`  top ${results.length} results across caseId=${params.get('caseId') ?? '(any)'}:`);
      let foundAt = -1;
      results.forEach((res: any, i: number) => {
        const isOurs = res.documentId === docRow!.id || res.document === docRow!.fileName;
        if (isOurs && foundAt === -1) foundAt = i;
        const marker = isOurs ? '◀ THIS DOC' : '';
        console.log(`    #${i + 1}  score=${(res.score ?? 0).toFixed(4)}  page=${res.page ?? '-'}  ${(res.document ?? '').slice(0, 60)} ${marker}`);
      });
      if (foundAt === -1) {
        console.log();
        console.log(`  ⚠️  document NOT in top ${results.length} for this query.`);
        console.log('     Implication: the indexed chunks of this doc are scoring lower than other');
        console.log('     chunks for this query. Likely causes:');
        console.log('       - the doc doesn\'t mention the query terms (combined with [4] above tells you which)');
        console.log('       - reranker or scoring threshold is filtering it out');
        console.log('       - other docs have stronger lexical/semantic match');
      } else {
        console.log();
        console.log(`  ✓ document surfaces at rank #${foundAt + 1}.`);
      }
    }
  } catch (err) {
    console.log(`  ✗ search request failed: ${(err as Error).message}`);
  }
  console.log();

  // ────────────────────────────────────────────────────────────────────────
  // 6. Pattern (FTS) search
  // ────────────────────────────────────────────────────────────────────────
  console.log(`[6] Pattern (FTS) search for "${QUERY}"`);
  try {
    const r = await fetch(`http://localhost:3000/api/search/pattern?${new URLSearchParams({ query: QUERY, ...(docRow!.caseId ? { caseId: docRow!.caseId } : {}), limit: String(TOP_N) })}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      console.log(`  ✗ HTTP ${r.status}`);
    } else {
      const data = await r.json() as { results?: any[] };
      const results = data.results ?? [];
      console.log(`  ${results.length} hits across caseId=${docRow!.caseId}:`);
      const ours = results.filter((res: any) => res.documentId === docRow!.id || res.document === docRow!.fileName);
      console.log(`  ${ours.length} hits in THIS document.`);
      ours.slice(0, 5).forEach((res: any, i: number) => {
        console.log(`    page=${res.page ?? '-'}  "${(res.text ?? res.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200)}…"`);
      });
    }
  } catch (err) {
    console.log(`  ✗ pattern search failed: ${(err as Error).message}`);
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('Done. Read [4] for the deciding signal:');
  console.log('  [4] matches=0  →  text-extraction or document content issue');
  console.log('  [4] matches>0 but [5] doesn\'t surface →  search ranking/threshold issue');
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(99);
});
