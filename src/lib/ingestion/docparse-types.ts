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

export type BlockProducer = 'pdf' | 'ocr' | 'docparse';

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
}

export interface DocparsePageResult {
  pageNumber: number;
  blocks: DocparseBlock[];
  producer: BlockProducer;
}
