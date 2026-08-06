import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../logger';
import { PdfDown } from '@d0paminedriven/pdfdown';

const logger = createLogger('PDFParser');

// ---------------------------------------------------------------------------
// pdfjs-dist lazy init (fallback for PDFs where pdfdown extracts no text)
// ---------------------------------------------------------------------------
let _pdfjsLib: any = null;

async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib;
  // DOMMatrix polyfill required for pdfjs-dist in Node.js
  if (typeof globalThis.DOMMatrix === 'undefined') {
    (globalThis as any).DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: any) {
        if (Array.isArray(init) && init.length >= 6)
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
      multiplySelf() { return this; }
      inverse() { return new DOMMatrix(); }
      static fromMatrix() { return new DOMMatrix(); }
      static fromFloat32Array(a: Float32Array) { return new DOMMatrix(Array.from(a)); }
      static fromFloat64Array(a: Float64Array) { return new DOMMatrix(Array.from(a)); }
    };
  }
  _pdfjsLib = await import('pdfjs-dist');
  _pdfjsLib.GlobalWorkerOptions.workerPort = null;
  return _pdfjsLib;
}

/**
 * Represents text extracted from a single PDF page
 */
export interface PageText {
  pageNumber: number;
  text: string;
  textDensity: number; // Characters per page
  renderFailed?: boolean; // True if page rendering/extraction failed
  /** Structured blocks from a docparse producer (PLAN-ss-docparse §0.1).
   * NOTE: declared on BOTH PageText interfaces (here and text-chunker.ts) —
   * they are structurally-typed twins; adding a field to only one silently
   * drops it at the chunker boundary (the structureType leak, §3.1). */
  blocks?: import('./docparse-types').DocparseBlock[];
}

/**
 * Represents an image extracted from a PDF
 */
export interface ExtractedImage {
  pageNumber: number;
  imageIndex: number;
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Progress callback for batch processing
 */
export type ProgressCallback = (processed: number, total: number) => void;

/**
 * Configuration for chunked PDF processing
 */
export interface PDFParserConfig {
  /** Number of pages to process per batch (default: 50) */
  batchSize: number;
  /** Scale factor for page rendering (default: 1.5) — kept for interface compat, unused by pdfdown */
  renderScale: number;
}

const DEFAULT_CONFIG: PDFParserConfig = {
  batchSize: 50,
  renderScale: 1.5,
};

/**
 * Cached PDF buffer + PdfDown instance for reuse across pipeline stages
 */
interface CachedDocument {
  buffer: Buffer;
  pdfDown: PdfDown;
  refCount: number;
  /** Cached result of pdfDown.imagesPerPageAsync() — populated on first call */
  imagesPerPage?: { page: number; imageIndex: number; width: number; height: number; data: Buffer }[];
}

// ── OCR image filtering constants ──────────────────────────────────
// Raised from 100px to 300px to filter out logos, stamps, separator lines,
// and other small decorative images that waste OCR time and produce garbage text.
export const MIN_OCR_WIDTH = 300;
export const MIN_OCR_HEIGHT = 300;
export const MIN_OCR_AREA = 90_000; // 300x300
export const MIN_OCR_BYTES = 5_000;

/**
 * Check if an image is large enough to be worth OCR'ing.
 * Filters out logos, stamps, separator lines, and trivially small buffers.
 * Images below 300x300 are almost never real document content.
 */
export function isImageOcrWorthy(image: { width: number; height: number; buffer: Buffer }): boolean {
  if (image.width < MIN_OCR_WIDTH || image.height < MIN_OCR_HEIGHT) return false;
  if (image.width * image.height < MIN_OCR_AREA) return false;
  if (image.buffer.byteLength < MIN_OCR_BYTES) return false;
  return true;
}

/**
 * Result from getOcrCandidateImage — the best image to OCR on a page.
 */
export interface OcrCandidate {
  buffer: Buffer;
  imageIndex: number;
}

/**
 * One reconstructed Reporter's-Record line (PLAN-rr-structure item 1).
 * Geometry is PDF points, BOTTOM-left origin (pdfjs convention) — the RR
 * block producer converts to top-left when building DocparseBlock bboxes.
 */
export interface RRLine {
  /** Printed margin line number 1-25, or null for header/caption lines. */
  lineNumber: number | null;
  /** Line text WITHOUT the number prefix — exactly what today's page text
   * puts after "N  ". Empty string is meaningful (blank numbered lines). */
  text: string;
  x0: number;
  x1: number;
  y: number;      // baseline y of the line
  height: number; // max item height on the line (≈ font size)
}

/**
 * Pure RR line reconstruction over pdfjs text items — the single source for
 * BOTH the RR page text (via reconstructRRPageText's join, byte-identical to
 * the pre-refactor output) AND the RR structure producer's blocks.
 *
 * Faithfully preserves the original algorithm: Y_TOLERANCE=2 y-bucketing,
 * y-desc/x-asc sorts, line-number column detection (≥3 candidates on lines
 * with ≥2 items, ±30pt median cluster, maxX = median+30), and the per-line
 * numbered/plain branch — with item width/height additionally captured for
 * geometry (they do not affect the text output).
 */
export function reconstructRRLines(items: any[]): RRLine[] {
  const textItems = items.filter(
    (item: any) => item.str && item.str.trim().length > 0 && item.transform
  );
  if (textItems.length === 0) return [];

  const Y_TOLERANCE = 2;
  const lines: { y: number; items: { x: number; str: string; width: number; height: number }[] }[] = [];
  for (const item of textItems) {
    const x = item.transform[4];
    const y = item.transform[5];
    let line = lines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push({ x, str: item.str, width: item.width ?? 0, height: item.height ?? 0 });
  }

  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  // Line-number column detection — candidacy requires ≥2 items on the line
  // (a bare number with no text is not a candidate, but IS emitted as a
  // blank numbered line below once the column is established).
  const candidateXs: number[] = [];
  for (const line of lines) {
    if (line.items.length < 2) continue;
    const trimmed = line.items[0].str.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= 25 && trimmed === String(num)) {
      candidateXs.push(line.items[0].x);
    }
  }
  let hasLineNumbers = false;
  let lineNumberMaxX = 0;
  if (candidateXs.length >= 3) {
    const xs = [...candidateXs].sort((a, b) => a - b);
    const medianX = xs[Math.floor(xs.length / 2)];
    if (xs.filter((x) => Math.abs(x - medianX) < 30).length >= 3) {
      hasLineNumbers = true;
      lineNumberMaxX = medianX + 30;
    }
  }

  const result: RRLine[] = [];
  for (const line of lines) {
    if (line.items.length === 0) continue;
    const x0 = line.items[0].x;
    const last = line.items[line.items.length - 1];
    const x1 = last.x + last.width;
    const height = Math.max(...line.items.map((i) => i.height), 0);

    if (hasLineNumbers) {
      const first = line.items[0];
      const trimmed = first.str.trim();
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= 25 && trimmed === String(num) && first.x < lineNumberMaxX) {
        result.push({
          lineNumber: num,
          text: line.items.slice(1).map((i) => i.str).join(' ').trim(),
          x0, x1, y: line.y, height,
        });
        continue;
      }
    }
    result.push({
      lineNumber: null,
      text: line.items.map((i) => i.str).join(' ').trim(),
      x0, x1, y: line.y, height,
    });
  }
  return result;
}

/**
 * PDFParser class for extracting text and images from PDF files.
 * Uses @d0paminedriven/pdfdown (native Rust via NAPI) for extraction.
 * Handles JPEG2000 natively — no browser polyfills or WASM hacks needed.
 *
 * All pdfdown calls use the *Async variants which run on the libuv thread
 * pool, keeping the Node.js event loop free for HTTP requests and SSE.
 *
 * Includes a document cache so the pipeline can load a PDF once
 * and reuse it across text extraction, OCR fallback, and exhibit
 * extraction — avoiding repeated 100MB+ file reads.
 */
export class PDFParser {
  private config: PDFParserConfig;
  private documentCache: Map<string, CachedDocument> = new Map();

  constructor(config: Partial<PDFParserConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Pre-load a PDF document into the cache for reuse across multiple
   * method calls. Call releaseDocument() when done to free memory.
   *
   * @param filePath - Path to the PDF file
   * @returns The cached PdfDown instance
   */
  async loadDocument(filePath: string): Promise<PdfDown> {
    const existing = this.documentCache.get(filePath);
    if (existing) {
      existing.refCount++;
      logger.debug('Document cache hit (refCount++)', { filePath, refCount: existing.refCount });
      return existing.pdfDown;
    }

    const buffer = await fs.readFile(filePath);
    const pdfDown = new PdfDown(buffer);

    this.documentCache.set(filePath, { buffer, pdfDown, refCount: 1 });
    const meta = await pdfDown.metadataAsync();
    logger.debug('Document loaded into cache', {
      filePath,
      numPages: meta.pageCount,
      fileSizeMB: (buffer.byteLength / 1024 / 1024).toFixed(1),
    });
    return pdfDown;
  }

  /**
   * Release a previously loaded document. When refCount reaches 0 the
   * cached buffer and PdfDown instance are dropped.
   *
   * @param filePath - Path to the PDF file
   */
  async releaseDocument(filePath: string): Promise<void> {
    const entry = this.documentCache.get(filePath);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      this.documentCache.delete(filePath);
      logger.debug('Document released from cache', { filePath });
    } else {
      logger.debug('Document cache refCount decremented', { filePath, refCount: entry.refCount });
    }
  }

  /**
   * Get a PdfDown instance — from cache if available, otherwise load fresh.
   * Returns a flag indicating whether the instance came from cache
   * (callers should NOT drop cached instances).
   */
  private async getOrLoadPdfDown(filePath: string): Promise<{ pdfDown: PdfDown; cached: boolean }> {
    const existing = this.documentCache.get(filePath);
    if (existing) {
      return { pdfDown: existing.pdfDown, cached: true };
    }

    // Not in cache — load a one-off copy
    const buffer = await fs.readFile(filePath);
    const pdfDown = new PdfDown(buffer);
    return { pdfDown, cached: false };
  }

  /**
   * Get images-per-page from cache, or extract once and cache the result.
   * This avoids calling pdfDown.imagesPerPageAsync() hundreds of times
   * for large documents (previously called per-page during OCR).
   */
  private async getImagesPerPage(filePath: string): Promise<{ page: number; imageIndex: number; width: number; height: number; data: Buffer }[]> {
    const entry = this.documentCache.get(filePath);
    if (entry?.imagesPerPage) {
      return entry.imagesPerPage;
    }

    const { pdfDown } = await this.getOrLoadPdfDown(filePath);
    const images = await pdfDown.imagesPerPageAsync();

    // Cache if document is in the cache
    if (entry) {
      entry.imagesPerPage = images;
      logger.debug('Images cached for document', { filePath, imageCount: images.length });
    }

    return images;
  }

  /**
   * Extract text from all pages of a PDF file.
   * Uses pdfdown's async NAPI call which runs on libuv's thread pool,
   * keeping the event loop free for UI requests.
   *
   * @param filePath - Path to the PDF file
   * @param onProgress - Optional callback invoked after each batch
   * @returns Array of PageText objects containing text and metadata for each page
   */
  async extractText(filePath: string, onProgress?: ProgressCallback): Promise<PageText[]> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);

    const rawPages = await pdfDown.textPerPageAsync();
    const numPages = rawPages.length;
    const batchSize = this.config.batchSize;

    logger.info(`Starting text extraction`, { filePath, numPages, batchSize });

    let pages: PageText[] = rawPages.map((rp) => ({
      pageNumber: rp.page,
      text: rp.text,
      textDensity: rp.text.trim().length, // Use trimmed length to detect whitespace-only pages
    }));

    // Check if pdfdown returned mostly empty/whitespace pages — if so, fall back to pdfjs-dist
    const emptyPages = pages.filter(p => p.textDensity === 0).length;
    if (numPages > 0 && emptyPages / numPages >= 0.8) {
      logger.warn(`pdfdown extracted no text from ${emptyPages}/${numPages} pages, falling back to pdfjs-dist`, { filePath });
      try {
        pages = await this.extractTextWithPdfjs(filePath);
        logger.info(`pdfjs-dist fallback extracted text`, {
          filePath,
          numPages: pages.length,
          pagesWithText: pages.filter(p => p.textDensity > 0).length,
        });
      } catch (err) {
        logger.error(`pdfjs-dist fallback failed, using pdfdown results`, {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep original pdfdown results
      }
    }

    // Per-page pdfjs fallback: pdfdown sometimes fails on specific pages (tables,
    // index pages, certain font encodings) returning only whitespace while pdfjs-dist
    // extracts text successfully. Re-extract those pages individually.
    const whitespacePages = pages.filter(p => p.textDensity === 0 && p.text.length > 0);
    if (whitespacePages.length > 0 && whitespacePages.length < numPages) {
      logger.info(`${whitespacePages.length} pages have whitespace-only text from pdfdown, trying per-page pdfjs fallback`, {
        pages: whitespacePages.map(p => p.pageNumber),
      });
      try {
        const pdfjsPages = await this.extractTextWithPdfjsPages(filePath, whitespacePages.map(p => p.pageNumber));
        let recovered = 0;
        for (const pdfjsPage of pdfjsPages) {
          if (pdfjsPage.textDensity > 0) {
            const idx = pages.findIndex(p => p.pageNumber === pdfjsPage.pageNumber);
            if (idx >= 0) {
              pages[idx] = pdfjsPage;
              recovered++;
            }
          }
        }
        if (recovered > 0) {
          logger.info(`pdfjs per-page fallback recovered text for ${recovered}/${whitespacePages.length} pages`);
        }
      } catch (err) {
        logger.warn(`pdfjs per-page fallback failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Report progress in batches for consistency with callers
    const finalCount = pages.length;
    if (onProgress) {
      for (let batchStart = 0; batchStart < finalCount; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, finalCount);
        onProgress(batchEnd, finalCount);
      }
    }

    return pages;
  }

  /**
   * Fallback text extraction using pdfjs-dist when pdfdown returns empty text.
   */
  private async extractTextWithPdfjs(filePath: string): Promise<PageText[]> {
    const pdfjsLib = await getPdfjsLib();
    const fileBuffer = await fs.readFile(filePath);
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
      wasmUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/'),
    }).promise;

    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item: any) => item.str).join(' ');
      pages.push({
        pageNumber: i,
        text,
        textDensity: text.trim().length,
      });
      page.cleanup();
    }
    await doc.destroy();
    return pages;
  }

  /**
   * Per-page pdfjs-dist fallback for specific pages where pdfdown returned whitespace-only text.
   * More efficient than extractTextWithPdfjs (which extracts ALL pages).
   */
  private async extractTextWithPdfjsPages(filePath: string, pageNumbers: number[]): Promise<PageText[]> {
    const pdfjsLib = await getPdfjsLib();
    const fileBuffer = await fs.readFile(filePath);
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
      wasmUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/'),
    }).promise;

    const pages: PageText[] = [];
    for (const pageNum of pageNumbers) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item: any) => item.str).join(' ');
      pages.push({
        pageNumber: pageNum,
        text,
        textDensity: text.trim().length,
      });
      page.cleanup();
    }
    await doc.destroy();
    return pages;
  }

  /**
   * Render a single PDF page to a PNG image buffer.
   * With pdfdown, we extract embedded images from the page instead of
   * rendering the whole page through a canvas. For pages with embedded
   * images (scanned docs), this returns the first image. For truly
   * empty pages, returns a minimal blank PNG.
   *
   * @param filePath - Path to the PDF file
   * @param pageNumber - 1-indexed page number to render
   * @returns PNG image buffer of the rendered page
   */
  async renderPageToImage(filePath: string, pageNumber: number): Promise<Buffer> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);

    const meta = await pdfDown.metadataAsync();
    if (pageNumber < 1 || pageNumber > meta.pageCount) {
      throw new Error(`Page ${pageNumber} out of range (1-${meta.pageCount})`);
    }

    // Use cached images-per-page extraction
    const allImages = await this.getImagesPerPage(filePath);
    const pageImages = allImages.filter((img) => img.page === pageNumber);

    if (pageImages.length > 0) {
      // Find the first OCR-worthy image, falling back to the largest
      const worthy = pageImages.find((img) =>
        isImageOcrWorthy({ width: img.width, height: img.height, buffer: img.data })
      );
      if (worthy) return worthy.data;

      // Fallback: largest image only if it meets minimum size thresholds
      const largest = pageImages.reduce((a, b) =>
        a.data.byteLength >= b.data.byteLength ? a : b
      );
      if (largest.width >= MIN_OCR_WIDTH && largest.height >= MIN_OCR_HEIGHT && largest.data.byteLength >= MIN_OCR_BYTES) return largest.data;
    }

    // No viable images — return a minimal 1x1 white PNG
    logger.debug(`No OCR-worthy images on page ${pageNumber}, returning blank PNG`, { pageNumber });
    return createBlankPng();
  }

  /**
   * Extract embedded images from a PDF file.
   * pdfdown returns PNG-encoded buffers directly — no sharp conversion needed.
   *
   * @param filePath - Path to the PDF file
   * @param onProgress - Optional progress callback
   * @returns Array of ExtractedImage objects
   */
  async extractImages(filePath: string, onProgress?: ProgressCallback): Promise<ExtractedImage[]> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);

    const rawImages = await this.getImagesPerPage(filePath);
    const meta = await pdfDown.metadataAsync();
    const numPages = meta.pageCount;
    const batchSize = this.config.batchSize;

    const images: ExtractedImage[] = rawImages.map((img) => ({
      pageNumber: img.page,
      imageIndex: img.imageIndex,
      buffer: img.data, // Already PNG-encoded
      width: img.width,
      height: img.height,
    }));

    // Report progress in batches
    if (onProgress) {
      for (let batchStart = 0; batchStart < numPages; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, numPages);
        onProgress(batchEnd, numPages);
      }
    }

    return images;
  }

  /**
   * Extract embedded images from a single PDF page.
   *
   * @param filePath - Path to the PDF file
   * @param pageNumber - 1-indexed page number
   * @returns Array of ExtractedImage objects from that page
   */
  async extractPageImages(filePath: string, pageNumber: number): Promise<ExtractedImage[]> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);

    const meta = await pdfDown.metadataAsync();
    if (pageNumber < 1 || pageNumber > meta.pageCount) {
      throw new Error(`Page ${pageNumber} out of range (1-${meta.pageCount})`);
    }

    const allImages = await this.getImagesPerPage(filePath);
    return allImages
      .filter((img) => img.page === pageNumber)
      .map((img) => ({
        pageNumber: img.page,
        imageIndex: img.imageIndex,
        buffer: img.data, // Already PNG-encoded
        width: img.width,
        height: img.height,
      }));
  }

  /**
   * Get the best OCR candidate image from a page, or null if no viable image exists.
   * Picks the first image passing size filters, falling back to the largest non-trivial image.
   *
   * @param filePath - Path to the PDF file
   * @param pageNumber - 1-indexed page number
   * @returns OcrCandidate with buffer and imageIndex, or null
   */
  async getOcrCandidateImage(filePath: string, pageNumber: number): Promise<OcrCandidate | null> {
    const allImages = await this.getImagesPerPage(filePath);
    const pageImages = allImages.filter((img) => img.page === pageNumber);

    if (pageImages.length === 0) return null;

    // First pass: find the first OCR-worthy image
    for (const img of pageImages) {
      if (isImageOcrWorthy({ width: img.width, height: img.height, buffer: img.data })) {
        return { buffer: img.data, imageIndex: img.imageIndex };
      }
    }

    // Fallback: largest image only if it meets minimum size thresholds
    const largest = pageImages.reduce((a, b) =>
      a.data.byteLength >= b.data.byteLength ? a : b
    );
    if (largest.width >= MIN_OCR_WIDTH && largest.height >= MIN_OCR_HEIGHT && largest.data.byteLength >= MIN_OCR_BYTES) {
      return { buffer: largest.data, imageIndex: largest.imageIndex };
    }

    return null;
  }

  /**
   * Extract images from specific pages only (pdfdown fallback for when poppler is unavailable).
   * Uses the cached imagesPerPage data and filters by the given page set.
   *
   * @param filePath - Path to the PDF file
   * @param pageNumbers - Set of 1-indexed page numbers to extract images from
   * @returns Array of ExtractedImage objects from the specified pages
   */
  async extractImagesForPages(filePath: string, pageNumbers: Set<number>): Promise<ExtractedImage[]> {
    const allImages = await this.getImagesPerPage(filePath);
    return allImages
      .filter((img) => pageNumbers.has(img.page))
      .map((img) => ({
        pageNumber: img.page,
        imageIndex: img.imageIndex,
        buffer: img.data,
        width: img.width,
        height: img.height,
      }));
  }

  /**
   * Layout-aware text extraction for Reporter's Record (RR) documents.
   * Uses pdfjs-dist's getTextContent() with positional data (transform matrix)
   * to reconstruct line-by-line text and detect the left-margin line numbers
   * (1-25) that pdfdown collapses into a single run.
   *
   * @param filePath - Path to the PDF file
   * @param onProgress - Optional progress callback
   * @returns Array of PageText objects with line numbers prepended to each line
   */
  async extractTextForRR(filePath: string, onProgress?: ProgressCallback): Promise<PageText[]> {
    const pdfjsLib = await getPdfjsLib();
    const fileBuffer = await fs.readFile(filePath);
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
      wasmUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/'),
    }).promise;

    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const text = this.reconstructRRPageText(textContent.items);
      pages.push({
        pageNumber: i,
        text,
        textDensity: text.trim().length,
      });
      page.cleanup();

      if (onProgress && i % this.config.batchSize === 0) {
        onProgress(i, doc.numPages);
      }
    }

    if (onProgress) {
      onProgress(doc.numPages, doc.numPages);
    }

    await doc.destroy();
    return pages;
  }

  /**
   * Reconstruct a single RR page's text from pdfjs-dist text items.
   * BYTE-IDENTITY INVARIANT: this must produce exactly the same string as
   * before the reconstructRRLines refactor — RR chunk text, line-number
   * stamping, and MCP citation fallbacks all read this text
   * (PLAN-rr-structure item 1/2; verified against a real volume).
   */
  private reconstructRRPageText(items: any[]): string {
    return reconstructRRLines(items)
      .map((l) => (l.lineNumber !== null ? `${l.lineNumber}  ${l.text}` : l.text))
      .join('\n');
  }

  /**
   * Get the total number of pages in a PDF file without extracting content.
   * @param filePath - Path to the PDF file
   * @returns Number of pages in the PDF
   */
  async getPageCount(filePath: string): Promise<number> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);
    const meta = await pdfDown.metadataAsync();
    return meta.pageCount;
  }

  /**
   * Check whether a page contains any embedded images.
   * Uses pdfDocument().imagePages for a fast check.
   *
   * @param filePath - Path to the PDF file
   * @param pageNumber - 1-indexed page number
   * @returns true if the page has at least one image
   */
  async pageHasImages(filePath: string, pageNumber: number): Promise<boolean> {
    const { pdfDown } = await this.getOrLoadPdfDown(filePath);

    const meta = await pdfDown.metadataAsync();
    if (pageNumber < 1 || pageNumber > meta.pageCount) {
      throw new Error(`Page ${pageNumber} out of range (1-${meta.pageCount})`);
    }

    // pdfDocument().imagePages lists pages that have images
    const doc = await pdfDown.documentAsync();
    return doc.imagePages.includes(pageNumber);
  }
}

/**
 * Create a minimal valid 1x1 white PNG buffer.
 * Used as fallback when no embedded images exist on a page.
 */
function createBlankPng(): Buffer {
  // Minimal 1x1 white PNG (67 bytes)
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
    'base64'
  );
}
