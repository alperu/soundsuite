import { computeChunkScore, computePageScores, stripChunkArtifacts } from '../page-score';
import type { PageTextLike } from '../types';

function page(pageNumber: number, overrides: Partial<PageTextLike> = {}): PageTextLike {
  return {
    pageNumber,
    text: 'A perfectly ordinary page of legal text about the motion and the court order. '.repeat(10),
    textDensity: 800,
    source: 'extract',
    confidence: null,
    ...overrides,
  };
}

describe('computePageScores', () => {
  it('assigns ladder values by class and emits a row for every page', () => {
    const results = computePageScores({
      pages: [
        page(1),                                                        // text → 95
        page(2, { textDensity: 100 }),                                  // textThin → 70
        page(3, { source: 'ocr', confidence: 95 }),                     // ocrHigh → 80
        page(4, { source: 'ocr', confidence: 80 }),                     // ocrMid → 70
        page(5, { source: 'ocr', confidence: 60 }),                     // ocrLow → 50
        page(6),                                                        // glyph (via set) → 0
        page(7, { text: '', textDensity: 0 }),                          // missing → 0
        page(8, { text: '', textDensity: 0, source: 'empty' }),         // blank
        // page 9 absent entirely → missing
      ],
      totalPages: 9,
      glyphPages: new Set([6]),
      chunkCountByPage: new Map([[1, 3], [2, 1], [3, 2], [4, 1], [5, 1]]),
    });

    expect(results).toHaveLength(9);
    const byPage = new Map(results.map((r) => [r.pageNumber, r]));
    expect(byPage.get(1)).toMatchObject({ score: 95, pageClass: 'text', band: 'HIGH' });
    expect(byPage.get(2)).toMatchObject({ score: 70, pageClass: 'textThin' });
    expect(byPage.get(2)?.flags).toContain('LOW_TEXT_DENSITY');
    expect(byPage.get(3)).toMatchObject({ score: 80, pageClass: 'ocrHigh' });
    expect(byPage.get(4)).toMatchObject({ score: 70, pageClass: 'ocrMid' });
    expect(byPage.get(5)).toMatchObject({ score: 50, pageClass: 'ocrLow', band: 'RISKY' });
    expect(byPage.get(6)).toMatchObject({ score: 0, pageClass: 'glyph' });
    expect(byPage.get(6)?.flags).toContain('GLYPH_ARTIFACTS');
    expect(byPage.get(7)).toMatchObject({ score: 0, pageClass: 'missing' });
    expect(byPage.get(8)?.pageClass).toBe('blank');
    expect(byPage.get(9)).toMatchObject({ score: 0, pageClass: 'missing' });
    expect(byPage.get(9)?.flags).toContain('MISSING_PAGE');
  });

  it('caps text-bearing pages that produced zero chunks (invisible to retrieval)', () => {
    const results = computePageScores({
      pages: [page(1)],
      totalPages: 1,
      glyphPages: new Set(),
      chunkCountByPage: new Map(), // no chunks anywhere
    });
    expect(results[0].score).toBe(40);
    expect(results[0].flags).toContain('LOW_CHUNK_COUNT');
  });

  it('marks estimate-path rows with BACKFILL_ESTIMATE', () => {
    const results = computePageScores({
      pages: [page(1)],
      totalPages: 1,
      glyphPages: new Set(),
      chunkCountByPage: new Map([[1, 2]]),
      estimated: true,
    });
    expect(results[0].flags).toContain('BACKFILL_ESTIMATE');
    expect(results[0].score).toBe(95);
  });
});

describe('computeChunkScore', () => {
  const CLEAN_BODY =
    'The court considered the motion and the response of the parties and finds that the ' +
    'relief requested should be granted in part. The defendant shall produce the documents ' +
    'described in the request within fourteen days of the date of this order. '.repeat(3);

  it('inherits the page score for a clean chunk', () => {
    const { score, flags } = computeChunkScore({ pageScore: 95, text: CLEAN_BODY });
    expect(score).toBe(95);
    expect(flags).toHaveLength(0);
  });

  it('strips the injected context header before measuring', () => {
    const withHeader = `[Case: Something | Filing: Something] ${CLEAN_BODY}`;
    expect(stripChunkArtifacts(withHeader).startsWith('The court considered')).toBe(true);
    const { score } = computeChunkScore({ pageScore: 95, text: withHeader });
    expect(score).toBe(95);
  });

  it('clamps a chunk whose body is garbled even when its page scored well', () => {
    const garbled = Array.from({ length: 120 }, (_, i) => `(cid:${i})`).join(' ');
    const { score, flags } = computeChunkScore({ pageScore: 95, text: garbled });
    expect(score).toBe(40);
    expect(flags).toContain('GLYPH_ARTIFACTS');
  });

  it('penalizes runt chunks (page-number strips, stamp fragments)', () => {
    const { score, flags } = computeChunkScore({ pageScore: 95, text: 'Page 12' });
    expect(score).toBe(85);
    expect(flags).toContain('NEAR_EMPTY_OUTPUT');
  });

  it('never returns below 0', () => {
    const { score } = computeChunkScore({ pageScore: 5, text: 'Page 3' });
    expect(score).toBe(0);
  });
});
