#!/usr/bin/env tsx
/**
 * reclassify-filing-types.ts — re-run the filing-detector against every
 * Document row's fileName and update documentType where the regex now
 * disagrees with what was stored at ingest time.
 *
 * Use when the filing-detector logic has changed (e.g. 2026-05-27: added
 * RR / CR abbreviation patterns) and previously-ingested docs are tagged
 * with a stale or wrong type.
 *
 * Does NOT re-write chunk text (the [Filing: ...] prefix embedded in
 * each chunk stays as-is). The downstream ranking fix uses filename as
 * a fallback signal so this is OK for search recall. If you also want
 * to refresh the chunk-prefix, re-queue the document instead.
 *
 * Usage:
 *   npx tsx scripts/reclassify-filing-types.ts           # dry run, prints diff
 *   npx tsx scripts/reclassify-filing-types.ts --apply   # writes changes
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { detectFilingType } from '../src/services/filing-detector';

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(__dirname, '..', 'prisma', 'data', 'sound-suite.db');

interface Row { id: string; fileName: string; documentType: string | null; status: string }

const db = new Database(DB_PATH, { readonly: !APPLY });

const rows = db.prepare<unknown[], Row>(
  'SELECT id, fileName, documentType, status FROM Document'
).all();

console.log(`Loaded ${rows.length} Document rows from ${DB_PATH}`);
console.log(`Mode: ${APPLY ? 'APPLY (will UPDATE)' : 'DRY RUN'}`);
console.log();
console.log('id        | status     | detected         | stored           | filename');
console.log('----------|------------|------------------|------------------|---------');

const changes: Array<{ id: string; from: string | null; to: string }> = [];
let unchanged = 0;
let lowConfidence = 0;

for (const r of rows) {
  const det = detectFilingType(r.fileName);
  // Only correct when the detector is at least moderately confident AND it
  // disagrees with the stored value. We don't want to wipe a human's
  // manual override with a low-confidence regex guess.
  if (det.confidence < 0.5) { lowConfidence++; continue; }
  if (det.type === r.documentType) { unchanged++; continue; }
  // Skip the "Other" -> typed transition for confidence < 0.85; "Other"
  // often means "no clear filename signal" and the stored type might come
  // from PDF header detection that's smarter than us.
  if (r.documentType && det.type === 'Other') { unchanged++; continue; }
  changes.push({ id: r.id, from: r.documentType, to: det.type });
  console.log(
    `${r.id.slice(0, 8)}  | ${(r.status || '').padEnd(10)} | ${det.type.padEnd(16)} | ${(r.documentType ?? '(null)').padEnd(16)} | ${r.fileName.slice(0, 80)}`,
  );
}

console.log();
console.log(`Summary: ${changes.length} change(s), ${unchanged} already correct, ${lowConfidence} low-confidence (skipped)`);

if (APPLY && changes.length > 0) {
  const stmt = db.prepare<[string, string], unknown>('UPDATE Document SET documentType = ? WHERE id = ?');
  const tx = db.transaction((items: typeof changes) => {
    for (const c of items) stmt.run(c.to, c.id);
  });
  tx(changes);
  console.log(`Applied ${changes.length} updates.`);
} else if (changes.length > 0) {
  console.log('Re-run with --apply to write changes.');
}
