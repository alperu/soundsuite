/**
 * @jest-environment node
 *
 * A page must never produce zero chunks when it has text.
 *
 * The structural dedup is deliberate — a heading sets context and is not
 * re-emitted as body, and `signature` blocks are excluded as furniture. Both
 * are correct for a page that also carries prose. On a page that has ONLY
 * those, they combine to emit nothing, the page is unindexable, and the Fix
 * Partial repair loop reports three times over:
 *
 *   "Re-embedded successfully but the page still did not appear in the index"
 *
 * …before giving up. No amount of re-embedding can fix a page with no chunks.
 *
 * The fixtures below are the SHAPES observed on 2026-09-16 in two real
 * documents (4 pages total), rewritten with invented content:
 *   · exhibit tab separator — heading + one descriptive line (159-244 chars)
 *   · signature page — signature blocks only (~58 chars)
 *   · dotted table of contents
 *
 * See docs/tasks/49-heading-only-pages-never-chunk.md.
 */

import { StructuredChunker } from '../structured-chunker';

type Block = { type: string; text: string; order: number; bbox?: [number, number, number, number] };

function page(blocks: Block[], pageNumber = 1) {
  return { pageNumber, blocks: blocks.map(b => ({ bbox: undefined, ...b })) };
}

/** chunkStructuredPage is private; exercise it the way the pipeline does. */
function chunkPage(blocks: Block[]) {
  const chunker = new StructuredChunker({} as never);
  const fn = (chunker as unknown as {
    chunkStructuredPage: (p: unknown, d: string, c: string, s: string) => Array<{ text: string; metadata: { blockType?: string } }>;
  }).chunkStructuredPage.bind(chunker);
  return fn(page(blocks), 'doc-1', 'case-1', '');
}

describe('pages that would otherwise emit nothing', () => {
  it('indexes an exhibit tab separator — heading plus one descriptive line', () => {
    // The description names what the exhibit PROVES, so losing the page loses
    // the only searchable statement of that fact.
    const chunks = chunkPage([
      { type: 'heading', text: 'TAB C', order: 0 },
      { type: 'heading', text: 'Sworn Declaration of Appellant, filed 20 June, establishing the governing foreign law', order: 1 },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('TAB C');
    expect(chunks[0].text).toContain('Sworn Declaration');
    expect(chunks[0].metadata.blockType).toBe('page_fallback');
  });

  it('indexes a signature-only page', () => {
    const chunks = chunkPage([
      { type: 'signature', text: '_________________________________', order: 0 },
      { type: 'signature', text: 'A. Party, Pro Se', order: 1 },
    ]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('A. Party, Pro Se');
    expect(chunks[0].metadata.blockType).toBe('page_fallback');
  });

  it('indexes a dotted table of contents', () => {
    const chunks = chunkPage([
      { type: 'heading', text: 'TABLE OF CONTENTS', order: 0 },
      { type: 'page_number', text: 'i', order: 1 },
    ]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('TABLE OF CONTENTS');
  });

  it('emits NOTHING for a genuinely empty page — a blank page is not a defect', () => {
    expect(chunkPage([])).toHaveLength(0);
    expect(chunkPage([{ type: 'page_number', text: '   ', order: 0 }])).toHaveLength(0);
  });
});

describe('the fallback does not fire when real content exists', () => {
  it('a heading plus prose emits prose only, with the heading as context', () => {
    const chunks = chunkPage([
      { type: 'heading', text: 'II. ARGUMENT', order: 0 },
      { type: 'paragraph', text: 'The motion should be denied for the reasons that follow.', order: 1 },
    ]);
    // Exactly the pre-existing behaviour: one prose chunk, not prose + a
    // duplicate fallback. Firing both would double-index the page.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.blockType).toBe('paragraph');
    expect(chunks[0].text).toContain('II. ARGUMENT');
    expect(chunks[0].text).toContain('should be denied');
  });

  it('a signature block alongside prose is still excluded from the prose chunk', () => {
    const chunks = chunkPage([
      { type: 'paragraph', text: 'Respectfully submitted.', order: 0 },
      { type: 'signature', text: 'A. Party, Pro Se', order: 1 },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.blockType).toBe('paragraph');
    // Furniture stays out when there is prose to carry the page.
    expect(chunks[0].text).not.toContain('Pro Se');
  });
});
