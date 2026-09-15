/**
 * @jest-environment node
 *
 * Unit tests for the "Fix Partial" repair bookkeeping stored on
 * `Document.tags.repair`.
 *
 * The point of this module is that re-embedding a page is NOT guaranteed to
 * fix it: OCR that fails the quality gate yields no text, and an embedding
 * dimension mismatch fails every page in the batch the same way no matter how
 * often it is retried. Without a bound, a "fix" button becomes a loop that
 * reburns OCR/embedding cost forever and never tells the operator why. These
 * tests pin the bound (MAX_REPAIR_ATTEMPTS), the immediately-terminal
 * classification, and the fact that a page which actually got fixed has its
 * history cleared.
 *
 * Every function here is pure — no I/O, no DB, no network — so the suite needs
 * no mocks beyond an injected clock. Fixtures are synthetic (CLAUDE.md
 * § Privacy): invented ids, placeholder cause numbers, generic titles.
 */

import {
  MAX_REPAIR_ATTEMPTS,
  RepairReasonCode,
  RepairTags,
  classifyRepairFailure,
  isImmediatelyTerminal,
  mergeRepairTags,
  partitionEligiblePages,
  readRepairTags,
  updateRepairTags,
} from '../repair-tracking';

/** Injectable clock for deterministic `lastAttemptAt` assertions. */
const clockAt = (iso: string) => () => new Date(iso);

const T1 = '2024-01-01T00:00:00.000Z';
const T2 = '2024-01-02T00:00:00.000Z';
const T3 = '2024-01-03T00:00:00.000Z';

const ALWAYS_UNKNOWN = () => ({ code: 'unknown' as RepairReasonCode, reason: 'still unindexed' });
const ALWAYS_OCR_EMPTY = () => ({ code: 'ocr-empty' as RepairReasonCode, reason: 'no text' });
const ALWAYS_DIMENSION = () => ({
  code: 'dimension-mismatch' as RepairReasonCode,
  reason: 'width mismatch',
});

describe('MAX_REPAIR_ATTEMPTS', () => {
  it('is 3 — the bound the UI copy and the retry loop are written against', () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
  });
});

describe('readRepairTags', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'CAUSE NO. 00-0000-XX'],
    ['a number', 42],
    ['a boolean', true],
  ])('returns an empty map for %s', (_label, input) => {
    expect(readRepairTags(input)).toEqual({});
  });

  it('returns an empty map when the tags blob has no repair key', () => {
    expect(readRepairTags({ recordStatus: 'draft' })).toEqual({});
  });

  it.each([
    ['null', null],
    ['a string', 'corrupted'],
    ['zero', 0],
  ])('returns an empty map when tags.repair is %s', (_label, repair) => {
    expect(readRepairTags({ repair })).toEqual({});
  });

  it('returns the repair map when present', () => {
    const repair = { '7': { attempts: 2, lastAttemptAt: T1, terminal: false } };
    expect(readRepairTags({ recordStatus: 'final', repair })).toEqual(repair);
  });

  it('DOCUMENTED GAP: an array at tags.repair passes the typeof check and is returned unvalidated', () => {
    // `typeof [] === 'object'`, and there is no per-entry validation, so a
    // corrupted blob comes back as-is rather than being rejected.
    const repair: unknown[] = [];
    expect(readRepairTags({ repair })).toBe(repair);
  });

  it('returns the live reference, not a defensive copy — callers must not mutate it in place', () => {
    const repair = { '7': { attempts: 1, lastAttemptAt: T1 } };
    const tags = { repair };
    expect(readRepairTags(tags)).toBe(repair);
  });
});

describe('mergeRepairTags', () => {
  it('preserves unrelated tag keys such as draft-detection\'s recordStatus', () => {
    const existing = { recordStatus: 'draft', reviewedBy: 'analyst-1' };
    const merged = mergeRepairTags(existing, { '3': { attempts: 1, lastAttemptAt: T1 } });

    expect(merged).toEqual({
      recordStatus: 'draft',
      reviewedBy: 'analyst-1',
      repair: { '3': { attempts: 1, lastAttemptAt: T1 } },
    });
  });

  it('replaces the repair key wholly rather than deep-merging it', () => {
    const existing = {
      repair: {
        '3': { attempts: 2, lastAttemptAt: T1 },
        '9': { attempts: 1, lastAttemptAt: T1 },
      },
    };

    const merged = mergeRepairTags(existing, { '3': { attempts: 3, lastAttemptAt: T2 } });

    // Page 9's old entry is gone: the caller always passes the full new map.
    expect(merged.repair).toEqual({ '3': { attempts: 3, lastAttemptAt: T2 } });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-an-object'],
  ])('treats %s existing tags as an empty blob', (_label, existing) => {
    expect(mergeRepairTags(existing, {})).toEqual({ repair: {} });
  });

  it('does not mutate the tags blob it was given', () => {
    const existing = { recordStatus: 'draft' };
    const merged = mergeRepairTags(existing, { '3': { attempts: 1, lastAttemptAt: T1 } });

    expect(existing).toEqual({ recordStatus: 'draft' });
    expect(merged).not.toBe(existing);
  });
});

describe('classifyRepairFailure', () => {
  it('classifies a dimension-mismatch error and explains that reindexing cannot fix it', () => {
    const { code, reason } = classifyRepairFailure({
      requestError: 'Failed to insert chunks: vector dimension 2560 does not match 1024',
    });

    expect(code).toBe('dimension-mismatch');
    expect(reason).toMatch(/reindexing cannot fix this/i);
    expect(reason).toContain('2560');
  });

  it('matches the dimension signature case-insensitively', () => {
    expect(classifyRepairFailure({ requestError: 'DIMENSION width 2560' }).code).toBe(
      'dimension-mismatch',
    );
  });

  it('takes the dimension branch ahead of an OCR-empty signal on the same page', () => {
    expect(
      classifyRepairFailure({
        requestError: 'dimension mismatch',
        stillEmptyAfterOcr: true,
      }).code,
    ).toBe('dimension-mismatch');
  });

  it('classifies any other request failure as reindex-request-failed', () => {
    const { code, reason } = classifyRepairFailure({ requestError: 'HTTP 500 from reindex-pages' });

    expect(code).toBe('reindex-request-failed');
    expect(reason).toBe('Reindex request failed: HTTP 500 from reindex-pages');
  });

  it('prefers a request failure over an OCR-empty signal', () => {
    expect(
      classifyRepairFailure({ requestError: 'HTTP 500', stillEmptyAfterOcr: true }).code,
    ).toBe('reindex-request-failed');
  });

  it('classifies a page reported in the emptyPages array as ocr-empty', () => {
    const { code, reason } = classifyRepairFailure({ stillEmptyAfterOcr: true });

    expect(code).toBe('ocr-empty');
    expect(reason).toMatch(/OCR produced no text/i);
  });

  it('falls back to unknown when the request succeeded and the page was not reported empty', () => {
    const { code, reason } = classifyRepairFailure({});

    expect(code).toBe('unknown');
    expect(reason).toMatch(/still did not appear in the index/i);
  });

  it('treats an empty-string requestError as no error at all', () => {
    expect(classifyRepairFailure({ requestError: '', stillEmptyAfterOcr: true }).code).toBe(
      'ocr-empty',
    );
  });

  it('truncates a long error message to 200 characters plus an ellipsis', () => {
    // Filler deliberately avoids the substring "dimension" (which would route
    // this into the other branch) and any character in the reason prefix.
    const { reason } = classifyRepairFailure({ requestError: 'z'.repeat(250) });

    expect(reason).toBe(`Reindex request failed: ${'z'.repeat(200)}…`);
    expect(reason.match(/z/g)).toHaveLength(200);
  });

  it('does not truncate a message of exactly 200 characters', () => {
    const { reason } = classifyRepairFailure({ requestError: 'y'.repeat(200) });

    expect(reason).toBe(`Reindex request failed: ${'y'.repeat(200)}`);
    expect(reason.endsWith('…')).toBe(false);
  });
});

describe('isImmediatelyTerminal', () => {
  it.each<[RepairReasonCode, boolean]>([
    ['dimension-mismatch', true],
    ['ocr-empty', false],
    ['reindex-request-failed', false],
    ['unknown', false],
  ])('maps %s to %s', (code, expected) => {
    expect(isImmediatelyTerminal(code)).toBe(expected);
  });
});

describe('updateRepairTags', () => {
  it('records a first failure with attempts 1, the injected timestamp and the classifier reason', () => {
    const result = updateRepairTags({}, [5], new Set([5]), ALWAYS_OCR_EMPTY, clockAt(T1));

    expect(result.tags['5']).toEqual({
      attempts: 1,
      lastAttemptAt: T1,
      reasonCode: 'ocr-empty',
      reason: 'no text',
      terminal: false,
    });
    expect(result.retriable).toEqual([5]);
    expect(result.newlyTerminal).toEqual([]);
    expect(result.cleared).toEqual([]);
  });

  it('increments the attempt count of an existing entry rather than resetting it', () => {
    const existing: RepairTags = {
      '5': { attempts: 1, lastAttemptAt: T1, reasonCode: 'unknown', terminal: false },
    };

    const result = updateRepairTags(existing, [5], new Set([5]), ALWAYS_UNKNOWN, clockAt(T2));

    expect(result.tags['5'].attempts).toBe(2);
    expect(result.tags['5'].lastAttemptAt).toBe(T2);
    expect(result.tags['5'].terminal).toBe(false);
    expect(result.retriable).toEqual([5]);
  });

  it(`marks a page terminal on failure number ${MAX_REPAIR_ATTEMPTS}`, () => {
    const existing: RepairTags = {
      '5': { attempts: MAX_REPAIR_ATTEMPTS - 1, lastAttemptAt: T2, terminal: false },
    };

    const result = updateRepairTags(existing, [5], new Set([5]), ALWAYS_OCR_EMPTY, clockAt(T3));

    expect(result.tags['5'].attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(result.tags['5'].terminal).toBe(true);
    expect(result.newlyTerminal).toEqual([5]);
    expect(result.retriable).toEqual([]);
  });

  it('marks a dimension-mismatch terminal on the very first failure, so it is never retried', () => {
    const result = updateRepairTags({}, [5], new Set([5]), ALWAYS_DIMENSION, clockAt(T1));

    expect(result.tags['5'].attempts).toBe(1);
    expect(result.tags['5'].terminal).toBe(true);
    expect(result.newlyTerminal).toEqual([5]);

    // And the bound is never reached, because partitioning drops it first.
    const { eligible, terminal } = partitionEligiblePages([5], result.tags);
    expect(eligible).toEqual([]);
    expect(terminal).toEqual([{ page: 5, attempts: 1, reason: 'width mismatch' }]);
  });

  it('clears the history of a page that got fixed and reports it in `cleared`', () => {
    const existing: RepairTags = {
      '5': { attempts: 2, lastAttemptAt: T1, reasonCode: 'unknown', terminal: false },
      '9': { attempts: 1, lastAttemptAt: T1, reasonCode: 'unknown', terminal: false },
    };

    const result = updateRepairTags(existing, [5, 9], new Set([9]), ALWAYS_UNKNOWN, clockAt(T2));

    expect(result.tags['5']).toBeUndefined();
    expect(result.cleared).toEqual([5]);
    expect(result.tags['9'].attempts).toBe(2);
    expect(result.retriable).toEqual([9]);
  });

  it('does not report a page that succeeded with no prior history as cleared', () => {
    const result = updateRepairTags({}, [5], new Set(), ALWAYS_UNKNOWN, clockAt(T1));

    expect(result.cleared).toEqual([]);
    expect(result.tags).toEqual({});
  });

  it('only consults the classifier for pages that are still unindexed', () => {
    const reasonFor = jest.fn(ALWAYS_UNKNOWN);

    updateRepairTags({}, [1, 2, 3], new Set([2]), reasonFor, clockAt(T1));

    expect(reasonFor).toHaveBeenCalledTimes(1);
    expect(reasonFor).toHaveBeenCalledWith(2);
  });

  it('leaves the existing map untouched and returns a new one', () => {
    const existing: RepairTags = { '5': { attempts: 1, lastAttemptAt: T1, terminal: false } };
    const snapshot = JSON.parse(JSON.stringify(existing));

    const result = updateRepairTags(existing, [5], new Set([5]), ALWAYS_UNKNOWN, clockAt(T2));

    expect(existing).toEqual(snapshot);
    expect(result.tags).not.toBe(existing);
  });

  it('leaves entries for pages outside this attempt alone', () => {
    const existing: RepairTags = {
      '9': { attempts: 2, lastAttemptAt: T1, reasonCode: 'ocr-empty', terminal: false },
    };

    const result = updateRepairTags(existing, [5], new Set([5]), ALWAYS_UNKNOWN, clockAt(T2));

    expect(result.tags['9']).toEqual(existing['9']);
  });

  it('DOCUMENTED NAMING QUIRK: re-attempting an already-terminal page lists it in newlyTerminal again', () => {
    // `newlyTerminal` really means "terminal this round". The orchestrator is
    // expected to have filtered these out with partitionEligiblePages first.
    const existing: RepairTags = {
      '5': { attempts: MAX_REPAIR_ATTEMPTS, lastAttemptAt: T1, terminal: true },
    };

    const result = updateRepairTags(existing, [5], new Set([5]), ALWAYS_OCR_EMPTY, clockAt(T2));

    expect(result.tags['5'].attempts).toBe(MAX_REPAIR_ATTEMPTS + 1);
    expect(result.newlyTerminal).toEqual([5]);
  });

  it('returns empty buckets when no pages were attempted', () => {
    const result = updateRepairTags({}, [], new Set(), ALWAYS_UNKNOWN, clockAt(T1));

    expect(result).toEqual({ tags: {}, cleared: [], retriable: [], newlyTerminal: [] });
  });
});

describe('partitionEligiblePages', () => {
  it('treats pages with no repair history as eligible', () => {
    const { eligible, terminal } = partitionEligiblePages([1, 2, 3], {});

    expect(eligible).toEqual([1, 2, 3]);
    expect(terminal).toEqual([]);
  });

  it('keeps a page that failed but is still under the bound eligible', () => {
    const repair: RepairTags = {
      '2': { attempts: 1, lastAttemptAt: T1, reasonCode: 'unknown', terminal: false },
    };

    expect(partitionEligiblePages([1, 2], repair).eligible).toEqual([1, 2]);
  });

  it(`excludes a page exhausted by ${MAX_REPAIR_ATTEMPTS} real attempts, carrying its count and reason for the operator`, () => {
    // Round-trip through updateRepairTags rather than hand-writing the entry:
    // partitionEligiblePages reads only the `terminal` flag, so the exclusion
    // is only real if updateRepairTags actually set it.
    let repair: RepairTags = {};
    for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
      repair = updateRepairTags(repair, [47], new Set([47]), ALWAYS_OCR_EMPTY, clockAt(T1)).tags;
    }

    const { eligible, terminal } = partitionEligiblePages([47], repair);

    expect(eligible).toEqual([]);
    expect(terminal).toEqual([{ page: 47, attempts: MAX_REPAIR_ATTEMPTS, reason: 'no text' }]);
  });

  it('DOCUMENTED GAP: a legacy entry with attempts past the bound but no terminal flag stays eligible forever', () => {
    // The function never re-derives terminality from `attempts`. This is safe
    // only because updateRepairTags always writes the flag; a hand-written or
    // pre-existing entry is retried indefinitely.
    const repair: RepairTags = { '47': { attempts: 9, lastAttemptAt: T1 } };

    expect(partitionEligiblePages([47], repair).eligible).toEqual([47]);
  });

  it('preserves input order and does not deduplicate', () => {
    const repair: RepairTags = { '2': { attempts: 3, lastAttemptAt: T1, terminal: true } };

    const { eligible, terminal } = partitionEligiblePages([3, 1, 2, 1, 2], repair);

    expect(eligible).toEqual([3, 1, 1]);
    expect(terminal.map((t) => t.page)).toEqual([2, 2]);
  });

  it('reports a terminal page with no stored reason as undefined rather than crashing', () => {
    const repair: RepairTags = { '2': { attempts: 3, lastAttemptAt: T1, terminal: true } };

    expect(partitionEligiblePages([2], repair).terminal).toEqual([
      { page: 2, attempts: 3, reason: undefined },
    ]);
  });
});

describe('repair lifecycle (integration of the pure parts)', () => {
  it('retries an unfixable page up to the bound, then gives up with an explanation instead of looping', () => {
    // Synthetic document: "motion.pdf", CAUSE NO. 00-0000-XX, 4 pages, page 3
    // has no extractable text (OCR quality gate rejects the output).
    let tags: Record<string, unknown> = { recordStatus: 'final' };
    const unindexedPages = [3];
    let attemptsRun = 0;

    for (const stamp of [T1, T2, T3, T3]) {
      const repair = readRepairTags(tags);
      const { eligible } = partitionEligiblePages(unindexedPages, repair);
      if (eligible.length === 0) break;

      attemptsRun += 1;
      const result = updateRepairTags(
        repair,
        eligible,
        new Set(eligible), // the re-embed changed nothing
        () => classifyRepairFailure({ stillEmptyAfterOcr: true }),
        clockAt(stamp),
      );
      tags = mergeRepairTags(tags, result.tags);
    }

    expect(attemptsRun).toBe(MAX_REPAIR_ATTEMPTS);

    const { eligible, terminal } = partitionEligiblePages(unindexedPages, readRepairTags(tags));
    expect(eligible).toEqual([]);
    expect(terminal[0].page).toBe(3);
    expect(terminal[0].attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(terminal[0].reason).toMatch(/OCR produced no text/i);

    // Unrelated tags survived every round trip.
    expect(tags.recordStatus).toBe('final');
  });

  it('gives up immediately on a systemic dimension mismatch instead of burning the full budget', () => {
    let tags: Record<string, unknown> = {};
    const unindexedPages = [1, 2];
    let attemptsRun = 0;

    for (const stamp of [T1, T2, T3]) {
      const repair = readRepairTags(tags);
      const { eligible } = partitionEligiblePages(unindexedPages, repair);
      if (eligible.length === 0) break;

      attemptsRun += 1;
      const result = updateRepairTags(
        repair,
        eligible,
        new Set(eligible),
        () =>
          classifyRepairFailure({
            requestError: 'Failed to insert chunks: vector dimension 2560 does not match 1024',
          }),
        clockAt(stamp),
      );
      tags = mergeRepairTags(tags, result.tags);
    }

    expect(attemptsRun).toBe(1);
    const { eligible, terminal } = partitionEligiblePages(unindexedPages, readRepairTags(tags));
    expect(eligible).toEqual([]);
    expect(terminal.map((t) => t.attempts)).toEqual([1, 1]);
  });

  it('clears a page\'s history once a retry actually works, so it stops being reported', () => {
    let tags: Record<string, unknown> = { recordStatus: 'draft' };

    const firstRound = updateRepairTags(
      readRepairTags(tags),
      [3],
      new Set([3]),
      ALWAYS_UNKNOWN,
      clockAt(T1),
    );
    tags = mergeRepairTags(tags, firstRound.tags);
    expect(readRepairTags(tags)['3'].attempts).toBe(1);

    const secondRound = updateRepairTags(
      readRepairTags(tags),
      [3],
      new Set(), // page 3 is indexed now
      ALWAYS_UNKNOWN,
      clockAt(T2),
    );
    tags = mergeRepairTags(tags, secondRound.tags);

    expect(secondRound.cleared).toEqual([3]);
    expect(readRepairTags(tags)).toEqual({});
    expect(tags.recordStatus).toBe('draft');
  });
});
