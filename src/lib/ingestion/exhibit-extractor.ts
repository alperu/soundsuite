import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { PDFParser, ExtractedImage } from './pdf-parser';
import { PageText } from './pdf-parser';
import { IOCREngine, OCRResult } from './ocr-engine';
import { preprocessImage, buildImageFilename, ImagePreprocessSettings } from './image-preprocessor';
import { MotionSection, findMotionForPage } from './toc-parser';
import { PdfImageInfo } from './poppler-images';
import { createLogger, Logger } from '../logger';

/** Minimum pixel dimensions for an image to be considered an exhibit */
const MIN_EXHIBIT_WIDTH = 150;   // px — filters icons, bullets, small logos
const MIN_EXHIBIT_HEIGHT = 150;  // px
/** Minimum pixel area (width * height) — catches thin banners/lines */
const MIN_EXHIBIT_AREA = 40_000; // ~200x200
/** Minimum buffer byte size — filters tiny/empty images */
const MIN_EXHIBIT_BYTES = 5_000; // 5 KB
/** Text density above which we skip OCR (page already has good text) */
const TEXT_RICH_THRESHOLD = 200;

/**
 * Regex patterns for exhibit header lines in court filings.
 * Matches common formats: "EXHIBIT A", "Exhibit No. 1", "APPENDIX B", "ATTACHMENT 3", etc.
 * Case-insensitive, expects the label near the start of a line (possibly after whitespace).
 * The identifier must be followed by end-of-line, whitespace-only, or a newline —
 * NOT by lowercase words (to avoid matching "Appendix A continued" as a header).
 */
const EXHIBIT_HEADER_PATTERNS = [
  /^\s*EXHIBIT\s+(?:NO\.?\s*)?([A-Z]{1,3}|\d{1,4})\s*$/im,
  /^\s*APPENDIX\s+(?:NO\.?\s*)?([A-Z]{1,3}|\d{1,4})\s*$/im,
  /^\s*ATTACHMENT\s+(?:NO\.?\s*)?([A-Z]{1,3}|\d{1,4})\s*$/im,
];

/**
 * A detected exhibit boundary — the page range where an exhibit lives.
 */
export interface ExhibitBoundary {
  label: string;      // e.g. "Exhibit A", "Appendix 1"
  startPage: number;  // 1-indexed, the page with the header
  endPage: number;    // 1-indexed, inclusive (page before next header or last page)
}

/**
 * Detect exhibit section boundaries by scanning page text for exhibit headers.
 * Returns an array of boundaries sorted by startPage.
 * Each boundary spans from its header page to the page before the next header
 * (or the last page of the document).
 *
 * @param pages - Array of PageText from text extraction (post-OCR for best results)
 * @returns Array of ExhibitBoundary, empty if no headers found
 */
export function detectExhibitBoundaries(pages: PageText[]): ExhibitBoundary[] {
  if (pages.length === 0) return [];

  const headers: { label: string; page: number }[] = [];

  for (const page of pages) {
    // Check each line of the page text
    const lines = page.text.split('\n');
    for (const line of lines) {
      for (const pattern of EXHIBIT_HEADER_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          // Build a human-readable label from the matched type + identifier
          const fullMatch = match[0].trim();
          const type = fullMatch.split(/\s+/)[0]; // "EXHIBIT", "APPENDIX", "ATTACHMENT"
          const id = match[1]; // "A", "1", etc.
          const label = `${type.charAt(0)}${type.slice(1).toLowerCase()} ${id}`;
          headers.push({ label, page: page.pageNumber });
          break; // One match per page is enough
        }
      }
    }
  }

  if (headers.length === 0) return [];

  // Sort by page number (should already be ordered, but be safe)
  headers.sort((a, b) => a.page - b.page);

  // Deduplicate: if the same page matches multiple patterns, keep first
  const deduped: typeof headers = [];
  for (const h of headers) {
    if (deduped.length === 0 || deduped[deduped.length - 1].page !== h.page) {
      deduped.push(h);
    }
  }

  const lastPage = Math.max(...pages.map((p) => p.pageNumber));

  // Build boundaries: each exhibit spans from its header to the page before the next header
  const boundaries: ExhibitBoundary[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const endPage = i + 1 < deduped.length
      ? deduped[i + 1].page - 1
      : lastPage;
    boundaries.push({
      label: deduped[i].label,
      startPage: deduped[i].page,
      endPage,
    });
  }

  return boundaries;
}

/**
 * Check whether a page number falls within any exhibit boundary.
 */
export function isPageInExhibitRange(pageNumber: number, boundaries: ExhibitBoundary[]): boolean {
  return boundaries.some((b) => pageNumber >= b.startPage && pageNumber <= b.endPage);
}

/**
 * Metadata for an extracted exhibit
 */
export interface ExhibitMetadata {
  pageNumber: number;
  imagePath: string;
  extractedText: string;
  confidence?: number;
  /** Exhibit label from boundary detection (e.g. "Exhibit A"), if available */
  exhibitLabel?: string;
}

/**
 * Result from exhibit extraction process
 */
export interface ExhibitExtractionResult {
  exhibits: ExhibitMetadata[];
  totalCount: number;
}

/**
 * Options for poppler-driven exhibit extraction.
 */
export interface ExhibitExtractionOptions {
  /** Poppler metadata from image-scan stage (null if poppler unavailable) */
  popplerImages?: PdfImageInfo[];
  /** Pages with worthy images from image-scan stage */
  worthyImagePages?: Set<number>;
  /** Page text from text-extraction stage (for text-rich skip) */
  pages?: PageText[];
  /** Motion sections from toc-extraction stage */
  motionSections?: MotionSection[];
  /** Image preprocessing settings from pipeline config */
  preprocessSettings?: ImagePreprocessSettings;
  /** Max parallel preprocess/OCR workers. Set by the caller from `pipeline.ocrConcurrency`; defaults to 2 (legacy path: 3). */
  concurrency?: number;
}

/**
 * p-queue throws a TypeError for concurrency values < 1 (0, negative, NaN, null),
 * which would fail the whole extraction stage — clamp to a safe 1–8 range instead.
 */
function clampConcurrency(value: number | undefined | null, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

/**
 * ExhibitExtractor class for extracting and processing exhibits from PDF documents.
 *
 * Poppler-first flow:
 * 1. Compute target pages = intersection of worthy images ∩ (exhibit pages ∪ motion pages)
 * 2. Extract images via poppler (batch) or pdfdown (fallback)
 * 3. Pipeline: preprocess → save → OCR (skip text-rich pages)
 */
export class ExhibitExtractor {
  private pdfParser: PDFParser;
  private ocrEngine: IOCREngine;
  private publicDir: string;
  private logger: Logger;
  /** Filing type for naming (e.g. "motion", "exhibit"). Set per-document. */
  filingType?: string;
  /** Motion sections from TOC. Set per-document for descriptive naming. */
  motionSections?: MotionSection[];

  constructor(publicDir: string = 'public', pdfParser?: PDFParser, ocrEngine?: IOCREngine) {
    this.pdfParser = pdfParser || new PDFParser();
    if (!ocrEngine) {
      throw new Error('ExhibitExtractor requires an IOCREngine instance');
    }
    this.ocrEngine = ocrEngine;
    this.publicDir = publicDir;
    this.logger = createLogger('ExhibitExtractor');
  }

  /**
   * Check if an extracted image is likely a real exhibit (not an icon, logo, or decoration).
   */
  private isLikelyExhibit(image: ExtractedImage): boolean {
    if (image.width < MIN_EXHIBIT_WIDTH || image.height < MIN_EXHIBIT_HEIGHT) return false;
    if (image.width * image.height < MIN_EXHIBIT_AREA) return false;
    if (image.buffer.length < MIN_EXHIBIT_BYTES) return false;
    return true;
  }

  /**
   * Build a set of "interesting" pages — pages within exhibit boundaries or motion sections.
   * These are pages where we expect meaningful document images.
   */
  private buildInterestingPages(
    boundaries: ExhibitBoundary[] | undefined,
    motionSections: MotionSection[] | undefined,
  ): Set<number> {
    const pages = new Set<number>();

    // Add all exhibit boundary pages
    if (boundaries && boundaries.length > 0) {
      for (const b of boundaries) {
        for (let p = b.startPage; p <= b.endPage; p++) {
          pages.add(p);
        }
      }
    }

    // Add all motion section pages (motions may contain images that aren't labeled as exhibits)
    if (motionSections && motionSections.length > 0) {
      for (const s of motionSections) {
        const endPage = s.endPage ?? s.startPage + 50; // cap at 50 pages if no end
        for (let p = s.startPage; p <= endPage; p++) {
          pages.add(p);
        }
      }
    }

    return pages;
  }

  /**
   * Extract all exhibits from a PDF document using poppler-first or pdfdown-fallback flow.
   *
   * Poppler-first flow:
   * 1. Compute target pages = intersection of worthy images ∩ interesting pages
   * 2. Batch-extract images from target page ranges via poppler
   * 3. Size filter + dedup extracted images
   * 4. Preprocess each image via sharp pipeline
   * 5. OCR each image (skip text-rich pages)
   * 6. Save with descriptive filenames
   *
   * Pdfdown fallback (when poppler unavailable):
   * Uses pdfParser.extractImagesForPages() instead of poppler extraction.
   *
   * @param filePath - Path to the PDF file
   * @param caseId - UUID of the case
   * @param documentId - UUID of the document
   * @param boundaries - Optional exhibit boundaries detected from page text
   * @param onProgress - Optional progress callback (processed, total)
   * @param options - Poppler metadata, worthy image pages, page text, etc.
   * @returns ExhibitExtractionResult with metadata for all exhibits
   */
  async extractExhibits(
    filePath: string,
    caseId: string,
    documentId: string,
    boundaries?: ExhibitBoundary[],
    onProgress?: (processed: number, total: number) => void,
    options?: ExhibitExtractionOptions,
  ): Promise<ExhibitExtractionResult> {
    const {
      popplerImages,
      worthyImagePages,
      pages: pageTexts,
      motionSections: optMotionSections,
      preprocessSettings,
      concurrency,
    } = options || {};

    // Use motionSections from options if provided, otherwise from instance property
    const motionSections = optMotionSections ?? this.motionSections;

    // Compute target pages: intersection of worthy images ∩ interesting pages
    const interestingPages = this.buildInterestingPages(boundaries, motionSections);
    let targetPages: Set<number>;

    if (worthyImagePages && worthyImagePages.size > 0 && interestingPages.size > 0) {
      // Intersection: pages with worthy images that are within exhibit/motion boundaries
      targetPages = new Set<number>();
      for (const p of worthyImagePages) {
        if (interestingPages.has(p)) targetPages.add(p);
      }
    } else if (worthyImagePages && worthyImagePages.size > 0) {
      // No boundaries/motions detected — use all pages with worthy images
      targetPages = worthyImagePages;
    } else if (interestingPages.size > 0) {
      // No poppler scan — use all interesting pages (boundaries + motions)
      targetPages = interestingPages;
    } else {
      // No information at all — fall back to extracting all images
      this.logger.info('No exhibit boundaries, motion sections, or poppler data — extracting all images', { documentId });
      return this.extractExhibitsLegacy(filePath, caseId, documentId, boundaries, onProgress, preprocessSettings, concurrency);
    }

    this.logger.info(`Target pages computed for exhibit extraction`, {
      documentId,
      worthyImagePages: worthyImagePages?.size ?? 0,
      interestingPages: interestingPages.size,
      targetPages: targetPages.size,
      exhibitBoundaries: boundaries?.length ?? 0,
      motionSections: motionSections?.length ?? 0,
    });

    if (targetPages.size === 0) {
      this.logger.info('No target pages for exhibit extraction', { documentId });
      return { exhibits: [], totalCount: 0 };
    }

    // Extract images from target pages using pdfdown (already loaded and cached).
    // Poppler is used only for the fast metadata scan — pdfdown is faster for
    // actual image extraction since it already has the PDF in memory.
    const candidateImages = await this.pdfParser.extractImagesForPages(filePath, targetPages);
    this.logger.info(`Extracted ${candidateImages.length} images from ${targetPages.size} target pages`, { documentId });

    if (candidateImages.length === 0) {
      this.logger.info('No images extracted from target pages', { documentId });
      return { exhibits: [], totalCount: 0 };
    }

    // Filter: size → dedup
    const seenHashes = new Set<string>();
    const filteredImages: ExtractedImage[] = [];
    let filteredBySize = 0;
    let filteredByDuplicate = 0;

    for (const image of candidateImages) {
      if (!this.isLikelyExhibit(image)) {
        filteredBySize++;
        continue;
      }
      const hash = createHash('sha256').update(image.buffer).digest('hex');
      if (seenHashes.has(hash)) {
        filteredByDuplicate++;
        continue;
      }
      seenHashes.add(hash);
      filteredImages.push(image);
    }

    this.logger.info(`Filtered to ${filteredImages.length} exhibit candidates`, {
      documentId,
      totalExtracted: candidateImages.length,
      filteredBySize,
      filteredByDuplicate,
      remaining: filteredImages.length,
    });

    if (filteredImages.length === 0) {
      return { exhibits: [], totalCount: 0 };
    }

    // Create output directory
    const exhibitDir = path.join(this.publicDir, 'exhibits', caseId);
    await fs.mkdir(exhibitDir, { recursive: true });

    // Build page text lookup for text-rich skip
    const pageTextMap = new Map<number, PageText>();
    if (pageTexts) {
      for (const pt of pageTexts) {
        pageTextMap.set(pt.pageNumber, pt);
      }
    }

    // Process: preprocess → save → OCR (with pipelined concurrency)
    const exhibits: ExhibitMetadata[] = [];
    const { default: PQueue } = await import('p-queue');
    const safeConcurrency = clampConcurrency(concurrency, 2);
    const preprocessQueue = new PQueue({ concurrency: safeConcurrency });
    const ocrQueue = new PQueue({ concurrency: safeConcurrency });
    let processedCount = 0;

    for (const image of filteredImages) {
      preprocessQueue.add(async () => {
        try {
          // Preprocess image through sharp pipeline
          const preprocessedBuffer = await preprocessImage(image.buffer, preprocessSettings);

          // Look up exhibit label from boundaries
          let exhibitLabel: string | undefined;
          if (boundaries && boundaries.length > 0) {
            const boundary = boundaries.find(
              (b) => image.pageNumber >= b.startPage && image.pageNumber <= b.endPage
            );
            if (boundary) exhibitLabel = boundary.label;
          }

          // Look up motion name from TOC sections for this page
          const motionName = motionSections?.length
            ? findMotionForPage(image.pageNumber, motionSections)
            : undefined;

          // Generate descriptive filename:
          // {docId}_{filingType}_{motionName}_{exhibitLabel}_page{N}_img{M}.png
          const filename = buildImageFilename(
            documentId,
            image.pageNumber,
            image.imageIndex,
            this.filingType,
            exhibitLabel,
            motionName,
          );
          const imagePath = path.join(exhibitDir, filename);
          const relativeImagePath = `/exhibits/${caseId}/${filename}`;

          // Save preprocessed image to disk
          await fs.writeFile(imagePath, preprocessedBuffer);

          // Check if page already has good text → skip OCR
          const pageText = pageTextMap.get(image.pageNumber);
          if (pageText && pageText.textDensity >= TEXT_RICH_THRESHOLD) {
            this.logger.info(`Skipping OCR for text-rich exhibit page ${image.pageNumber}`, {
              pageNumber: image.pageNumber,
              textDensity: pageText.textDensity,
            });
            exhibits.push({
              pageNumber: image.pageNumber,
              imagePath: relativeImagePath,
              extractedText: pageText.text,
              confidence: 1.0,
              exhibitLabel,
            });
            processedCount++;
            onProgress?.(processedCount, filteredImages.length);
            return;
          }

          // Queue OCR (IO-bound — runs while next image is preprocessing)
          ocrQueue.add(async () => {
            try {
              const ocrResult = await this.ocrEngine.recognizeImage(preprocessedBuffer);
              exhibits.push({
                pageNumber: image.pageNumber,
                imagePath: relativeImagePath,
                extractedText: ocrResult.text,
                confidence: ocrResult.confidence,
                exhibitLabel,
              });
            } catch (ocrError) {
              this.logger.error(`OCR failed for exhibit on page ${image.pageNumber}`, ocrError, {
                pageNumber: image.pageNumber,
                imageIndex: image.imageIndex,
              });
              // Still save the exhibit without OCR text
              exhibits.push({
                pageNumber: image.pageNumber,
                imagePath: relativeImagePath,
                extractedText: '',
                confidence: 0,
                exhibitLabel,
              });
            }

            processedCount++;
            onProgress?.(processedCount, filteredImages.length);

            if (processedCount % 10 === 0 || processedCount === filteredImages.length) {
              this.logger.info(`Exhibit processing progress`, {
                documentId,
                processed: processedCount,
                total: filteredImages.length,
                progressPercent: Math.round((processedCount / filteredImages.length) * 100),
              });
            }
          });
        } catch (error) {
          this.logger.error(
            `Failed to process exhibit ${image.imageIndex} from page ${image.pageNumber}`,
            error,
            { documentId, pageNumber: image.pageNumber, imageIndex: image.imageIndex }
          );
          processedCount++;
          onProgress?.(processedCount, filteredImages.length);
        }
      });
    }

    await preprocessQueue.onIdle();
    await ocrQueue.onIdle();

    return {
      exhibits,
      totalCount: exhibits.length,
    };
  }

  /**
   * Legacy extraction path — extracts ALL images from PDF (no poppler, no targeting).
   * Used as ultimate fallback when no boundaries, motions, or poppler data available.
   */
  private async extractExhibitsLegacy(
    filePath: string,
    caseId: string,
    documentId: string,
    boundaries?: ExhibitBoundary[],
    onProgress?: (processed: number, total: number) => void,
    preprocessSettings?: ImagePreprocessSettings,
    concurrency?: number,
  ): Promise<ExhibitExtractionResult> {
    const images = await this.pdfParser.extractImages(filePath);

    if (images.length === 0) {
      this.logger.info('No embedded images found (legacy path)', { documentId });
      return { exhibits: [], totalCount: 0 };
    }

    // Filter: size → dedup → boundary
    const seenHashes = new Set<string>();
    const candidateImages: ExtractedImage[] = [];
    let filteredBySize = 0;
    let filteredByDuplicate = 0;
    let filteredByBoundary = 0;
    const useBoundaries = boundaries && boundaries.length > 0;

    for (const image of images) {
      if (!this.isLikelyExhibit(image)) { filteredBySize++; continue; }
      const hash = createHash('sha256').update(image.buffer).digest('hex');
      if (seenHashes.has(hash)) { filteredByDuplicate++; continue; }
      seenHashes.add(hash);
      if (useBoundaries && !isPageInExhibitRange(image.pageNumber, boundaries!)) { filteredByBoundary++; continue; }
      candidateImages.push(image);
    }

    this.logger.info(`Legacy filter: ${candidateImages.length} candidates from ${images.length} images`, {
      documentId, filteredBySize, filteredByDuplicate, filteredByBoundary,
    });

    if (candidateImages.length === 0) {
      return { exhibits: [], totalCount: 0 };
    }

    const exhibitDir = path.join(this.publicDir, 'exhibits', caseId);
    await fs.mkdir(exhibitDir, { recursive: true });

    const exhibits: ExhibitMetadata[] = [];
    const { default: PQueue } = await import('p-queue');
    const queue = new PQueue({ concurrency: clampConcurrency(concurrency, 3) });
    let processedCount = 0;

    for (const image of candidateImages) {
      queue.add(async () => {
        try {
          const preprocessedBuffer = await preprocessImage(image.buffer, preprocessSettings);

          let exhibitLabel: string | undefined;
          if (useBoundaries) {
            const boundary = boundaries!.find(b => image.pageNumber >= b.startPage && image.pageNumber <= b.endPage);
            if (boundary) exhibitLabel = boundary.label;
          }

          const motionName = this.motionSections?.length
            ? findMotionForPage(image.pageNumber, this.motionSections)
            : undefined;

          const filename = buildImageFilename(
            documentId, image.pageNumber, image.imageIndex,
            this.filingType, exhibitLabel, motionName,
          );
          const imagePath = path.join(exhibitDir, filename);
          await fs.writeFile(imagePath, preprocessedBuffer);

          const ocrResult = await this.ocrEngine.recognizeImage(preprocessedBuffer);
          const relativeImagePath = `/exhibits/${caseId}/${filename}`;

          exhibits.push({
            pageNumber: image.pageNumber,
            imagePath: relativeImagePath,
            extractedText: ocrResult.text,
            confidence: ocrResult.confidence,
            exhibitLabel,
          });

          processedCount++;
          onProgress?.(processedCount, candidateImages.length);
        } catch (error) {
          this.logger.error(`Failed to process exhibit (legacy) page ${image.pageNumber}`, error, { documentId });
        }
      });
    }

    await queue.onIdle();
    return { exhibits, totalCount: exhibits.length };
  }

  /**
   * Cleanup resources
   * Should be called when extractor is no longer needed
   */
  async terminate(): Promise<void> {
    await this.ocrEngine.terminate();
  }
}
