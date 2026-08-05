import { computeReadiness } from '../score';
import type { ReadinessSignals } from '../types';

/** A clean 10-page e-filed text PDF — should score at the text-pdf baseline (90). */
function cleanSignals(overrides: Partial<ReadinessSignals> = {}): ReadinessSignals {
  return {
    pageCount: 10,
    pagesWithText: 10,
    gapPages: [],
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
    ...overrides,
  };
}

describe('computeReadiness', () => {
  it('scores a clean text PDF at the text-pdf baseline with HIGH band and no warnings', () => {
    const result = computeReadiness(cleanSignals());
    expect(result.score).toBe(90);
    expect(result.band).toBe('HIGH');
    expect(result.formatClass).toBe('text-pdf');
    expect(result.warnings).toHaveLength(0);
  });

  describe('penalties in isolation', () => {
    it('parse errors: −12 each, capped at −30 (2 vs 3 vs 4 errors)', () => {
      expect(computeReadiness(cleanSignals({ parseErrorCount: 2 })).score).toBe(90 - 24);
      expect(computeReadiness(cleanSignals({ parseErrorCount: 3 })).score).toBe(90 - 30);
      expect(computeReadiness(cleanSignals({ parseErrorCount: 4 })).score).toBe(90 - 30);
    });

    it('missing pages: −4 each, capped at −38', () => {
      const two = computeReadiness(cleanSignals({ gapPages: [3, 7], pagesWithText: 8 }));
      expect(two.score).toBe(90 - 8);
      const many = computeReadiness(
        cleanSignals({
          pageCount: 30,
          pagesWithText: 15,
          gapPages: Array.from({ length: 15 }, (_, i) => i + 1),
          chunkCount: 40,
        }),
      );
      // 15 × 4 = 60 → capped at 38
      expect(many.score).toBe(90 - 38);
      expect(many.warnings.map((w) => w.code)).toContain('MISSING_PAGE');
    });

    it('repeated content: −8', () => {
      expect(computeReadiness(cleanSignals({ repeatedContent: true })).score).toBe(90 - 8);
    });

    it('token bloat: −8', () => {
      expect(computeReadiness(cleanSignals({ tokenBloat: true })).score).toBe(90 - 8);
    });

    it('no headings on multipage: −6', () => {
      expect(computeReadiness(cleanSignals({ pagesWithHeadings: 0 })).score).toBe(90 - 6);
    });

    it('no headings NOT penalized on single-page documents', () => {
      const result = computeReadiness(
        cleanSignals({ pageCount: 1, pagesWithText: 1, pagesWithHeadings: 0, chunkCount: 3, totalChars: 2_000 }),
      );
      expect(result.warnings.map((w) => w.code)).not.toContain('NO_HEADINGS');
    });

    it('glyph artifacts: −25 with critical warning listing pages', () => {
      const result = computeReadiness(cleanSignals({ glyphArtifactPages: [2, 5] }));
      expect(result.score).toBe(90 - 25);
      const warning = result.warnings.find((w) => w.code === 'GLYPH_ARTIFACTS');
      expect(warning?.severity).toBe('critical');
      expect(warning?.pages).toEqual([2, 5]);
    });

    it('low chunk count: −10', () => {
      const result = computeReadiness(cleanSignals({ chunkCount: 3 }));
      expect(result.score).toBe(90 - 10);
      expect(result.warnings.map((w) => w.code)).toContain('LOW_CHUNK_COUNT');
    });
  });

  describe('suppression rules', () => {
    it('OCR_REQUIRED suppresses NEAR_EMPTY_OUTPUT', () => {
      // 10 image-only pages, almost no text: near-empty would fire, but OCR_REQUIRED explains it.
      const result = computeReadiness(
        cleanSignals({
          imageOnlyPages: 10,
          ocrPages: 10,
          totalChars: 100,
          meanExtractDensity: 0,
          chunkCount: 5,
          meanOcrConfidence: 90,
        }),
      );
      const codes = result.warnings.map((w) => w.code);
      expect(codes).toContain('OCR_REQUIRED');
      expect(codes).not.toContain('NEAR_EMPTY_OUTPUT');
    });

    it('OCR_REQUIRED suppresses LOW_TEXT_DENSITY', () => {
      const result = computeReadiness(
        cleanSignals({ imageOnlyPages: 3, ocrPages: 3, meanExtractDensity: 100 }),
      );
      const codes = result.warnings.map((w) => w.code);
      expect(codes).toContain('OCR_REQUIRED');
      expect(codes).not.toContain('LOW_TEXT_DENSITY');
    });

    it('NEAR_EMPTY_OUTPUT and LOW_TEXT_DENSITY fire when no OCR is involved', () => {
      const nearEmpty = computeReadiness(
        cleanSignals({ totalChars: 100, meanExtractDensity: 10 }),
      );
      expect(nearEmpty.warnings.map((w) => w.code)).toContain('NEAR_EMPTY_OUTPUT');
      const lowDensity = computeReadiness(cleanSignals({ meanExtractDensity: 100 }));
      expect(lowDensity.warnings.map((w) => w.code)).toContain('LOW_TEXT_DENSITY');
    });
  });

  describe('OCR_REQUIRED scaling', () => {
    it('scales with image-only fraction (up to −40)', () => {
      const half = computeReadiness(
        cleanSignals({ imageOnlyPages: 5, ocrPages: 5, meanOcrConfidence: 90 }),
      );
      // mixed baseline 80 − 40×0.5 = 60
      expect(half.formatClass).toBe('mixed');
      expect(half.score).toBe(80 - 20);
    });
  });

  describe('format-class baselines', () => {
    it('classifies image-only documents with no text at 45', () => {
      const result = computeReadiness(
        cleanSignals({
          pagesWithText: 0,
          imageOnlyPages: 10,
          ocrPages: 0,
          totalChars: 0,
          meanExtractDensity: 0,
          chunkCount: 0,
          gapPages: Array.from({ length: 10 }, (_, i) => i + 1),
          pagesWithHeadings: 0,
        }),
      );
      expect(result.formatClass).toBe('image-only');
      expect(result.band).toBe('POOR');
    });

    it('classifies confident scans as scanned-clean (72) and low-confidence as scanned-degraded (62)', () => {
      const clean = computeReadiness(
        cleanSignals({ imageOnlyPages: 8, ocrPages: 8, meanOcrConfidence: 92 }),
      );
      expect(clean.formatClass).toBe('scanned-clean');
      const degraded = computeReadiness(
        cleanSignals({ imageOnlyPages: 8, ocrPages: 8, meanOcrConfidence: 55 }),
      );
      expect(degraded.formatClass).toBe('scanned-degraded');
      expect(clean.baseline - degraded.baseline).toBe(10);
    });
  });

  describe('clamping', () => {
    it('never goes below 0 when every penalty stacks', () => {
      const result = computeReadiness(
        cleanSignals({
          pagesWithText: 2,
          imageOnlyPages: 10,
          ocrPages: 2,
          gapPages: [1, 2, 3, 4, 5, 6, 7, 8],
          parseErrorCount: 5,
          totalChars: 50,
          meanExtractDensity: 5,
          chunkCount: 0,
          pagesWithHeadings: 0,
          glyphArtifactPages: [1],
          repeatedContent: true,
          tokenBloat: true,
          meanOcrConfidence: 30,
        }),
      );
      expect(result.score).toBe(0);
      expect(result.band).toBe('POOR');
    });

    it('never exceeds 100', () => {
      expect(computeReadiness(cleanSignals()).score).toBeLessThanOrEqual(100);
    });
  });

  describe('bands', () => {
    it('maps scores to bands at the documented thresholds', () => {
      expect(computeReadiness(cleanSignals()).band).toBe('HIGH'); // 90
      expect(computeReadiness(cleanSignals({ tokenBloat: true, repeatedContent: true })).band).toBe('OK'); // 74
      expect(computeReadiness(cleanSignals({ glyphArtifactPages: [1], tokenBloat: true })).band).toBe('RISKY'); // 57
      expect(computeReadiness(cleanSignals({ glyphArtifactPages: [1], parseErrorCount: 3 })).band).toBe('POOR'); // 35
    });
  });
});
