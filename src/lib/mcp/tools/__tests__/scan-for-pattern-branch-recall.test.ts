/** @jest-environment node */
/**
 * Tripwires for the `scan_for_pattern` recall defects in task #14 / report v8.
 *
 * Two measured failures:
 *
 *  1. `(MR\.|MS\.|THE COURT)` — ordinary transcript boilerplate — returned
 *     ZERO. Short branches (`MR`, `MS`) were dropped by the ≥3-char filter,
 *     `COURT` was dropped as `)`-adjacent, and the lone survivor `THE` is a
 *     stopword the FTS tokenizer removes. The `|` in the pattern then
 *     disqualified it from the full-scan rescue.
 *  2. A capped candidate pool could end an answer with NO `nextCursor`, so a
 *     caller paging to exhaustion read a bounded result as complete.
 *
 * Every pattern, name and document title below is SYNTHETIC (CLAUDE.md
 * § Privacy). `MR.` / `MS.` / `THE COURT` are transcript boilerplate and carry
 * no case data; no surname, file name, page number or quoted line appears here.
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

function rows(texts: string[]): Row[] {
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
    score: 1 - i / 1000,
  }));
}

/** A synthetic reporter's record: speaker labels printed in the chunk text. */
function transcriptCorpus(): Row[] {
  return rows([
    'MR. ALPHA: And this is counsel for the respondent, appearing today.',
    'THE COURT: Very well. You are the movant on the pending motion.',
    'MS. BRAVO: We would object to that characterisation, your Honor.',
    'MR. ALPHA: I could not obtain the records before the hearing date.',
    'THE COURT: The motion is denied without prejudice to refiling.',
    'CAUSE NO. 00-0000-XX. Certified copy of the proceedings herein.',
    'The reporter certifies the foregoing is a true and correct transcript.',
    'Exhibit 4 was admitted without objection from either party.',
  ]);
}

interface Harness {
  context: ToolExecutionContext;
  search: jest.Mock;
  scanTextColumn: jest.Mock;
}

/**
 * A vector-store double whose FTS arm behaves like the real index: whole-token
 * matching AND stopword removal (`removeStopWords: true` in
 * `src/lib/vector/vector-store.ts`). Both properties are load-bearing here.
 */
const STOPWORDS = new Set([
  'the', 'and', 'to', 'of', 'a', 'is', 'that', 'it', 'was', 'for', 'not', 'no', 'be',
]);

function makeHarness(corpus: Row[]): Harness {
  const search = jest.fn(async (q: any) => {
    const text: string = q.ftsQuery?.query ?? q.hybridQuery ?? '';
    const tokens = text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !STOPWORDS.has(t)); // the tokenizer drops these
    if (tokens.length === 0) return []; // an all-stopword query matches nothing
    const hits = corpus.filter((r) => {
      const rowTokens = new Set(r.text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
      return tokens.some((t) => rowTokens.has(t));
    });
    return hits.slice(0, q.limit ?? 10);
  });

  const scanTextColumn = jest.fn(
    async ({ limit, offset = 0 }: { limit: number; offset?: number }) =>
      corpus.slice(offset, offset + limit),
  );

  const database = {
    document: {
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'transcript.pdf',
        filing: null,
        case: null,
        documentType: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
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

  return { context, search, scanTextColumn };
}

const run = (tool: ScanForPatternTool, h: Harness, params: any) =>
  (tool as any).executeImpl(params, h.context, CONFIG);

describe('scan_for_pattern — alternation branch coverage', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  it('finds speaker labels for the alternation that measured ZERO', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, { pattern: '(MR\\.|MS\\.|THE COURT)', limit: 20 });

    // The exact shape of the defect: an empty result for a phrase on nearly
    // every transcript page.
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.strategy).toBe('full-scan');
    expect(h.scanTextColumn).toHaveBeenCalled();
  });

  it('says WHY it scanned, naming the unreachable branch', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, { pattern: '(MR\\.|MS\\.|THE COURT)', limit: 20 });

    expect(res.warnings.join(' ')).toMatch(/branch contributes no keyword/i);
  });

  it('scans when one branch is a stopword, even though the other is reachable', async () => {
    // The subtler hole: branch coverage that only counted ≥3-char literals
    // would pass this, `ledger` would return candidates, and the `the` branch
    // would be silently unreachable.
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, { pattern: '\\bthe\\b|\\bobjection\\b', limit: 20 });

    expect(res.strategy).toBe('full-scan');
  });

  it('scans when a branch is too short to be a keyword', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, { pattern: '\\bMR\\b|\\bobjection\\b', limit: 20 });

    expect(res.strategy).toBe('full-scan');
  });

  // ── Regression guards: the dashboard path must NOT start linear-scanning ──

  it('keeps a fully covered alternation on the FTS path when nothing matches', async () => {
    // The `/api/search/ai` shape. Every branch contributed a real, non-stopword
    // whole token, so an empty FTS result is trustworthy — a linear pass would
    // only be slower.
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, {
      pattern: '\\babsentone\\b|\\babsenttwo\\b',
      limit: 20,
    });

    expect(res.strategy).toBe('fts+regex');
    expect(h.scanTextColumn).not.toHaveBeenCalled();
    expect(res.warnings.join(' ')).toMatch(/not.*exhaustive|no candidates/i);
  });

  it('keeps a fully covered alternation on the FTS path when rows match', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, {
      pattern: '\\bobjection\\b|\\bprejudice\\b',
      limit: 20,
    });

    expect(res.strategy).toBe('fts+regex');
    expect(h.scanTextColumn).not.toHaveBeenCalled();
    expect(res.results.length).toBeGreaterThan(0);
  });
});

describe('scan_for_pattern — a capped pool never ends an answer', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  /**
   * 12 rows all carrying the token `ledger`, so FTS returns a full — and
   * therefore capped — candidate pool. The regex additionally requires
   * `closed`, so the post-filter shrinks the set.
   */
  function cappedCorpus(matchesFirst: boolean): Row[] {
    const matching = [
      'The ledger was closed before the accounting period ended.',
      'A second ledger was closed by the trustee that quarter.',
      'The third ledger was closed following the audit.',
    ];
    const decoys = Array.from(
      { length: 9 },
      (_, i) => `Entry ${i} references the ledger without any further action.`,
    );
    return rows(matchesFirst ? [...matching, ...decoys] : [...decoys, ...matching]);
  }

  const PATTERN = '\\bledger\\b.*\\bclosed\\b';

  it('escalates to a full scan rather than ending a capped answer with no cursor', async () => {
    // limit 2 → fetchLimit 10, and 12 rows carry the keyword, so the pool caps.
    // The matches sit past the cap, so this page would otherwise return few
    // results, no cursor, and a warning that more exist — unusable.
    const h = makeHarness(cappedCorpus(false));
    const res: any = await run(tool, h, { pattern: PATTERN, limit: 2 });

    expect(res.strategy).toBe('full-scan');
    expect(res.warnings.join(' ')).toMatch(/escalated to a full regex scan/i);
    expect(h.scanTextColumn).toHaveBeenCalled();
  });

  it('never ends a page with a cap warning and no cursor', async () => {
    // The contract: absence of `nextCursor` means the answer is complete.
    const h = makeHarness(cappedCorpus(false));
    const res: any = await run(tool, h, { pattern: PATTERN, limit: 2 });

    const claimsCapped = res.warnings.some((w: string) => /capped at \d+ candidates; more/i.test(w));
    expect(claimsCapped && !res.nextCursor).toBe(false);
  });

  it('stays on the FTS path when a capped pool still fills the page', async () => {
    // No perf regression for the common case: the caller has a cursor, so the
    // cap warning and the cursor together are honest.
    const h = makeHarness(cappedCorpus(true));
    const res: any = await run(tool, h, { pattern: PATTERN, limit: 2 });

    expect(res.strategy).toBe('fts+regex');
    expect(res.nextCursor).toBeDefined();
    expect(h.scanTextColumn).not.toHaveBeenCalled();
  });

  it('finds every match once the answer is exhaustive', async () => {
    const h = makeHarness(cappedCorpus(false));
    const res: any = await run(tool, h, { pattern: PATTERN, limit: 20 });

    expect(res.results).toHaveLength(3);
  });
});

/**
 * Task #15: branch coverage is not a fact about alternations. A pattern with no
 * `|` is a single branch, and the same rule decides it. Every pattern below is
 * synthetic; no case data appears here.
 */
describe('scan_for_pattern — coverage decides single-branch patterns too', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  /** A row carrying the literal phrase, so there is a match to be missed. */
  function phraseCorpus(): Row[] {
    return rows([
      'The witness testified that she could not do the reconciliation that week.',
      'Counsel referenced the ledger exhibit before the afternoon recess.',
      'The reporter certified the volume as a complete record.',
      'Objection sustained; the exhibit was withdrawn by agreement.',
      'A schedule of disbursements accompanied the accounting.',
    ]);
  }

  it('finds the phrase a de-tokenised control finds, instead of a cursor-free zero', async () => {
    const h = makeHarness(phraseCorpus());
    const hControl = makeHarness(phraseCorpus());

    // The control is de-tokenised so no whole-token keyword survives at all,
    // which already forces an exhaustive pass on main.
    const control: any = await run(tool, hControl, { pattern: '[Cc]ould [Nn]ot d[o]', limit: 20 });
    const res: any = await run(tool, h, { pattern: '[Cc]ould not do', limit: 20 });

    expect(control.results.length).toBeGreaterThan(0);
    expect(res.results.length).toBe(control.results.length);
    expect(res.strategy).toBe('full-scan');
    // The exact defect shape: fts+regex, zero rows, no cursor, reads complete.
    const looksLikeACleanZero =
      res.results.length === 0 && res.strategy === 'fts+regex' && !res.nextCursor;
    expect(looksLikeACleanZero).toBe(false);
  });

  it('escalates when every keyword the pattern yields is a stopword', async () => {
    const h = makeHarness(phraseCorpus());
    const res: any = await run(tool, h, { pattern: '[Tt]he was not', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(h.scanTextColumn).toHaveBeenCalled();
  });

  it('does not full-scan a plain non-stopword literal', async () => {
    // The guard against over-correcting: coverage must not send everything
    // down the linear path.
    const h = makeHarness(rows(['A schedule of unbeknownst entries was produced late.']));
    const res: any = await run(tool, h, { pattern: 'unbeknownst', limit: 20 });

    expect(res.strategy).toBe('fts+regex');
    expect(h.scanTextColumn).not.toHaveBeenCalled();
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('does not full-scan a regex-shaped single branch that IS covered', async () => {
    // The assertion that actually pins the generalisation: regex-like, one
    // branch, a reachable keyword. Coverage must let it through.
    const h = makeHarness(rows(['A schedule of unbeknownst entries was produced late.']));
    const res: any = await run(tool, h, { pattern: '\\bunbeknownst\\b', limit: 20 });

    expect(res.strategy).toBe('fts+regex');
    expect(h.scanTextColumn).not.toHaveBeenCalled();
    expect(res.results.length).toBeGreaterThan(0);
  });
});

describe('scan_for_pattern — parenthesised branches are not fragments', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  function parenCorpus(): Row[] {
    return rows([
      'The safeguarding provisions were adopted without objection.',
      'An unbeknownst transfer appeared in the schedule of assets.',
      'The court admitted the summary exhibit for the limited purpose.',
    ]);
  }

  it('keeps a parenthesised alternation of whole tokens on the FTS path', async () => {
    const h = makeHarness(parenCorpus());
    const res: any = await run(tool, h, { pattern: '(unbeknownst|safeguarding)', limit: 20 });

    expect(res.strategy).toBe('fts+regex');
    expect(h.scanTextColumn).not.toHaveBeenCalled();
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('still scans speaker-label boilerplate whose branches are too short', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, { pattern: '(MR\\.|MS\\.|THE COURT)', limit: 20 });

    expect(res.strategy).toBe('full-scan');
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('treats a group followed by word material as uncovered', async () => {
    // `(alpha|bravo)charlie` matches `bravocharlie`, which is nobody's index
    // token — an interior `)` must not be stripped away.
    const h = makeHarness(rows(['The alphacharlie designation was used in the caption.']));
    const res: any = await run(tool, h, { pattern: '(alpha|bravo)charlie', limit: 20 });

    expect(res.strategy).toBe('full-scan');
  });
});

describe('scan_for_pattern — the verdict does not depend on `limit`', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  /** 120 rows carrying `ledger`; none carries `closed`, so the true answer is 0. */
  function wideCorpus(): Row[] {
    return rows(
      Array.from(
        { length: 120 },
        (_, i) => `Entry ${i} references the ledger without any further action taken.`,
      ),
    );
  }

  const PATTERN = '\\bledger\\b.*\\bclosed\\b';
  const BOUNDED = /not proof of absence|would not be reached|more matches likely exist/i;

  it('reaches the same verdict at limit 20 and limit 100', async () => {
    // fetchLimit = limit * 5, so the pool caps at 20 and does not at 100. The
    // answer is the same either way and must READ the same either way.
    const small: any = await run(tool, makeHarness(wideCorpus()), { pattern: PATTERN, limit: 20 });
    const large: any = await run(tool, makeHarness(wideCorpus()), { pattern: PATTERN, limit: 100 });

    expect(small.results.length).toBe(large.results.length);
    expect(small.nextCursor).toBeUndefined();
    expect(large.nextCursor).toBeUndefined();
    // Both are complete answers over a covered keyword set. Neither may hedge.
    expect(small.warnings.join(' ')).not.toMatch(BOUNDED);
    expect(large.warnings.join(' ')).not.toMatch(BOUNDED);
  });

  it('states plainly that a covered, uncapped zero is a proven absence', async () => {
    const h = makeHarness(wideCorpus());
    const res: any = await run(tool, h, { pattern: PATTERN, limit: 100 });

    expect(res.results).toHaveLength(0);
    expect(res.warnings.join(' ')).toMatch(/exhaustive|complete|proven/i);
  });
});

describe('the proven-absence claim depends on the index tokenizer', () => {
  /**
   * `FTS_STOPWORDS` is a hand-maintained mirror of the index's stopword set, and
   * the tool now tells operators an absence is *proven* on the strength of it.
   * If `removeStopWords` is ever turned off, or the analyzer's language changes,
   * that claim silently stops being true — a stopword would be treated as
   * reachable and a zero would be called proven when recall never ran.
   *
   * Nothing else in the suite notices, because every other test drives a double.
   * This one reads the real source so the coupling cannot be broken quietly.
   */
  it('still builds the FTS index with stopword removal on', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const src = readFileSync(
      join(__dirname, '../../../vector/vector-store.ts'),
      'utf8',
    );

    expect(src).toMatch(/removeStopWords:\s*true/);
    expect(src).toMatch(/language:\s*'English'/);
  });
});
