/**
 * StructuredChunker — block-aware chunking (PLAN-ss-docparse §6 + §6.2).
 *
 * ITextChunker drop-in that chunks structurally when a page carries
 * DocparseBlocks (set by the structure stage) and DELEGATES to the wrapped
 * chunker for pages without blocks. When no page has blocks the entire call
 * is delegated — byte-identical to today (§6.1 non-regression posture).
 *
 * §6.2 decisions implemented:
 *  - assembly: sacPrefix + headingContext + '\n' + body — the same shape
 *    the legacy chunker produces, with REAL headings instead of regex ones
 *  - budgets: prefix is SUBTRACTED from the body budget (fixes the legacy
 *    stacking bug); documentSummary bounded; headingContext capped with
 *    word-boundary middle truncation; the body is never shrunk to make room
 *  - furniture/seal/signature blocks are excluded from chunk text
 *  - tables are atomic up to TABLE_MAX_CHARS (their own ceiling — the prose
 *    cap would fragment real tables); beyond it they split on row boundaries
 *    with the header row repeated per fragment
 *  - dedup is structural: heading blocks set context and are not re-emitted
 *    as body, so a chunk never contains its own heading twice
 */

import type { Chunk, ChunkMetadata, Exhibit, ITextChunker, PageText, SacContext } from './text-chunker';
import type { DocparseBlock } from './docparse-types';
import { createLogger } from '../logger';

const logger = createLogger('StructuredChunker');

// Char budgets (≈ tokens × 4, matching the corpus convention)
const PROSE_MAX_CHARS = 1000;      // same hard cap as the legacy chunker
const TABLE_MAX_CHARS = 2048;      // §6.2 decision 5 — atomic-table ceiling
const HEADING_MAX_CHARS = 192;     // ≈ 48 tokens
const SUMMARY_MAX_CHARS = 160;     // ≈ 40 tokens
const MIN_BODY_BUDGET = 300;       // floor so a huge prefix can't starve the body

/** Word-boundary middle truncation: keeps both ends of a long heading. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  const head = s.slice(0, keep).replace(/\s+\S*$/, '');
  const tail = s.slice(-keep).replace(/^\S*\s+/, '');
  return `${head} … ${tail}`;
}

function sentenceSplit(text: string, budget: number): string[] {
  const sentences = text.split(/(?<=[.?!;:])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > budget) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
    // pathological sentence longer than the budget: hard-wrap
    while (cur.length > budget) {
      out.push(cur.slice(0, budget));
      cur = cur.slice(budget);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export class StructuredChunker implements ITextChunker {
  constructor(private inner: ITextChunker) {}

  async chunkPages(
    pages: PageText[],
    documentId: string,
    caseId: string,
    sacContext?: SacContext,
  ): Promise<Chunk[]> {
    const structured = pages.filter(p => (p.blocks?.length ?? 0) > 0);
    if (structured.length === 0) {
      return this.inner.chunkPages(pages, documentId, caseId, sacContext);
    }
    const unstructured = pages.filter(p => (p.blocks?.length ?? 0) === 0);
    const innerChunks = unstructured.length > 0
      ? await this.inner.chunkPages(unstructured, documentId, caseId, sacContext)
      : [];

    const sacPrefix = this.buildSacPrefix(sacContext);
    const structuralChunks: Chunk[] = [];
    for (const page of structured) {
      structuralChunks.push(...this.chunkStructuredPage(page, documentId, caseId, sacPrefix));
    }

    // Merge in page order (stable within each source), renumber chunkIndex
    const tagged = [
      ...innerChunks.map((c, i) => ({ c, order: i })),
      ...structuralChunks.map((c, i) => ({ c, order: i })),
    ];
    tagged.sort((a, b) => a.c.metadata.pageNumber - b.c.metadata.pageNumber || a.order - b.order);
    tagged.forEach((t, i) => { t.c.metadata.chunkIndex = i; });

    logger.info('Structured chunking complete', {
      documentId,
      structuredPages: structured.length,
      delegatedPages: unstructured.length,
      chunks: tagged.length,
    });
    return tagged.map(t => t.c);
  }

  /** Same format as the legacy chunker's SAC prefix, with the summary
   * bounded (§6.2 decision 3 — the legacy version is unbounded). */
  private buildSacPrefix(context?: SacContext): string {
    if (!context) return '';
    const parts: string[] = [];
    if (context.caseName) parts.push(`Case: ${context.caseName}`);
    if (context.filingType) parts.push(`Filing: ${context.filingType}`);
    if (context.documentSummary) {
      parts.push(`Summary: ${truncateMiddle(context.documentSummary, SUMMARY_MAX_CHARS)}`);
    }
    if (parts.length === 0) return '';
    return `[${parts.join(' | ')}]\n\n`;
  }

  private chunkStructuredPage(
    page: PageText,
    documentId: string,
    caseId: string,
    sacPrefix: string,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    let heading = '';
    let paraBuf: string[] = [];

    const meta = (): ChunkMetadata => ({
      documentId,
      caseId,
      pageNumber: page.pageNumber,
      chunkIndex: 0, // renumbered by caller
      isExhibit: false,
    });

    const prefixFor = (h: string) => sacPrefix + (h ? `${h}\n` : '');
    const bodyBudget = (h: string) =>
      Math.max(MIN_BODY_BUDGET, PROSE_MAX_CHARS - prefixFor(h).length);

    const flushParas = () => {
      if (paraBuf.length === 0) return;
      const budget = bodyBudget(heading);
      let cur = '';
      const emit = (body: string) => {
        if (!body.trim()) return;
        chunks.push({ text: prefixFor(heading) + body, metadata: meta() });
      };
      for (const para of paraBuf) {
        const pieces = para.length > budget ? sentenceSplit(para, budget) : [para];
        for (const piece of pieces) {
          if (cur && cur.length + piece.length + 1 > budget) {
            emit(cur);
            cur = piece;
          } else {
            cur = cur ? `${cur}\n${piece}` : piece;
          }
        }
      }
      emit(cur);
      paraBuf = [];
    };

    const emitTable = (block: DocparseBlock) => {
      const prefix = prefixFor(heading);
      const text = block.text.trim();
      if (!text) return;
      if (text.length <= TABLE_MAX_CHARS) {
        chunks.push({ text: prefix + text, metadata: meta() });
        return;
      }
      // Split on row boundaries, repeating the header row per fragment so
      // every fragment is self-explanatory (§6 item 2).
      const lines = text.split('\n');
      const header = lines[0];
      let rows: string[] = [];
      const flushRows = () => {
        if (rows.length === 0) return;
        chunks.push({ text: prefix + [header, ...rows].join('\n'), metadata: meta() });
        rows = [];
      };
      let size = header.length;
      for (const line of lines.slice(1)) {
        if (size + line.length + 1 > TABLE_MAX_CHARS && rows.length > 0) {
          flushRows();
          size = header.length;
        }
        rows.push(line);
        size += line.length + 1;
      }
      flushRows();
    };

    for (const block of page.blocks ?? []) {
      switch (block.type) {
        case 'heading':
          flushParas();
          heading = truncateMiddle(block.text.replace(/\n+/g, ' ').trim(), HEADING_MAX_CHARS);
          break;
        case 'table':
          flushParas();
          emitTable(block);
          break;
        case 'paragraph':
        case 'footnote': // footnotes carry citations — included (§6.2 decision 6)
        case 'unknown':
          if (block.text.trim()) paraBuf.push(block.text.trim());
          break;
        // furniture and marks are excluded from chunk text (§6.2 decision 6)
        case 'page_header':
        case 'page_footer':
        case 'page_number':
        case 'seal':
        case 'signature':
        case 'figure':
          break;
      }
    }
    flushParas();
    return chunks;
  }

  async chunkExhibitText(text: string, exhibit: Exhibit, sacContext?: SacContext): Promise<Chunk[]> {
    return this.inner.chunkExhibitText(text, exhibit, sacContext);
  }

  dispose(): void {
    this.inner.dispose();
  }
}
