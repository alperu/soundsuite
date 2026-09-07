/** @jest-environment node */
/**
 * Tripwires for the `scan_for_pattern` recall defect (task #11).
 *
 * The measured failure: a literal token found 37 rows, while `[Uu]nbeknownst`
 * and the mid-word fragment `nbeknownst` found **zero** — silently. Keyword
 * extraction fed BM25 a string that is not a whole index token, FTS returned no
 * candidates, and the regex never ran.
 *
 * Every pattern, name and document title below is SYNTHETIC (CLAUDE.md
 * § Privacy). `unbeknownst` is an ordinary English word chosen because it
 * exercises the class/fragment shapes; it is not from any document.
 */

// The real module loads @lancedb/lancedb (native + apache-arrow) and hides a
// MatchQuery's text inside a native handle, so the double could not tell which
// keywords the tool asked for. A plain recording class makes that observable.
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
import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';

const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

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

/** Synthetic corpus: 7 of 21 rows contain the target word, mixed case. */
function makeCorpus(): Row[] {
  const withWord = [
    'Unbeknownst to Petitioner, the Nordvale Holdings ledger had already closed.',
    'Counsel states that, unbeknownst to the parties, the exhibit was withdrawn.',
    'The witness testified he acted unbeknownst to Quill Fabrication Inc.',
    'Unbeknownst to the Court, no conference had been scheduled.',
    'It remained, unbeknownst to all, an unsigned draft.',
    'Unbeknownst to Respondent, the filing deadline had run.',
    'The transfer occurred unbeknownst to the trustee.',
  ];
  const without = [
    'CAUSE NO. 00-0000-XX. Nordvale Holdings LLC moves the Court for an order.',
    'Respondent denies that any conference occurred on 2024-01-15.',
    'The parties conferred regarding the scope of production.',
    'Exhibit A is a true and correct copy of the ledger.',
    'No further relief is requested at this time.',
    'The Court finds the motion is well taken in part.',
    'Counsel for Petitioner appeared telephonically.',
    'The reporter marked the exhibit for identification.',
    'Quill Fabrication Inc. objects to the form of the question.',
    'The deadline to respond has not yet run.',
    'Petitioner seeks costs under the applicable rule.',
    'This matter came on for hearing before the undersigned.',
    'The clerk is directed to enter the order.',
    'Nothing in this order shall be construed as a finding of fact.',
  ];

  // Interleave so paging a full scan crosses non-matching rows.
  const texts: string[] = [];
  let a = 0;
  let b = 0;
  while (a < withWord.length || b < without.length) {
    if (b < without.length) texts.push(without[b++]);
    if (b < without.length) texts.push(without[b++]);
    if (a < withWord.length) texts.push(withWord[a++]);
  }

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

interface Harness {
  context: ToolExecutionContext;
  search: jest.Mock;
  scanTextColumn: jest.Mock;
  motionFindMany: jest.Mock;
}

interface HarnessOptions {
  /** Omit `scanTextColumn` to simulate a store that cannot full-scan. */
  omitScan?: boolean;
  /** Filing relation returned by `document.findUnique`. */
  filing?: { id: string } | null;
  /** Rows `motion.findMany` returns (see `../../motion-resolution`). */
  motions?: Array<{ id: string; filingId: string; startPage: number; endPage: number | null }>;
}

/**
 * A vector-store double whose FTS arm behaves like BM25: it matches on WHOLE
 * tokens only. That single property is what reproduces the defect.
 */
function makeHarness(rows: Row[] = makeCorpus(), opts: HarnessOptions = {}): Harness {
  const search = jest.fn(async (q: any) => {
    const text: string = q.ftsQuery?.query ?? q.hybridQuery ?? '';
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((r) => {
      const rowTokens = new Set(r.text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
      return tokens.some((t) => rowTokens.has(t));
    });
    return hits.slice(0, q.limit ?? 10);
  });

  const scanTextColumn = jest.fn(async ({ limit, offset = 0 }: { limit: number; offset?: number }) =>
    rows.slice(offset, offset + limit),
  );

  const database = {
    document: {
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'motion.pdf',
        filing: opts.filing ?? null,
        case: null,
        documentType: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    case: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([{ id: 'case-1' }]) },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    motion: { findMany: jest.fn().mockResolvedValue(opts.motions ?? []) },
  };

  const vectorStore: Record<string, unknown> = { search };
  if (!opts.omitScan) vectorStore.scanTextColumn = scanTextColumn;

  const context = {
    database,
    vectorStore,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  } as unknown as ToolExecutionContext;

  return { context, search, scanTextColumn, motionFindMany: database.motion.findMany };
}

const run = (tool: ScanForPatternTool, h: Harness, params: any) =>
  (tool as any).executeImpl(params, h.context, CONFIG);

describe('scan_for_pattern — true regex recall', () => {
  let tool: ScanForPatternTool;

  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  // ── The measured defect table ─────────────────────────────────────────────

  it('finds every row for a literal whole token (the row that always worked)', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: 'unbeknownst', limit: 20 });

    expect(res.results).toHaveLength(7);
    expect(res.strategy).toBe('fts+regex');
    expect(res.candidatePool).toBe(7);
  });

  it('finds the same rows for a character class — was 0, via full-scan', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(7);
    expect(res.scanned).toBeGreaterThan(0);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(h.scanTextColumn).toHaveBeenCalled();
  });

  it('finds the same rows for a mid-word fragment — was 0, via full-scan', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: 'nbeknownst', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(7);
    expect(res.candidatePool).toBe(0);
    expect(res.warnings.join(' ')).toMatch(/no candidates/i);
  });

  it('finds the same rows for an alternation whose branches are fragments', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '(Unbe|unbe)knownst', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(7);
  });

  it('never returns an empty result set silently when recall could not run', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    // The exact shape of the old bug: `results: []` with nothing to say why.
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.strategy).toBe('full-scan');
  });

  // ── Never silent ──────────────────────────────────────────────────────────

  it('warns and still scans when FTS recall returns zero candidates', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: 'zzzabsentzzz', limit: 20 });

    expect(res.results).toHaveLength(0);
    expect(res.strategy).toBe('full-scan');
    expect(res.scanned).toBe(21); // whole synthetic corpus actually read
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('warns without scanning when a multi-token FTS query finds nothing', async () => {
    // The `/api/search/ai` shape. A linear pass would not find more, so the
    // dashboard path must stay on FTS — but it must still say so.
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '\\babsentone\\b|\\babsenttwo\\b', limit: 20 });

    expect(res.strategy).toBe('fts+regex');
    expect(res.warnings.join(' ')).toMatch(/not.*exhaustive|no candidates/i);
    expect(h.scanTextColumn).not.toHaveBeenCalled();
  });

  it('keeps whole-token alternation branches on the FTS path', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '\\bunbeknownst\\b|\\bledger\\b', limit: 20 });

    expect(res.strategy).toBe('fts+regex');
    const asked = h.search.mock.calls[0][0].ftsQuery.query;
    expect(asked).toContain('unbeknownst');
    expect(asked).toContain('ledger');
  });

  it('reports the caveat when the vector store cannot full-scan', async () => {
    const h = makeHarness(makeCorpus(), { omitScan: true });
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    expect(res.warnings.join(' ')).toMatch(/does not support/i);
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('pages a full scan by cursor with no overlap and no gap', async () => {
    const h = makeHarness();
    const seen: string[] = [];

    let cursor: string | undefined;
    let pages = 0;
    do {
      const res: any = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 3, cursor });
      expect(res.strategy).toBe('full-scan');
      seen.push(...res.results.map((r: any) => r.text));
      cursor = res.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);          // 3 + 3 + 1
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7); // no row served twice
  });

  it('pages the FTS path by cursor', async () => {
    const h = makeHarness();
    const page1: any = await run(tool, h, { pattern: 'unbeknownst', limit: 3 });
    expect(page1.results).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();

    const page2: any = await run(tool, h, {
      pattern: 'unbeknownst',
      limit: 3,
      cursor: page1.nextCursor,
    });
    const overlap = page2.results
      .map((r: any) => r.text)
      .filter((t: string) => page1.results.some((r: any) => r.text === t));
    expect(overlap).toHaveLength(0);
  });

  it('rejects a cursor minted for a different pattern', async () => {
    const h = makeHarness();
    const page1: any = await run(tool, h, { pattern: 'unbeknownst', limit: 3 });

    await expect(
      run(tool, h, { pattern: 'ledger', limit: 3, cursor: page1.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('caps a page but not the answer', async () => {
    const h = makeHarness();
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 5000 });
    expect(res.results.length).toBeLessThanOrEqual(200);
  });

  // ── Scope ─────────────────────────────────────────────────────────────────

  it('scopes the full scan to caseId and caller where-clauses', async () => {
    const h = makeHarness();
    await run(tool, h, {
      pattern: '[Uu]nbeknownst',
      caseId: 'case-1',
      whereClauses: ['filing_type = "MOTION"'],
      limit: 5,
    });

    const filter = h.scanTextColumn.mock.calls[0][0].filter;
    expect(filter.caseId).toBe('case-1');
    expect(filter._rawWhere).toEqual(['filing_type = "MOTION"']);
  });

  it('scopes the full scan to a caseIds subset (docs/tasks/12)', async () => {
    const h = makeHarness();
    h.context.database.case.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'case-1' }, { id: 'case-2' }]);

    await run(tool, h, { pattern: '[Uu]nbeknownst', caseIds: ['case-1', 'case-2'], limit: 5 });

    const filter = h.scanTextColumn.mock.calls[0][0].filter;
    expect(filter.caseIds).toEqual(['case-1', 'case-2']);
    expect(filter.caseId).toBeUndefined();
  });

  // ── Provenance carried by both paths ──────────────────────────────────────

  it('stamps caseId and motionId on full-scan results, with one motion query', async () => {
    const h = makeHarness(makeCorpus(), {
      filing: { id: 'filing-1' },
      motions: [{ id: 'motion-1', filingId: 'filing-1', startPage: 1, endPage: 100 }],
    });
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results.every((r: any) => r.caseId === 'case-1')).toBe(true);
    expect(res.results.every((r: any) => r.motionId === 'motion-1')).toBe(true);
    // Batched: one query for the whole page, never one per hit.
    expect(h.motionFindMany).toHaveBeenCalledTimes(1);
  });

  it('resolves motions for the returned page only, not the candidate pool', async () => {
    const h = makeHarness(makeCorpus(), {
      filing: { id: 'filing-1' },
      motions: [{ id: 'motion-1', filingId: 'filing-1', startPage: 1, endPage: 100 }],
    });
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 2 });

    expect(res.results).toHaveLength(2);
    expect(h.motionFindMany).toHaveBeenCalledTimes(1);
    expect(res.results.every((r: any) => r.motionId === 'motion-1')).toBe(true);
  });

  it('leaves motionId undefined when no motion covers the page', async () => {
    const h = makeHarness(makeCorpus(), {
      filing: { id: 'filing-1' },
      motions: [{ id: 'motion-1', filingId: 'filing-1', startPage: 900, endPage: 999 }],
    });
    const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 20 });

    expect(res.results.every((r: any) => r.motionId === undefined)).toBe(true);
    expect(res.results.every((r: any) => r.caseId === 'case-1')).toBe(true);
  });

  // ── Safety ────────────────────────────────────────────────────────────────

  it('rejects catastrophic patterns as INVALID_REGEX before scanning', () => {
    for (const bad of ['(a+)+b', '(x*)*y', '(?<=a*)b', '(\\d+)+', '(\\s*\\w*)*']) {
      expect(() => tool.validateParams({ pattern: bad })).toThrow(
        expect.objectContaining({ code: 'INVALID_REGEX' }),
      );
    }
  });

  it('does not reject quantified groups that are anchored by a literal', () => {
    // False positives here would make legitimate legal patterns un-runnable.
    for (const ok of ['(a|b)+', '(Exhibit)+', '(\\d{4})+', '(No\\.\\s*\\d+)+', '\\bMotion\\b|\\bOrder\\b']) {
      expect(() => tool.validateParams({ pattern: ok })).not.toThrow();
    }
  });

  it('still rejects an uncompilable pattern as INVALID_REGEX', () => {
    expect(() => tool.validateParams({ pattern: '[invalid' })).toThrow(
      expect.objectContaining({ code: 'INVALID_REGEX' }),
    );
  });

  it('accepts every pattern from the defect table', () => {
    for (const ok of ['unbeknownst', '[Uu]nbeknownst', 'nbeknownst', '(Unbe|unbe)knownst']) {
      expect(() => tool.validateParams({ pattern: ok })).not.toThrow();
    }
  });

  it('returns partial results with a warning when the scan hits its time box', async () => {
    // 2500 synthetic rows, none matching, so the scan must page — with a clock
    // that jumps 6 s per batch the 10 s box fires before the table is done.
    const rows: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      chunkId: `c-${i}`,
      text: 'The clerk is directed to enter the order.',
      metadata: {
        documentId: 'doc-0',
        caseId: 'case-1',
        pageNumber: i + 1,
        chunkIndex: i,
        isExhibit: false,
      },
      score: 0,
    }));
    const h = makeHarness(rows);

    let clock = 1_000_000;
    const realNow = Date.now;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    h.scanTextColumn.mockImplementation(async ({ limit, offset = 0 }: any) => {
      clock += 6_000;
      return rows.slice(offset, offset + limit);
    });

    try {
      const res = await run(tool, h, { pattern: '[Uu]nbeknownst', limit: 5 });
      expect(res.truncated).toBe(true);
      expect(res.nextCursor).toBeDefined();
      expect(res.warnings.join(' ')).toMatch(/partial|time box/i);
      expect(res.scanned).toBeLessThan(2500);
    } finally {
      nowSpy.mockRestore();
      expect(Date.now).toBe(realNow);
    }
  });
});
