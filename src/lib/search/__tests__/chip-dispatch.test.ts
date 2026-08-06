// Verify buildChipSpecs produces per-chip dispatch specs with hard
// where-clauses for chip refs and a soft-boost framing segment.

import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (global as any).TextEncoder === 'undefined') (global as any).TextEncoder = NodeTextEncoder;
if (typeof (global as any).TextDecoder === 'undefined') (global as any).TextDecoder = NodeTextDecoder;

jest.mock('../../mcp/tools/ai-helper', () => ({
  callLLM: jest.fn(),
  callLLMJson: jest.fn(),
  buildContext: jest.fn(),
  getAvailableProvider: jest.fn(),
}));
jest.mock('../../ai/ai-provider', () => ({ streamAI: jest.fn() }));
jest.mock('../reranker', () => ({
  rerank: jest.fn(),
  RerankableResult: class {},
}));
jest.mock('../../ai/stream-rlm', () => ({
  runRlmWithTools: jest.fn(),
  RLM_MODEL_ID: 'mock-rlm',
}));

import { buildChipSpecs } from '../deep-search';

describe('buildChipSpecs (chip dispatch shape)', () => {
  it('returns null when query has no chips', () => {
    expect(buildChipSpecs('plain free text question')).toBeNull();
  });

  it('produces per-chip specs with hard where-clauses for the user scenario', () => {
    const q =
      `{{ filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016 }}  In this document we have Rowe's changing statement and check all of this   ` +
      `{{ (case==@04a8cd94-359c-4feb-be16-979592c3c235 or case==@92b9ad81-040a-4830-8686-7cccaad903a4 or case==@1535c622-8955-4669-8f29-884a4f2b31ea or case==@c608b81a-8479-4890-8670-0d0352c257d8) }}   how trust evolved over time.`;
    const specs = buildChipSpecs(q);
    expect(specs).not.toBeNull();
    expect(specs).toHaveLength(2);

    // chip 1 — filing scope
    expect(specs![0].query).toBe("In this document we have Rowe's changing statement and check all of this");
    expect(specs![0].whereClauses).toBeDefined();
    expect(specs![0].whereClauses!.some(w => /filing_id\s*=\s*['"]b691a563-/.test(w))).toBe(true);

    // chip 2 — four-case scope, collapsed to `case_id IN ('a','b','c','d')`
    // by the boolean-to-fts converter (OR-of-same-field-refs optimization).
    expect(specs![1].query).toBe('how trust evolved over time.');
    expect(specs![1].whereClauses).toBeDefined();
    const ch2Joined = specs![1].whereClauses!.join(' ');
    expect(ch2Joined).toMatch(/case_id\s+IN\b/i);
    expect(ch2Joined).toMatch(/04a8cd94/);
    expect(ch2Joined).toMatch(/92b9ad81/);
    expect(ch2Joined).toMatch(/1535c622/);
    expect(ch2Joined).toMatch(/c608b81a/);

    expect(specs![0].label).toMatch(/^chip:/);
    expect(specs![1].label).toMatch(/^chip:/);
  });

  it('prefixes a framing spec with soft-boost over chip refs when there is leading text', () => {
    const q = 'in general about the trust ' +
      '{{ filingRef==@aaaa-bbbb-cccc-dddd-eeee-1234567890ab }} this filing specifically';
    const specs = buildChipSpecs(q);
    expect(specs).not.toBeNull();
    expect(specs!.length).toBe(2);
    expect(specs![0].label).toBe('framing');
    expect(specs![0].whereClauses).toBeUndefined();
    expect(specs![0].softBoostRefs).toBeDefined();
    expect(
      specs![0].softBoostRefs!.some(b => b.field === 'filingId' && b.values.includes('aaaa-bbbb-cccc-dddd-eeee-1234567890ab')),
    ).toBe(true);
    expect(specs![1].label).toMatch(/^chip:/);
  });
});
