/**
 * RR block producer tests — PLAN-rr-structure item 3.
 * All fixtures are synthetic (invented names, placeholder content).
 */
import { buildRRBlocks, extractSpeaker } from '../rr-block-producer';
import type { RRLine } from '../pdf-parser';

const PAGE_H = 792;

/** Numbered transcript line at the standard RR geometry. */
function num(lineNumber: number, text: string): RRLine {
  return {
    lineNumber,
    text,
    x0: 72,
    x1: 540,
    y: 720 - (lineNumber - 1) * 26,
    height: 12,
  };
}

/** Unnumbered line (header/caption/footer). */
function plain(text: string, y: number): RRLine {
  return { lineNumber: null, text, x0: 72, x1: 300, y, height: 10 };
}

describe('extractSpeaker', () => {
  it('extracts colon-terminated speakers', () => {
    expect(extractSpeaker('THE COURT: Be seated.')).toBe('THE COURT');
    expect(extractSpeaker('MR. DOE: Objection, hearsay.')).toBe('MR. DOE');
    expect(extractSpeaker('MS. ROE-SMITH: Yes, Your Honor.')).toBe('MS. ROE-SMITH');
    expect(extractSpeaker('THE WITNESS: I do not recall.')).toBe('THE WITNESS');
  });

  it('extracts Q/A examination openers', () => {
    expect(extractSpeaker('Q.  Did you sign the agreement?')).toBe('Q');
    expect(extractSpeaker('A.  Yes.')).toBe('A');
    expect(extractSpeaker('Q.')).toBe('Q');
  });

  it('returns null for narrative lines', () => {
    expect(extractSpeaker('to the best of my recollection.')).toBeNull();
    expect(extractSpeaker('PROCEEDINGS')).toBeNull();
    expect(extractSpeaker('(Recess taken.)')).toBeNull();
    // Q/A must be "Q." — a sentence starting with "A " is not a turn.
    expect(extractSpeaker('A short recess was taken.')).toBeNull();
  });
});

describe('buildRRBlocks', () => {
  it('returns [] for empty input', () => {
    expect(buildRRBlocks([], PAGE_H)).toEqual([]);
  });

  it('emits a single page_header for pages without a number column', () => {
    const blocks = buildRRBlocks(
      [plain('CAUSE NO. 00-0000-XX', 700), plain('IN THE DISTRICT COURT', 670)],
      PAGE_H
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('page_header');
    expect(blocks[0].lines).toHaveLength(2);
    expect(blocks[0].lineStart).toBeUndefined();
  });

  it('segments speaker turns with lineStart/lineEnd and speaker labels', () => {
    const blocks = buildRRBlocks(
      [
        plain('42', 760), // page number header
        num(1, 'THE COURT: Good morning. Please'),
        num(2, 'be seated.'),
        num(3, 'MR. DOE: Thank you, Your Honor.'),
        num(4, 'Q.  State your name for the record.'),
        num(5, 'A.  Jane Roe.'),
      ],
      PAGE_H
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'page_header', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
    ]);
    const [, court, doe, q, a] = blocks;
    expect(court.speaker).toBe('THE COURT');
    expect(court.lineStart).toBe(1);
    expect(court.lineEnd).toBe(2);
    expect(court.text).toBe('THE COURT: Good morning. Please\nbe seated.');
    expect(doe.speaker).toBe('MR. DOE');
    expect(q.speaker).toBe('Q');
    expect(a.speaker).toBe('A');
    expect(a.lineStart).toBe(5);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts numbered lines before the first speaker into a speaker-less paragraph', () => {
    const blocks = buildRRBlocks(
      [
        num(1, 'PROCEEDINGS'),
        num(2, 'May 13, 2026'),
        num(3, 'THE COURT: We are on the record.'),
      ],
      PAGE_H
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].speaker).toBeUndefined();
    expect(blocks[0].lineStart).toBe(1);
    expect(blocks[0].lineEnd).toBe(2);
    expect(blocks[1].speaker).toBe('THE COURT');
  });

  it('keeps blank numbered lines in lines[] but not in block text', () => {
    const blocks = buildRRBlocks(
      [num(1, 'THE COURT: Off the record.'), num(2, ''), num(3, '(Recess.)')],
      PAGE_H
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[0].lines![1].text).toBe('');
    expect(blocks[0].lines![1].lineNumber).toBe(2);
    expect(blocks[0].lineEnd).toBe(3);
    expect(blocks[0].text).toBe('THE COURT: Off the record.\n(Recess.)');
  });

  it('emits trailing unnumbered lines as page_footer', () => {
    const blocks = buildRRBlocks(
      [num(1, 'THE COURT: Adjourned.'), plain('Veritext Reporting', 40)],
      PAGE_H
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe('page_footer');
  });

  it('converts bboxes to top-left origin (line 1 has the smallest y0)', () => {
    const blocks = buildRRBlocks(
      [num(1, 'THE COURT: First line.'), num(2, 'Second line.'), num(3, 'Third line.')],
      PAGE_H
    );
    const lines = blocks[0].lines!;
    const y0s = lines.map((l) => l.bbox![1]);
    expect(y0s[0]).toBeLessThan(y0s[1]);
    expect(y0s[1]).toBeLessThan(y0s[2]);
    // line 1: y=720, height=12 → top-left y0 = 792 - 732 = 60
    expect(lines[0].bbox).toEqual([72, 60, 540, 72]);
    // Block bbox is the union of line bboxes.
    expect(blocks[0].bbox).toEqual([72, 60, 540, 72 + 2 * 26]);
  });

  it('yields null bboxes when page height is unknown', () => {
    const blocks = buildRRBlocks([num(1, 'THE COURT: Hello.')], 0);
    expect(blocks[0].bbox).toBeNull();
    expect(blocks[0].lines![0].bbox).toBeNull();
  });
});
