/** @jest-environment node */
/**
 * Every full-scan absence claim names its denominator (task 33).
 *
 * The gap this closes: task 23 items 5–6 made the uncapped `fts+regex` proof
 * carry its scoped denominator, but all three `full-scan` paths — the coverage
 * rule, the zero-candidate fallback, and the capped-page escalation — said only
 * "ran a full regex scan instead" or "exhaustive over the index", with no
 * numbers. So the STRONGER proof (a scan that reads every chunk) was the LESS
 * qualified one, which is the inversion this whole series keeps surfacing.
 *
 * The negative cases below matter more than the positives. A proven-absence
 * claim is sound only when the scan reached the end of the table, was not time-
 * boxed, found nothing, AND is not one page of a longer answer. The last guard
 * is the subtle one: on a later page, earlier pages may have returned matches,
 * so a zero here is not an absence for the query.
 *
 * Every pattern and document title is SYNTHETIC (CLAUDE.md § Privacy).
 */

jest.mock('../../../vector/vector-store', () => {
  class MatchQuery {
    constructor(
      public query: string,
      public column: string,
      public options?: Record<string, unknown>,
    ) {}
  }
  return { MatchQuery, Operator: { Or: 'OR', And: 'And' } };
});

import { ScanForPatternTool } from '../scan-for-pattern';
import { clearCorpusDenominatorCache } from '../../corpus-denominator';
import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';

const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

/** Matches the live shape: two observed status values, one outside the conventional four. */
const STATUS_GROUPS = [
  { status: 'DISCOVERED', _count: { _all: 768 } },
  { status: 'INDEXED', _count: { _all: 96 } },
];

interface Row {
  chunkId: string;
  text: string;
  metadata: {
    documentId: string;
    caseId: string;
    pageNumber: number;
    chunkIndex: number;
    isExhibit: boolean;
  };
  score: number;
}

/** `hits` rows containing the target word, placed FIRST, then `misses` without it. */
function makeCorpus(hits: number, misses: number): Row[] {
  const texts = [
    ...Array.from({ length: hits }, (_, i) => `Unbeknownst to the parties, item ${i} was withdrawn.`),
    ...Array.from({ length: misses }, (_, i) => `The clerk is directed to enter order ${i}.`),
  ];
  return texts.map((text, i) => ({
    chunkId: `chunk-${i}`,
    text,
    metadata: {
      documentId: `doc-${i % 3}`,
      caseId: 'case-1',
      pageNumber: i + 1,
      chunkIndex: i,
      isExhibit: false,
    },
    score: 0,
  }));
}

function makeHarness(rows: Row[], opts: { groupByThrows?: boolean } = {}) {
  const search = jest.fn(async (q: any) => {
    const text: string = q.ftsQuery?.query ?? q.hybridQuery ?? '';
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((r) => {
      const rowTokens = new Set(r.text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
      return tokens.some((t) => rowTokens.has(t));
    });
    return hits.slice(0, q.limit ?? 10);
  });

  const scanTextColumn = jest.fn(
    async ({ limit, offset = 0 }: { limit: number; offset?: number }) =>
      rows.slice(offset, offset + limit),
  );

  const groupBy = opts.groupByThrows
    ? jest.fn().mockRejectedValue(new Error('db down'))
    : jest.fn().mockResolvedValue(STATUS_GROUPS);

  const database = {
    document: {
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'motion.pdf',
        filing: null,
        case: null,
        documentType: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy,
    },
    case: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ id: 'case-1' }]),
    },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    motion: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const context = {
    database,
    vectorStore: { search, scanTextColumn },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  } as unknown as ToolExecutionContext;

  return { context, search, scanTextColumn, groupBy };
}

const run = (tool: ScanForPatternTool, h: any, params: any) =>
  (tool as any).executeImpl(params, h.context, CONFIG);

/** The sentence the fix emits. */
const ABSENCE_CLAIM = /read all [\d,]+ chunks in scope to the end of the table and matched nothing/i;

describe('full-scan absence claims carry a denominator', () => {
  let tool: ScanForPatternTool;
  const savedPath = process.env.LANCEDB_PATH;

  beforeEach(() => {
    tool = new ScanForPatternTool();
    clearCorpusDenominatorCache();
    // Force the vector count to fail so these assertions are about the document
    // denominator only, and are not hostage to whether LanceDB loads under jest.
    process.env.LANCEDB_PATH = '/nonexistent/full-scan-denominator-test/lancedb';
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.LANCEDB_PATH;
    else process.env.LANCEDB_PATH = savedPath;
  });

  // ── The three full-scan paths ───────────────────────────────────────────

  it('coverage rule → full scan: a zero names its denominator', async () => {
    // A character class makes every literal unreachable, so the tool escalates
    // before the keyword query runs.
    const h = makeHarness(makeCorpus(0, 20));
    const res = await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(0);
    const w = res.warnings.join(' ');
    expect(w).toMatch(ABSENCE_CLAIM);
    expect(w).toContain('96 of 864 documents');
    expect(w).toMatch(/proven absent from/i);
  });

  it('zero-candidate fallback → full scan: a zero names its denominator', async () => {
    // A single mid-word fragment: FTS has no token, so the regex never ran.
    const h = makeHarness(makeCorpus(0, 20));
    const res = await run(tool, h, { pattern: 'qxwvuzz', limit: 5 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(0);
    expect(res.warnings.join(' ')).toMatch(ABSENCE_CLAIM);
    expect(res.warnings.join(' ')).toContain('96 of 864 documents');
  });

  it('quotes the scanned count ALONGSIDE the denominator, not instead of it', async () => {
    // A divergence between chunks actually read and the vector store's count is
    // itself a finding — only visible if both numbers are shown.
    const h = makeHarness(makeCorpus(0, 20));
    const res = await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });

    expect(res.scanned).toBe(20);
    expect(res.warnings.join(' ')).toContain('read all 20 chunks in scope');
  });

  it('keeps the diagnostic that explains WHY it escalated', async () => {
    const h = makeHarness(makeCorpus(0, 20));
    const res = await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });

    // Two warnings doing two jobs: why the strategy changed, and what was proven.
    expect(res.warnings.join(' ')).toMatch(/ran a full regex scan instead/i);
    expect(res.warnings.join(' ')).toMatch(ABSENCE_CLAIM);
  });

  // ── The negatives: when NO claim may be made ────────────────────────────

  it('makes no absence claim when the scan found matches', async () => {
    const h = makeHarness(makeCorpus(3, 17));
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).not.toMatch(ABSENCE_CLAIM);
  });

  it('makes no absence claim on a later page, even when that page is empty', async () => {
    // `runFullScan` sets `nextOffset` only when it meets a (limit+1)-th match,
    // so a resumed page normally opens ON a matching row and cannot be empty.
    // The state the `!cursor` guard defends against is therefore reachable only
    // when the corpus changes between pages — a reindex, or an ingest landing
    // mid-answer. Simulated here by removing the second match after page 1.
    const rows = makeCorpus(2, 18);
    const h = makeHarness(rows);

    const p1 = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 1 });
    expect(p1.results).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();

    rows[1].text = 'The clerk is directed to enter the amended order.';

    const p2 = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 1, cursor: p1.nextCursor });
    expect(p2.results).toHaveLength(0);
    expect(p2.truncated).toBeFalsy();
    expect(p2.nextCursor).toBeUndefined();
    // Every condition for a proof holds on this page — completed, untruncated,
    // zero matches — yet the query ALREADY returned a match on page 1. Claiming
    // absence would assert a phrase is missing that the tool itself just found.
    expect(p2.warnings.join(' ')).not.toMatch(ABSENCE_CLAIM);
    expect(p2.warnings.join(' ')).not.toMatch(/proven absent/i);
  });

  it('makes no absence claim when the store cannot full-scan at all', async () => {
    const h = makeHarness(makeCorpus(0, 20));
    delete (h.context.vectorStore as any).scanTextColumn;

    const res = await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });
    expect(res.warnings.join(' ')).not.toMatch(ABSENCE_CLAIM);
  });

  // ── The escalation warning must not pre-declare its own outcome ─────────

  it('never asserts exhaustiveness in a warning pushed BEFORE the scan runs', async () => {
    // The capped-page escalation warning is emitted before `runFullScan`, so it
    // cannot know what the scan covered. It used to read "so the result is
    // exhaustive over the index" — reachably false, since a truncated
    // escalation put that sentence in the same warnings[] as "Results are
    // partial". It must describe the action, not the result.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'scan-for-pattern.ts'),
      'utf8',
    );
    // Collapse `' +` continuations so a claim cannot hide across a line break.
    const collapsed = src.replace(/'\s*\+\s*\n\s*'/g, '');
    expect(collapsed).not.toMatch(/escalated to a full regex scan so the result is exhaustive/i);
  });

  it('emits no unqualified completeness claim anywhere in a capped-escalation answer', async () => {
    // 3 matches, limit 1: the FTS pool caps, the page does not fill, and the
    // tool escalates. Whatever it says, no sentence may claim exhaustiveness
    // without either a denominator or an explicit bound beside it.
    const h = makeHarness(makeCorpus(3, 17));
    const res = await run(tool, h, { pattern: 'unbeknownst', limit: 1 });

    const w = res.warnings.join(' ');
    // If "exhaustive" appears at all, it must be the denominator-bearing form.
    for (const m of w.match(/[^.]*exhaustive[^.]*\./gi) ?? []) {
      expect(m).toMatch(/proven absent from|over the index: proven/i);
    }
    expect(w).not.toMatch(/the absence is proven/i);
  });

  // ── Degradation ─────────────────────────────────────────────────────────

  it('still refuses an unqualified proof when the denominator cannot be read', async () => {
    const h = makeHarness(makeCorpus(0, 20), { groupByThrows: true });
    const res = await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });

    const w = res.warnings.join(' ');
    expect(w).toMatch(ABSENCE_CLAIM);
    // The claim degrades to naming the gap rather than asserting a bare proof.
    expect(w).toMatch(/could not be determined/i);
    expect(w).not.toMatch(/the absence is proven/i);
  });

  it('never emits the banned bare form on any full-scan path', async () => {
    for (const pattern of ['[Zz]qxwvu', 'qxwvuzz']) {
      const h = makeHarness(makeCorpus(0, 20));
      const res = await run(tool, h, { pattern, limit: 5 });
      expect(res.warnings.join(' ')).not.toMatch(/the absence is proven/i);
      expect(res.warnings.join(' ')).not.toMatch(/not merely unreached/i);
    }
  });

  it('reads the denominator once per scan, not once per warning', async () => {
    const h = makeHarness(makeCorpus(0, 20));
    await run(tool, h, { pattern: '[Zz]qxwvu', limit: 5 });
    expect(h.groupBy).toHaveBeenCalledTimes(1);
  });
});
