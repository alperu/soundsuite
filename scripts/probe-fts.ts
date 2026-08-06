#!/usr/bin/env tsx
/**
 * probe-fts.ts — directly query LanceDB FTS to figure out which terms work
 * and which don't. Bypasses every layer of master code.
 *
 *   npx tsx scripts/probe-fts.ts
 *
 * Reports for each test query:
 *   - hits count
 *   - whether the missing-doc (doc UUID below) is in the hits
 */

import * as path from 'path';
import * as lancedb from '@lancedb/lancedb';
import { MatchQuery, Operator } from '@lancedb/lancedb';

const LANCEDB_PATH = path.resolve(__dirname, '..', 'data', 'lancedb');
const TARGET_DOC = '18f5d01a-50f2-4f38-b4d9-7d85b3aab4fd'; // 25-905-CV 051826 2nd Supp RR Vol 2

interface Probe {
  label: string;
  query: string;
  op?: 'Or' | 'And';
}

const PROBES: Probe[] = [
  { label: 'verbatim phrase',         query: 'May 13 2026 hearing trust fund', op: 'And' },
  { label: 'verbatim OR',             query: 'May 13 2026 hearing trust fund', op: 'Or' },
  { label: 'just "May 13"',           query: 'May 13', op: 'And' },
  { label: 'just "May 13 2026"',      query: 'May 13 2026', op: 'And' },
  { label: 'just "May"',              query: 'May', op: 'Or' },
  { label: 'just "13"',               query: '13', op: 'Or' },
  { label: 'just "2026"',             query: '2026', op: 'Or' },
  { label: 'just "trust"',            query: 'trust', op: 'Or' },
  { label: 'just "Rowe"',           query: 'Rowe', op: 'Or' },
  { label: 'just "hearing"',          query: 'hearing', op: 'Or' },
  { label: 'just "Stevens"',          query: 'Stevens', op: 'Or' },
  { label: 'just "Doe"',         query: 'Doe', op: 'Or' },
  { label: 'just "Cross-Examination"',query: 'Cross-Examination', op: 'Or' },
];

async function main(): Promise<void> {
  console.log(`LanceDB: ${LANCEDB_PATH}`);
  const conn = await lancedb.connect(LANCEDB_PATH);
  const table = await conn.openTable('chunks');

  // Confirm FTS index exists
  const indices = await table.listIndices();
  console.log(`Indices: ${indices.map((i: any) => `${i.name ?? '?'}(${i.indexType ?? '?'})`).join(', ')}`);
  console.log(`Total chunks in table: ${await table.countRows()}`);
  console.log(`Target document chunks: ${await table.countRows(`document_id = "${TARGET_DOC}"`)}`);
  console.log();

  console.log('FTS probes — using LanceDB native FTS (BM25, English stemmer, removeStopWords=true, asciiFolding=true):');
  console.log();
  console.log('LABEL                          | OP  | HITS  | TARGET in top 50?');
  console.log('-------------------------------|-----|-------|------------------');

  for (const p of PROBES) {
    try {
      const q = new MatchQuery(p.query, 'text', { operator: p.op === 'And' ? Operator.And : Operator.Or });
      const rows = await table.query().fullTextSearch(q).limit(50).toArray();
      const targetHit = rows.some(r => r.document_id === TARGET_DOC);
      const hasTarget = targetHit ? '✓ yes' : (rows.length > 0 ? '✗ no' : '— empty');
      console.log(`${p.label.padEnd(30)} | ${(p.op ?? 'Or').padEnd(3)} | ${String(rows.length).padStart(5)} | ${hasTarget}`);
    } catch (err) {
      console.log(`${p.label.padEnd(30)} | ${(p.op ?? 'Or').padEnd(3)} | ERROR | ${(err as Error).message.slice(0, 60)}`);
    }
  }
  console.log();

  // Try a phrase search for "May 13 2026" verbatim (different operator path)
  console.log('Phrase search (positional, exact word order):');
  try {
    const { PhraseQuery } = await import('@lancedb/lancedb');
    const q = new PhraseQuery('May 13 2026', 'text');
    const rows = await table.query().fullTextSearch(q).limit(50).toArray();
    const targetHit = rows.some(r => r.document_id === TARGET_DOC);
    console.log(`  "May 13 2026" phrase: hits=${rows.length}  target_in_top_50=${targetHit ? 'yes' : 'no'}`);
  } catch (err) {
    console.log(`  phrase error: ${(err as Error).message}`);
  }
  console.log();

  // Sanity: list 5 random chunks and search for a literal term from one of them
  console.log('Sanity check — pick one chunk from target doc, extract a unique term, then FTS for it:');
  const sample = await table.query().where(`document_id = "${TARGET_DOC}"`).limit(1).toArray();
  if (sample[0]) {
    const text = sample[0].text as string;
    console.log(`  sample chunk page=${sample[0].page_number} text head: "${text.slice(0, 200).replace(/\s+/g, ' ')}..."`);
    // Pick a multi-syllable unique-ish word
    const candidates = text.match(/\b[A-Z][a-z]{4,12}\b/g) || [];
    const term = candidates.find(t => !['Court', 'Cause', 'Texas', 'County', 'District', 'Marriage', 'Stevens', 'Travis'].includes(t)) || candidates[0];
    if (term) {
      console.log(`  picked term: "${term}"`);
      const q = new MatchQuery(term, 'text', { operator: Operator.Or });
      const rows = await table.query().fullTextSearch(q).limit(50).toArray();
      const targetHit = rows.some(r => r.document_id === TARGET_DOC);
      console.log(`  FTS "${term}": hits=${rows.length}  target_in_top_50=${targetHit ? 'yes' : 'no'}`);
    }
  }
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(99);
});
