import {
  countPagesWithHeadings,
  detectGlyphArtifacts,
  detectRepeatedContent,
  detectTokenBloat,
} from '../detectors';
import type { PageTextLike } from '../types';

function page(pageNumber: number, text: string, overrides: Partial<PageTextLike> = {}): PageTextLike {
  return {
    pageNumber,
    text,
    textDensity: text.trim().length,
    source: 'extract',
    confidence: null,
    ...overrides,
  };
}

const CLEAN_LEGAL_TEXT = `
IN THE DISTRICT COURT OF HARRIS COUNTY, TEXAS
CAUSE NO. 2024-12345

PLAINTIFF'S MOTION FOR SUMMARY JUDGMENT

TO THE HONORABLE JUDGE OF SAID COURT:

Plaintiff files this Motion for Summary Judgment pursuant to Rule 166a of the
Texas Rules of Civil Procedure and in support thereof would respectfully show
the Court as follows. The evidence attached to this motion establishes that
there is no genuine issue of material fact and that Plaintiff is entitled to
judgment as a matter of law. Defendant failed to respond to the requests for
admission served on January 15, and those matters are therefore deemed
admitted. The deemed admissions conclusively establish each element of the
claim for breach of contract, including the existence of a valid agreement,
performance by Plaintiff, breach by Defendant, and resulting damages in the
amount of forty-two thousand dollars. Wherefore, premises considered,
Plaintiff prays that the Court grant this Motion in all respects.
`.repeat(2);

describe('detectGlyphArtifacts', () => {
  it('fires on (cid:NNN) garbled pages via the replacement-ratio signal alone', () => {
    const garbled = Array.from({ length: 80 }, (_, i) => `(cid:${i}) (cid:${i + 3})`).join(' ');
    const finding = detectGlyphArtifacts([page(1, garbled)]);
    expect(finding.fired).toBe(true);
    expect(finding.pages).toEqual([1]);
    expect(finding.maxReplacementRatio).toBeGreaterThan(0.02);
  });

  it('fires on U+FFFD replacement-character runs', () => {
    const garbled = ('some words here ' + '�'.repeat(30)).repeat(20);
    const finding = detectGlyphArtifacts([page(1, garbled)]);
    expect(finding.fired).toBe(true);
  });

  it('fires on plausible-looking letter soup via dictionary + entropy agreement', () => {
    // Deterministic pseudo-random letters — no dictionary hits, flat bigram structure.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const soup = Array.from({ length: 400 }, () =>
      Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join(''),
    ).join(' ');
    const finding = detectGlyphArtifacts([page(1, soup)]);
    expect(finding.minDictRatio).toBeLessThan(0.25);
    expect(finding.fired).toBe(true);
  });

  it('does NOT fire on clean legal prose', () => {
    const finding = detectGlyphArtifacts([page(1, CLEAN_LEGAL_TEXT)]);
    expect(finding.fired).toBe(false);
    // Healthy legal prose must clear the 0.25 garbled threshold with real margin.
    expect(finding.minDictRatio).toBeGreaterThan(0.4);
  });

  it('skips OCR-sourced pages entirely', () => {
    const garbled = Array.from({ length: 80 }, (_, i) => `(cid:${i})`).join(' ');
    const finding = detectGlyphArtifacts([page(1, garbled, { source: 'ocr' })]);
    expect(finding.fired).toBe(false);
  });

  it('skips short pages (< 500 chars)', () => {
    const finding = detectGlyphArtifacts([page(1, '(cid:1) (cid:2) (cid:3)')]);
    expect(finding.fired).toBe(false);
  });
});

describe('detectRepeatedContent', () => {
  const HEADER = 'CAUSE NO. 2024-12345 — SMITH V. JONES';
  const FOOTER = 'Page 3 of 40 — Certified Copy';

  it('does NOT fire on legitimate per-page headers/footers (boilerplate exclusion)', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(
        i + 1,
        `${HEADER}\nUnique paragraph ${i} discussing the ${['contract', 'damages', 'notice', 'breach', 'reply', 'appeal', 'motion', 'order', 'exhibit', 'hearing'][i]} issue in detail with several distinct sentences of argument.\nAnother distinct line about topic ${i}.\n${FOOTER}`,
      ),
    );
    const finding = detectRepeatedContent(pages);
    expect(finding.fired).toBe(false);
  });

  it('fires when ≥3 pages are identical after normalization (render loop)', () => {
    const stuck = 'The extractor emitted this exact page content repeatedly.\nSecond line of the stuck page.';
    const pages = [page(1, stuck), page(2, stuck), page(3, stuck), page(4, 'A normal distinct page about the motion.')];
    const finding = detectRepeatedContent(pages);
    expect(finding.fired).toBe(true);
    expect(finding.identicalPageGroups).toBeGreaterThanOrEqual(1);
  });

  it('fires when duplicate lines dominate after boilerplate removal', () => {
    // Two pages: not enough page-frequency for boilerplate (threshold >80% of 4 pages),
    // but massive line-level duplication across them.
    const dupBlock = Array.from({ length: 20 }, (_, i) => `repeated assertion line variant ${i % 3}`).join('\n');
    const pages = [
      page(1, dupBlock),
      page(2, dupBlock),
      page(3, 'entirely unique content line one\nentirely unique content line two'),
      page(4, 'more unique content on the final page\nclosing line'),
    ];
    const finding = detectRepeatedContent(pages);
    expect(finding.duplicateFraction).toBeGreaterThan(0.3);
    expect(finding.fired).toBe(true);
  });

  it('never fires on single-page documents', () => {
    expect(detectRepeatedContent([page(1, 'anything')]).fired).toBe(false);
  });
});

describe('detectTokenBloat', () => {
  it('fires on per-character fragmented text', () => {
    const fragmented = 'T h i s   i s   a   f r a g m e n t e d   p a g e '.repeat(30);
    expect(detectTokenBloat([page(1, fragmented)])).toBe(true);
  });

  it('does NOT fire on clean prose', () => {
    expect(detectTokenBloat([page(1, CLEAN_LEGAL_TEXT)])).toBe(false);
  });

  it('does NOT fire on short documents (< 500 chars)', () => {
    expect(detectTokenBloat([page(1, 'a b c')])).toBe(false);
  });
});

describe('countPagesWithHeadings', () => {
  it('counts pages containing section headings or all-caps caption lines', () => {
    const withHeading = page(1, CLEAN_LEGAL_TEXT);
    const withoutHeading = page(2, 'just a plain paragraph of ordinary sentence text with nothing resembling a heading in it.');
    expect(countPagesWithHeadings([withHeading, withoutHeading])).toBe(1);
  });
});
