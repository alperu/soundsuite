import { computeReadiness } from '../score';
import type { PageClassCounts, ReadinessSignals } from '../types';

function classCounts(partial: Partial<PageClassCounts> = {}): PageClassCounts {
  return { text: 0, textThin: 0, ocrHigh: 0, ocrMid: 0, ocrLow: 0, glyph: 0, missing: 0, ...partial };
}

/** A clean 10-page e-filed text PDF — Q = 95 with no penalties. */
function cleanSignals(overrides: Partial<ReadinessSignals> = {}): ReadinessSignals {
  return {
    pageCount: 10,
    pagesWithText: 10,
    gapPages: [],
    blankPages: [],
    ocrPages: 0,
    imageOnlyPages: 0,
    parseErrorCount: 0,
    totalChars: 20_000,
    meanExtractDensity: 2_000,
    meanOcrConfidence: null,
    chunkCount: 30,
    pagesWithHeadings: 6,
    glyphArtifactPages: [],
    repeatedContent: false,
    tokenBloat: false,
    isRecordCompilation: false,
    pageClassCounts: classCounts({ text: 10 }),
    ...overrides,
  };
}

describe('computeReadiness (v2 page-average model)', () => {
  it('scores a clean text PDF at the text-page quality (95) with HIGH band and no warnings', () => {
    const result = computeReadiness(cleanSignals());
    expect(result.score).toBe(95);
    expect(result.band).toBe('HIGH');
    expect(result.pageQuality).toBe(95);
    expect(result.warnings).toHaveLength(0);
  });

  describe('worked cases from the model design', () => {
    it('(a) 1403p record: 1083 text + 280 clean OCR + 38 glyph + 2 blank → 89 HIGH', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 1403,
          pagesWithText: 1363,
          blankPages: [1358, 1359],
          ocrPages: 280,
          imageOnlyPages: 280,
          meanOcrConfidence: 92,
          totalChars: 3_000_000,
          chunkCount: 10_000,
          pagesWithHeadings: 800,
          glyphArtifactPages: Array.from({ length: 38 }, (_, i) => i + 7),
          pageClassCounts: classCounts({ text: 1083, ocrHigh: 280, glyph: 38 }),
        }),
      );
      // Q = (1083×95 + 280×80) / 1401 = 89.43
      expect(result.score).toBe(89);
      expect(result.band).toBe('HIGH');
      // 38 glyph pages remain fully visible as an actionable warning...
      const glyph = result.warnings.find((w) => w.code === 'GLYPH_ARTIFACTS');
      expect(glyph).toBeDefined();
      // ...but at 2.7% of pages, severity is warning, not critical (no cap).
      expect(glyph?.severity).toBe('warning');
    });

    it('(b) 10p motion with 3 garbled pages stays RISKY — page-average does not dilute small docs', () => {
      const result = computeReadiness(
        cleanSignals({
          glyphArtifactPages: [2, 5, 7],
          pageClassCounts: classCounts({ text: 7, glyph: 3 }),
        }),
      );
      // Q = 7×95/10 = 66.5 → 67. Glyph pages score 0; 30% affected → critical.
      expect(result.score).toBe(67);
      expect(result.band).toBe('RISKY');
      expect(result.warnings.find((w) => w.code === 'GLYPH_ARTIFACTS')?.severity).toBe('critical');
    });

    it('(e) 50p clean scan at 93% OCR confidence → 80 OK (v1 scored this 32 POOR)', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 50,
          pagesWithText: 50,
          ocrPages: 50,
          imageOnlyPages: 50,
          meanOcrConfidence: 93,
          chunkCount: 120,
          pageClassCounts: classCounts({ ocrHigh: 50 }),
        }),
      );
      expect(result.score).toBe(80);
      expect(result.band).toBe('OK');
      // OCR cost is priced by the ladder, not double-penalized.
      expect(result.warnings.find((w) => w.code === 'OCR_REQUIRED')?.severity).toBe('info');
    });

    it('(f) one missing page in 1403 → integrity floor bites and the critical cap blocks HIGH', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 1403,
          pagesWithText: 1402,
          gapPages: [700],
          totalChars: 3_000_000,
          chunkCount: 10_000,
          pagesWithHeadings: 800,
          pageClassCounts: classCounts({ text: 1402, missing: 1 }),
        }),
      );
      // Q = 94.93; penalty = 10 + round(45×√(1/1403)) = 11 → 84, capped at 84 anyway.
      expect(result.score).toBe(84);
      expect(result.band).toBe('OK'); // one invisible page can never be HIGH
      expect(result.warnings.find((w) => w.code === 'MISSING_PAGE')?.severity).toBe('critical');
    });
  });

  describe('missing-page integrity curve', () => {
    it('floors at 10+ for a single gap and grows with √fraction', () => {
      const oneOfTen = computeReadiness(
        cleanSignals({
          pagesWithText: 9,
          gapPages: [10],
          pageClassCounts: classCounts({ text: 9, missing: 1 }),
        }),
      );
      // Q = 9×95/10 = 85.5; penalty = 10 + round(45×√0.1) = 24 → 62 (critical cap irrelevant)
      expect(oneOfTen.score).toBe(62);

      const threeOfTen = computeReadiness(
        cleanSignals({
          pagesWithText: 7,
          gapPages: [8, 9, 10],
          pageClassCounts: classCounts({ text: 7, missing: 3 }),
        }),
      );
      // Q = 66.5; penalty = 10 + round(45×√0.3) = 35 → 32 POOR
      expect(threeOfTen.score).toBe(32);
      expect(threeOfTen.band).toBe('POOR');
    });

    it('estimate-path gaps warn without penalizing (evidence cannot support a score change)', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 1403,
          pagesWithText: 1402,
          gapPages: [700],
          estimatedGaps: true,
          totalChars: 3_000_000,
          chunkCount: 10_000,
          pagesWithHeadings: 800,
          pageClassCounts: classCounts({ text: 1402, missing: 1 }),
        }),
      );
      expect(result.score).toBe(95); // round(94.93), no penalty, no critical cap
      const warning = result.warnings.find((w) => w.code === 'MISSING_PAGE');
      expect(warning?.severity).toBe('warning');
    });
  });

  describe('blank pages', () => {
    it('blank-vs-missing: same empty pages, opposite treatment', () => {
      const missing = computeReadiness(
        cleanSignals({
          pagesWithText: 8,
          gapPages: [9, 10],
          pageClassCounts: classCounts({ text: 8, missing: 2 }),
        }),
      );
      // Q = 76; penalty = 10 + round(45×√0.2) = 30 → 46 POOR
      expect(missing.score).toBe(46);
      expect(missing.warnings.find((w) => w.code === 'MISSING_PAGE')?.severity).toBe('critical');

      const blank = computeReadiness(
        cleanSignals({
          pagesWithText: 8,
          blankPages: [9, 10],
          pageClassCounts: classCounts({ text: 8 }),
        }),
      );
      expect(blank.score).toBe(95); // blanks excluded — 8/8 clean pages
      const note = blank.warnings.find((w) => w.code === 'BLANK_PAGES');
      expect(note?.severity).toBe('info');
      expect(note?.pages).toEqual([9, 10]);
      expect(blank.warnings.find((w) => w.code === 'MISSING_PAGE')).toBeUndefined();
    });

    it('all-blank document is a bad input, not a measurement', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 3,
          pagesWithText: 0,
          blankPages: [1, 2, 3],
          totalChars: 0,
          chunkCount: 0,
          pagesWithHeadings: 0,
          pageClassCounts: classCounts(),
        }),
      );
      expect(result.score).toBe(0);
      expect(result.band).toBe('POOR');
      expect(result.warnings.find((w) => w.code === 'NEAR_EMPTY_OUTPUT')?.severity).toBe('critical');
    });
  });

  describe('page-quality ladder', () => {
    it('thin text pages average at 70', () => {
      const result = computeReadiness(
        cleanSignals({ pageClassCounts: classCounts({ text: 5, textThin: 5 }) }),
      );
      expect(result.score).toBe(83); // (5×95 + 5×70)/10 = 82.5 → 83
    });

    it('OCR confidence tiers: high 80, mid 70, low 50', () => {
      const result = computeReadiness(
        cleanSignals({
          ocrPages: 10,
          imageOnlyPages: 10,
          pageClassCounts: classCounts({ ocrHigh: 4, ocrMid: 3, ocrLow: 3 }),
        }),
      );
      expect(result.score).toBe(68); // (320+210+150)/10 = 68
    });
  });

  describe('document-level integrity penalties', () => {
    it('repeated content: −8', () => {
      expect(computeReadiness(cleanSignals({ repeatedContent: true })).score).toBe(95 - 8);
    });

    it('repeated content: NOT penalized for record compilations, reported as info', () => {
      const result = computeReadiness(
        cleanSignals({ repeatedContent: true, isRecordCompilation: true }),
      );
      expect(result.score).toBe(95);
      expect(result.warnings.find((w) => w.code === 'REPEATED_CONTENT')?.severity).toBe('info');
    });

    it('token bloat: −8', () => {
      expect(computeReadiness(cleanSignals({ tokenBloat: true })).score).toBe(95 - 8);
    });

    it('no headings on multipage: −6', () => {
      expect(computeReadiness(cleanSignals({ pagesWithHeadings: 0 })).score).toBe(95 - 6);
    });

    it('low chunk count: −10', () => {
      const result = computeReadiness(cleanSignals({ chunkCount: 3 }));
      expect(result.score).toBe(95 - 10);
      expect(result.warnings.map((w) => w.code)).toContain('LOW_CHUNK_COUNT');
    });
  });

  describe('clamping and bands', () => {
    it('never goes below 0 when quality is 0 and penalties stack', () => {
      const result = computeReadiness(
        cleanSignals({
          pagesWithText: 0,
          gapPages: Array.from({ length: 10 }, (_, i) => i + 1),
          totalChars: 0,
          chunkCount: 0,
          pagesWithHeadings: 0,
          repeatedContent: true,
          tokenBloat: true,
          pageClassCounts: classCounts({ missing: 10 }),
        }),
      );
      expect(result.score).toBe(0);
      expect(result.band).toBe('POOR');
    });

    it('critical warnings cap the score below HIGH even at near-perfect quality', () => {
      const result = computeReadiness(
        cleanSignals({
          pageCount: 2000,
          pagesWithText: 1999,
          gapPages: [1000],
          totalChars: 4_000_000,
          chunkCount: 6_000,
          pagesWithHeadings: 900,
          pageClassCounts: classCounts({ text: 1999, missing: 1 }),
        }),
      );
      expect(result.score).toBeLessThanOrEqual(84);
      expect(result.band).not.toBe('HIGH');
    });
  });
});
