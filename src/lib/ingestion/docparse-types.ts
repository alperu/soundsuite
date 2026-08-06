/**
 * Structured document block schema — PLAN-ss-docparse §3 (+ §0.1 producer
 * field). Shared by every block producer (pdfjs geometry extractor, ss-ocr
 * task escalation, and a possible future ss-docparse vLLM service) so the
 * StructuredChunker and search-side never care which produced a block.
 */

export type DocparseBlockType =
  | 'heading'
  | 'paragraph'
  | 'table'
  | 'footnote'
  | 'seal'
  | 'signature'
  | 'page_header'
  | 'page_footer'
  | 'page_number'
  | 'figure'
  | 'unknown';

export type BlockProducer = 'pdf' | 'ocr' | 'docparse' | 'rr';

/**
 * One line inside a block — the page → paragraph → line hierarchy
 * (PLAN-rr-structure item 4; shared by the RR producer's numbered lines
 * and the future born-digital paragraph lines of task #5).
 */
export interface DocparseBlockLine {
  /** Printed margin line number (1-25 on Reporter's Records); undefined for
   * unnumbered producers. */
  lineNumber?: number;
  /** Empty string is meaningful — RR pages contain blank numbered lines and
   * dropping them would break the 1-25 invariant. */
  text: string;
  /** Page-relative, PDF points, TOP-left origin — same convention as
   * DocparseBlock.bbox. */
  bbox: [number, number, number, number] | null;
}

export interface DocparseBlock {
  type: DocparseBlockType;
  /** Exact transcription; tables: normalized cell text (embedding form). */
  text: string;
  /** Tables only — authoritative structured markup (normalized from OTSL). */
  html?: string;
  /** Tables only — markdown pipe form for synthesis context. */
  markdown?: string;
  /** Page-relative bbox in PDF points, TOP-left origin: [x0, y0, x1, y1].
   * null when the producer has no geometry (flat OCR pages). */
  bbox: [number, number, number, number] | null;
  /** Reading-order index within the page. */
  order: number;
  /** Never fabricated — undefined unless a producer measures one. */
  confidence?: number;
  /** Identifiers extracted from furniture blocks before they are excluded
   * from embeddings (§0.1 adoption 2): Bates numbers, clerk file stamps. */
  identifiers?: { batesNumber?: string; fileStamp?: string };
  /** Line children (page → paragraph → line hierarchy). RR speaker turns
   * carry their numbered lines here; block.text stays the joined form. */
  lines?: DocparseBlockLine[];
  /** Speaker label for RR turns (e.g. "THE COURT", "MR. SMITH", "Q", "A"). */
  speaker?: string;
  /** First/last printed line number covered by this block (RR producer) —
   * authoritative source for line-precision citations. */
  lineStart?: number;
  lineEnd?: number;
}

export interface DocparsePageResult {
  pageNumber: number;
  blocks: DocparseBlock[];
  producer: BlockProducer;
  /** Page dimensions in PDF points — persisted with the structure so the
   * Meta View overlay never depends on a live PDF probe (task #10). */
  width?: number;
  height?: number;
}
