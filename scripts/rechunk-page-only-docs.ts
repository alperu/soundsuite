/**
 * One-shot: re-chunk the documents that were indexed at 1-chunk-per-page
 * granularity (Reporter's Record transcripts where the splitter's separator
 * hierarchy fell through to whitespace). Calls the existing
 * /api/documents/[id]/reindex-pages endpoint for each affected doc.
 *
 * Delete this script after the cleanup completes.
 *
 * Usage:
 *   ts-node scripts/rechunk-page-only-docs.ts              # rechunk all 5
 *   ts-node scripts/rechunk-page-only-docs.ts --only=smallest  # 31-pager only
 *   BASE_URL=http://localhost:3000 ts-node scripts/rechunk-page-only-docs.ts
 */

interface TargetDoc {
  id: string;
  fileName: string;
  pageCount: number;
}

// Identified via: chunks/page ratio == 1.0 in LanceDB chunks table
const TARGETS: TargetDoc[] = [
  { id: 'f6731412-4a14-4ad7-8774-6ec20f266e36', fileName: '25-905-CV 031026 Supp RR Vol 1 of 1.pdf',            pageCount: 31 },
  { id: 'c2256da8-9c8a-4631-a2e1-0379cfe8b5e9', fileName: 'TRAVIS-D-1-FM-25-000222-RR-VOL002.pdf',              pageCount: 49 },
  { id: '18f5d01a-50f2-4f38-b4d9-7d85b3aab4fd', fileName: '25-905-CV 051826 2nd Supp RR Vol 2 of 3.pdf',         pageCount: 73 },
  { id: 'fc099544-6a0b-4fdd-aec8-4bd770cdc1a9', fileName: '00-555-CV 051826 2nd Supp RR Vol 2 of 3.pdf',         pageCount: 73 },
  { id: 'b9fea35f-c0f1-4bd4-a780-23660527cc98', fileName: 'Travis-RR-D-1-FM-25-000222-VOL2.pdf',                 pageCount: 73 },
];

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

async function rechunk(doc: TargetDoc): Promise<void> {
  const pages = Array.from({ length: doc.pageCount }, (_, i) => i + 1);
  const url = `${BASE_URL}/api/documents/${doc.id}/reindex-pages`;
  const started = Date.now();
  console.log(`[rechunk] ${doc.fileName} (${doc.pageCount} pages) -> POST ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages }),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} (${elapsed}s): ${text.slice(0, 500)}`);
  }
  const body = await resp.json().catch(() => ({}));
  console.log(`[rechunk] ✓ ${doc.fileName} done in ${elapsed}s`, body);
}

async function main(): Promise<void> {
  const onlySmallest = process.argv.includes('--only=smallest');
  const skipFirst = process.argv.includes('--skip-first');
  let queue = TARGETS;
  if (onlySmallest) queue = TARGETS.slice(0, 1);
  else if (skipFirst) queue = TARGETS.slice(1);
  console.log(`[rechunk] processing ${queue.length} document(s)`);
  for (const doc of queue) {
    try {
      await rechunk(doc);
    } catch (err) {
      console.error(`[rechunk] FAILED ${doc.fileName}:`, err);
      process.exitCode = 1;
      return;
    }
  }
  console.log('[rechunk] all done');
}

main().catch((err) => {
  console.error('[rechunk] fatal:', err);
  process.exit(1);
});
