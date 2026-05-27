/**
 * Unit-level test for the boolean-to-fts OR-of-refs fix.
 *
 * Compiles the user's exact filter through `parseBooleanQuery` +
 * `buildLanceFilter` (or whatever the public entry point is) and prints:
 *   1. The parsed AST
 *   2. The whereClauses array
 *   3. The prismaRequests array
 *
 * If the OR-of-refs fix is working you should see a SINGLE whereClause
 * like `(case_id IN (...) OR filing_id IN (...))` — NOT a tree of TERM
 * nodes degraded to text matches.
 *
 * Run:  npx tsx scripts/test-or-ref-filter.ts
 */

// Polyfill TextEncoder for noble-hashes via Prisma — same shim used in jest setup.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (globalThis as any).TextEncoder === 'undefined') (globalThis as any).TextEncoder = NodeTextEncoder;
if (typeof (globalThis as any).TextDecoder === 'undefined') (globalThis as any).TextDecoder = NodeTextDecoder;

import { parseBooleanQuery } from '../src/lib/search/boolean-query';
import { extractFieldFilters } from '../src/lib/search/boolean-to-fts';

const USER_FILTERS = [
  // The user's most recent filter — AND between groups.
  '(case==@04a8cd94-359c-4feb-be16-979592c3c235 or case==@92b9ad81-040a-4830-8686-7cccaad903a4 or case==@1535c622-8955-4669-8f29-884a4f2b31ea or case==@c608b81a-8479-4890-8670-0d0352c257d8) and (filingRef==@41b364c2-9f34-45b9-a37d-2c709d2b2060 or filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016 or filingRef==@33c9a4f9-41f7-4e24-babb-645c6f249e77)',
  // The earlier variant with OR between groups (was broken before flatten fix).
  '((case==@04a8cd94-359c-4feb-be16-979592c3c235 or case==@92b9ad81-040a-4830-8686-7cccaad903a4 or case==@1535c622-8955-4669-8f29-884a4f2b31ea or case==@c608b81a-8479-4890-8670-0d0352c257d8) or (filingRef==@41b364c2-9f34-45b9-a37d-2c709d2b2060 or filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016 or filingRef==@33c9a4f9-41f7-4e24-babb-645c6f249e77))',
  // Single ref atom — should hit the lance-scalar-ref branch.
  'case==@04a8cd94-359c-4feb-be16-979592c3c235',
  // OR of caseRefs only.
  'caseRef==@04a8cd94-359c-4feb-be16-979592c3c235 or caseRef==@92b9ad81-040a-4830-8686-7cccaad903a4',
  // Mixed ref + non-ref under OR — should NOT collapse (degrade fallback).
  'case==@04a8cd94-359c-4feb-be16-979592c3c235 or judge->displayName=="Roberts"',
  // Mixed columns — should produce two IN clauses ORed together.
  'case==@04a8cd94-359c-4feb-be16-979592c3c235 or filingRef==@41b364c2-9f34-45b9-a37d-2c709d2b2060',
];

async function main(): Promise<void> {
  for (const filter of USER_FILTERS) {
    console.log('═'.repeat(80));
    console.log('FILTER:', filter.slice(0, 120) + (filter.length > 120 ? '…' : ''));
    const parsed = parseBooleanQuery(filter);
    if (!parsed.ok) {
      console.log('  parse error:', parsed.error);
      continue;
    }
    console.log('  hasOperators:', parsed.hasOperators);
    console.log('  AST:', JSON.stringify(parsed.ast, null, 2).slice(0, 500));
    const compiled = extractFieldFilters(parsed.ast);
    console.log('  whereClauses:');
    for (const w of compiled.whereClauses) console.log('    ·', w);
    console.log('  prismaRequests:', compiled.prismaRequests.length);
    for (const r of compiled.prismaRequests) {
      console.log('    ·', r.path.join('->'), r.cmp, r.value, r.isRef ? '(ref)' : '');
    }
    console.log('  residual FTS AST:', JSON.stringify(compiled.ast, null, 2).slice(0, 300));
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
