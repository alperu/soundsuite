import { buildCiteContext, citeOf, truncateBlock } from '../context-builder';
import { sourceDedupKey } from '../source-dedup';

const src = (text: string, page = 1, citation?: string) =>
  ({ text, document: 'doc-a', page, citation });

describe('buildCiteContext', () => {
  it('skips an oversized block and keeps later smaller ones (break→continue fix)', () => {
    const big = src('X'.repeat(900), 1);
    const small = src('small enough', 2);
    // perBlockCap large so the big block is NOT truncated, only over-budget
    const r = buildCiteContext([src('lead', 0), big, small], {
      maxTotalChars: 120,
      perBlockCap: 5000,
    });
    expect(r.contextBlock).toContain('lead');
    expect(r.contextBlock).toContain('small enough'); // old loops dropped this
    expect(r.contextBlock).not.toContain('XXXX');
    expect(r.skippedCount).toBe(1);
  });

  it('truncates blocks over the per-block cap into budget instead of losing them', () => {
    const r = buildCiteContext([src('A'.repeat(500))], {
      maxTotalChars: 400,
      perBlockCap: 100,
    });
    expect(r.usedCount).toBe(1);
    expect(r.truncatedCount).toBe(1);
    expect(r.contextBlock).toContain('…[truncated]');
  });

  it('reproduces the legacy block shape: [cite]\\ntext with separators', () => {
    const r = buildCiteContext([src('one', 1, 'C1'), src('two', 2, 'C2')], { maxTotalChars: 10_000 });
    expect(r.contextBlock).toBe('[C1]\none\n\n---\n[C2]\ntwo\n');
  });

  it('citeOf falls back citation → citationShort → document/page', () => {
    expect(citeOf({ text: '', document: 'D', page: 3 })).toBe('D, p.3');
    expect(citeOf({ text: '', document: 'D', page: 3, citationShort: 'S' })).toBe('S');
    expect(citeOf({ text: '', document: 'D', page: 3, citation: 'C', citationShort: 'S' })).toBe('C');
  });

  it('truncateBlock marks the cut', () => {
    expect(truncateBlock('abcdef', 3)).toEqual({ text: 'abc…[truncated]', truncated: true });
    expect(truncateBlock('ab', 3)).toEqual({ text: 'ab', truncated: false });
  });
});

describe('speaker attribution (phase 1d)', () => {
  it('renders delimited speakers as a cite-line suffix', () => {
    const r = buildCiteContext(
      [{ text: 'Q. And then?', document: 'vol2', page: 8, citation: 'C', speakers: '|THE COURT|MR. DOE|' }],
      { maxTotalChars: 10_000 },
    );
    expect(r.contextBlock).toBe('[C] (speakers: THE COURT, MR. DOE)\nQ. And then?\n');
  });

  it('omits the suffix when speakers is absent', () => {
    const r = buildCiteContext([src('plain', 1, 'C')], { maxTotalChars: 10_000 });
    expect(r.contextBlock).toBe('[C]\nplain\n');
  });
});

describe('draft record guard (citation marker)', () => {
  it('citeOf appends the DRAFT marker for draft sources only', () => {
    expect(citeOf({ ...src('t', 1, '2 CR 140'), recordStatus: 'draft' })).toBe('2 CR 140 — DRAFT, filing not confirmed');
    expect(citeOf({ ...src('t', 1, '2 CR 140'), recordStatus: 'filed' })).toBe('2 CR 140');
    expect(citeOf({ ...src('t', 1, '2 CR 140'), recordStatus: 'unknown' })).toBe('2 CR 140');
    expect(citeOf(src('t', 1, '2 CR 140'))).toBe('2 CR 140');
  });

  it('citeOf keeps the marker on the fallback label chain too', () => {
    expect(citeOf({ text: 't', document: 'motion.pdf', page: 4, recordStatus: 'draft' }))
      .toBe('motion.pdf, p.4 — DRAFT, filing not confirmed');
  });

  it('buildCiteContext renders the marker inside the bracketed cite line', () => {
    const r = buildCiteContext(
      [{ ...src('body', 1, '2 CR 140'), recordStatus: 'draft' }, src('other', 2, '2 CR 141')],
      { maxTotalChars: 10_000 },
    );
    expect(r.contextBlock).toBe('[2 CR 140 — DRAFT, filing not confirmed]\nbody\n\n---\n[2 CR 141]\nother\n');
  });
});

describe('sourceDedupKey', () => {
  it('distinguishes table fragments that share their first 100 chars', () => {
    const header = 'No. | Date | From | To | Snippet\n'.repeat(4); // >100 chars shared prefix
    const a = header + 'row group one';
    const b = header + 'row group two';
    expect(sourceDedupKey('d', 5, a)).not.toBe(sourceDedupKey('d', 5, b));
    expect(sourceDedupKey('d', 5, a)).toBe(sourceDedupKey('d', 5, a));
  });
});
