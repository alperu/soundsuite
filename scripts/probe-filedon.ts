/**
 * probe-filedon.ts — dump the first 4 chunks of a document to see what
 * file-stamp text the deterministic detector should be matching.
 *
 * Run: npx tsx scripts/probe-filedon.ts <documentId>
 */
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (globalThis as any).TextEncoder === 'undefined') (globalThis as any).TextEncoder = NodeTextEncoder;
if (typeof (globalThis as any).TextDecoder === 'undefined') (globalThis as any).TextDecoder = NodeTextDecoder;

import path from 'path';

async function main(): Promise<void> {
  const documentId = process.argv[2];
  if (!documentId) {
    console.error('Usage: npx tsx scripts/probe-filedon.ts <documentId>');
    process.exit(1);
  }
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(path.resolve(process.cwd(), 'data/lancedb'));
  const tbl = await db.openTable('chunks');
  const rows = await tbl
    .query()
    .where(`document_id = '${documentId}'`)
    .limit(4)
    .toArray();
  console.log(`Found ${rows.length} chunks for document ${documentId}`);
  for (const r of rows) {
    const rr = r as Record<string, unknown>;
    console.log('───── chunk', rr.chunk_index, 'page', rr.page_number, '─────');
    const t = typeof rr.text === 'string' ? rr.text.slice(0, 800) : '';
    console.log(t);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
