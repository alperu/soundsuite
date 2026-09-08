/** @jest-environment node */
/**
 * Tripwires for tasks #16 / #17 / #18 — precision and phrase recall.
 *
 *  - #17: a phrase that straddles a printed transcript line number must still
 *         match, and tolerance must never make whitespace optional.
 *  - #16: a pattern is verified against the rows returned, or the rows are
 *         labelled unverified. `warnings: []` means "believed complete".
 *  - #18: curly quotes, dashes and diacritics fold on BOTH sides of the
 *         comparison, and the caller still gets raw text back.
 *
 * Every pattern, name and line below is SYNTHETIC (CLAUDE.md § Privacy).
 * `THE COURT` and speaker labels are transcript boilerplate.
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
    score: 0,
  }));
}

/**
 * The index's own comparison shape: `asciiFolding: true` on whole tokens.
 * Both the stored text and the query go through the same fold + split, which
 * is why keyword recall is not where the diacritic/quote gap lives.
 */
function indexTokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛“”„‟]/g, "'")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

interface Harness {
  context: ToolExecutionContext;
  search: jest.Mock;
  scanTextColumn: jest.Mock;
}

function makeHarness(corpus: Row[]): Harness {
  const search = jest.fn(async (q: any) => {
    const text: string = q.ftsQuery?.query ?? q.hybridQuery ?? '';
    const tokens = indexTokens(text);
    const hits = corpus.filter((r) => {
      const rowTokens = new Set(indexTokens(r.text));
      return tokens.some((t) => rowTokens.has(t));
    });
    return hits.slice(0, q.limit ?? 10);
  });

  const scanTextColumn = jest.fn(async ({ limit, offset = 0 }: { limit: number; offset?: number }) =>
    corpus.slice(offset, offset + limit),
  );

  const database = {
    document: {
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'motion.pdf',
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

/**
 * A reporter's-record chunk with its printed line numbers inline, exactly as
 * the ingestion pipeline stores them. The phrase "ledger entries before the
 * hearing" straddles the break between line 1 and line 2.
 */
const TRANSCRIPT = [
  '110 1 THE COURT: the witness stated that she reviewed the ledger',
  '    2 entries before the hearing began that morning.',
  '    3 A Yes, that is correct.',
].join('\n');

// ───────────────────────────────────────────────────────────────────────────
// Task #17 — line-number-tolerant matching
// ───────────────────────────────────────────────────────────────────────────

describe('scan_for_pattern — a phrase spanning a printed line number', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  const transcriptCorpus = () =>
    rows([
      TRANSCRIPT,
      'Counsel referenced the ledger exhibit before the afternoon recess.',
      'The reporter certified the volume as a complete record.',
    ]);

  it('finds a phrase broken by a line number and whitespace', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, {
      pattern: '[Tt]he ledger entries before the hearing',
      limit: 20,
    });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].text).toContain('ledger');
  });

  it('returns the strict answer when linePermissive is false', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, {
      pattern: '[Tt]he ledger entries before the hearing',
      linePermissive: false,
      limit: 20,
    });

    expect(res.results).toHaveLength(0);
  });

  it('says in warnings that a returned match crossed a line boundary', async () => {
    const h = makeHarness(transcriptCorpus());
    const res: any = await run(tool, h, {
      pattern: '[Tt]he ledger entries before the hearing',
      limit: 20,
    });

    expect(res.warnings.join(' ')).toMatch(/line/i);
  });

  it('does not let `the court` match `thecourt`', async () => {
    // The v10 report's proposed expression made whitespace optional. That
    // manufactures the exact false-positive class task #16 exists to remove.
    const h = makeHarness(
      rows([
        'The clerk noted thecourt reporter had not yet arrived.',
        'A second row about the reporter and the exhibit list.',
      ]),
    );
    const res: any = await run(tool, h, { pattern: '\\bthe court\\b', limit: 20 });

    expect(res.results).toHaveLength(0);
  });

  it('does not substitute a space that a quantifier applies to', async () => {
    // `ledger ?closed` means "optional space". Rewriting that space into a
    // mandatory whitespace run would silently change what the caller asked for.
    const h = makeHarness(
      rows(['The ledgerclosed shorthand appears in the ledger index for that year.']),
    );
    const res: any = await run(tool, h, { pattern: 'ledger ?closed', limit: 20 });

    expect(res.results).toHaveLength(1);
  });

  it('does not substitute a space inside a character class', async () => {
    const h = makeHarness(
      rows([
        'The court granted the motion in part and denied it in part.',
        'The clerk noted thecourt reporter had not yet arrived.',
      ]),
    );
    const res: any = await run(tool, h, { pattern: '[Tt]he[ ]court', limit: 20 });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].text).toContain('granted');
  });

  it('leaves a digit quantifier alone', async () => {
    const h = makeHarness(
      rows([
        'The order was signed on 2024 in the presence of counsel.',
        'No numeric reference appears in this row at all.',
      ]),
    );
    const res: any = await run(tool, h, { pattern: '\\d{4}', limit: 20 });

    expect(res.results).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task #16 — verify the phrase, or say you did not
// ───────────────────────────────────────────────────────────────────────────

describe('scan_for_pattern — a returned row contains the pattern', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  /** Every word of the target phrase appears; the phrase itself never does. */
  const bagOfWordsCorpus = () =>
    rows([
      'The witness reviewed the exhibit and the ledger before the recess.',
      'Counsel produced ledger entries for the quarter under review.',
      'The reporter certified the volume; entries were read into the record.',
      'A schedule of disbursements accompanied the accounting statement.',
    ]);

  const ABSENT_PHRASE = 'the witness reviewed the ledger entries';

  it('returns no rows for a phrase that appears nowhere in that exact form', async () => {
    const h = makeHarness(bagOfWordsCorpus());
    const res: any = await run(tool, h, { pattern: ABSENT_PHRASE, limit: 20 });

    expect(res.results).toHaveLength(0);
  });

  it('says why, rather than returning an unqualified empty page', async () => {
    const h = makeHarness(bagOfWordsCorpus());
    const res: any = await run(tool, h, { pattern: ABSENT_PHRASE, limit: 20 });

    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('returns the row for a phrase that IS present in that exact form', async () => {
    const h = makeHarness(bagOfWordsCorpus());
    const res: any = await run(tool, h, {
      pattern: 'produced ledger entries for the quarter',
      limit: 20,
    });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].match.toLowerCase()).toBe('produced ledger entries for the quarter');
  });

  it('never returns an unverified row under `warnings: []`', async () => {
    // The core invariant. `warnings: []` is documented as "the answer is
    // believed complete"; an empty array over bag-of-words rows asserts that a
    // set of non-matches is a good answer.
    const patterns = [
      ABSENT_PHRASE,
      'produced ledger entries for the quarter',
      'ledger',
      '\\bledger\\b|\\bentries\\b',
      '[Ll]edger entries',
    ];

    for (const pattern of patterns) {
      const h = makeHarness(bagOfWordsCorpus());
      const res: any = await run(tool, h, { pattern, limit: 20 });
      if (res.warnings.length > 0) continue;

      const re = new RegExp(pattern, 'i');
      for (const row of res.results) {
        expect({ pattern, text: row.text, contains: re.test(row.text) }).toEqual({
          pattern,
          text: row.text,
          contains: true,
        });
      }
    }
  });

  it('restores bag-of-words rows under mode: "keyword", and labels them unverified', async () => {
    const h = makeHarness(bagOfWordsCorpus());
    const res: any = await run(tool, h, {
      pattern: ABSENT_PHRASE,
      mode: 'keyword',
      limit: 20,
    });

    expect(res.results.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).toMatch(/not verified|unverified/i);
  });

  it('declares every parameter it honours in its inputSchema', () => {
    // The tool rejects undeclared top-level params (`rejectsUnknownParams`),
    // and that check reads the schema — not the TypeScript interface. A param
    // implemented but undeclared is INVALID_PARAMS on the live MCP path while
    // every executeImpl test stays green.
    const declared = Object.keys(tool.getMetadata().inputSchema?.properties ?? {});
    for (const p of ['pattern', 'caseId', 'caseIds', 'limit', 'cursor', 'whereClauses',
                     'mode', 'linePermissive', 'fold']) {
      expect(declared).toContain(p);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task #18 — fold quotes, dashes and diacritics before comparing
// ───────────────────────────────────────────────────────────────────────────

describe('scan_for_pattern — folding quotes, dashes and diacritics', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  /** Both transliterations of an invented name, as different filings spell it. */
  const foldCorpus = () =>
    rows([
      'The exhibit was authenticated by Anaïs Verrell on the record.',
      'The exhibit was authenticated by Anais Verrell in the later filing.',
      "Counsel stated that the trustee didn't produce the ledger.",
      'The witness described a cost—benefit review of the account.',
    ]);

  it('finds the straight-apostrophe corpus form from a curly-apostrophe pattern', async () => {
    const h = makeHarness(foldCorpus());
    const res: any = await run(tool, h, { pattern: 'didn’t produce the ledger', limit: 20 });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].text).toContain("didn't");
  });

  it('finds both spellings of a name, from either spelling', async () => {
    const plain: any = await run(tool, makeHarness(foldCorpus()), {
      pattern: 'Anais Verrell',
      limit: 20,
    });
    const accented: any = await run(tool, makeHarness(foldCorpus()), {
      pattern: 'Anaïs Verrell',
      limit: 20,
    });

    expect(plain.results).toHaveLength(2);
    expect(accented.results).toHaveLength(2);
  });

  it('finds an em-dash in the corpus from a hyphen in the pattern', async () => {
    const h = makeHarness(foldCorpus());
    const res: any = await run(tool, h, { pattern: 'cost-benefit review', limit: 20 });

    expect(res.results).toHaveLength(1);
  });

  it('returns raw text and a raw match, never the folded form', async () => {
    const h = makeHarness(foldCorpus());
    const res: any = await run(tool, h, { pattern: 'Anais Verrell', limit: 20 });

    const accentedRow = res.results.find((r: any) => r.text.includes('ï'));
    expect(accentedRow).toBeDefined();
    // The offset map is what makes this true: folding NFKD-decomposes, so a
    // naive slice of the raw text at folded offsets cites the wrong span.
    expect(accentedRow.match).toBe('Anaïs Verrell');
  });

  it('folds the snippet fallback too, so an unverified keyword row still shows a match', async () => {
    // mode: "keyword" leaves the regex unmatched, so `match` comes from the
    // keyword fallback. That fallback must know the same spellings recall does.
    const h = makeHarness(foldCorpus());
    const res: any = await run(tool, h, {
      pattern: 'Anais Verrell testified',
      mode: 'keyword',
      limit: 20,
    });

    const accentedRow = res.results.find((r: any) => r.text.includes('\u00ef'));
    expect(accentedRow).toBeDefined();
    expect(accentedRow.match).toBe('Ana\u00efs');
  });

  it('keeps exact-glyph behaviour under fold: false', async () => {
    const h = makeHarness(foldCorpus());
    const res: any = await run(tool, h, {
      pattern: 'Anais Verrell',
      fold: false,
      limit: 20,
    });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].text).not.toContain('ï');
  });
});

describe('scan_for_pattern — a verified page still obeys the paging contract', () => {
  let tool: ScanForPatternTool;
  beforeEach(() => {
    tool = new ScanForPatternTool();
  });

  it('escalates rather than ending a capped, fully-filtered phrase page with no cursor', async () => {
    // limit 2 → fetchLimit 10, and 12 rows carry `ledger`, so the pool caps.
    // The phrase itself sits past the cap. Before verification this page came
    // back full of decoys; now it must not come back empty and cursor-free.
    const decoys = Array.from(
      { length: 12 },
      (_, i) => `Entry ${i} references the ledger without any further action.`,
    );
    const matching = ['The ledger was closed before the accounting period ended.'];
    const h = makeHarness(rows([...decoys, ...matching]));

    const res: any = await run(tool, h, { pattern: 'ledger was closed', limit: 2 });

    const looksComplete = res.results.length === 0 && !res.nextCursor && res.strategy === 'fts+regex';
    expect(looksComplete).toBe(false);
    expect(res.strategy).toBe('full-scan');
    expect(res.results).toHaveLength(1);
  });

  it('is loud, not silent, when a phrase yields only stopword keywords', async () => {
    // Documented residual hole: strategy selection still keys off
    // `looksLikeRegex`, so a plain phrase whose every keyword is a stopword
    // does NOT escalate to a full scan. It must therefore never read as a
    // proven absence.
    const h = makeHarness(rows(['The witness was not present when the order was signed.']));
    const res: any = await run(tool, h, { pattern: 'the was not', limit: 20 });

    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).not.toMatch(/proven|exhaustive/i);
  });
});
