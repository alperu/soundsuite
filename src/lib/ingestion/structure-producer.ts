/**
 * structure-producer — the hybrid two-producer orchestrator.
 * PLAN-ss-docparse §0.1 step 3.
 *
 * Attaches DocparseBlock[] to each PageText:
 *  - born-digital pages (textDensity ≥ threshold): PdfBlockExtractor
 *    (producer 'pdf'), then table-candidate escalation — crop the region
 *    (page-region-cropper) and ask ss-ocr `Table Recognition:`; OTSL output
 *    is normalized into html/markdown, and the block's text becomes the
 *    normalized cell text (§6.2 decision 5). A failed/rejected/unsupported
 *    escalation keeps the geometry-derived plain text — region failures
 *    NEVER zero a block.
 *  - scanned pages (below threshold, text from OCR): one flat paragraph
 *    block (producer 'ocr', bbox null). Scanned-side table-span escalation
 *    is deferred pending crop-accuracy work (Phase 0: escalation IS needed,
 *    but line-index→y-band mapping is the design's weakest link).
 *  - transcript documents (transcriptDoc=true, PLAN-rr-structure): RR
 *    speaker-turn blocks from page.rrLines, all pages structureOnly — the
 *    geometry extractor never runs (its per-page isTranscript carve-out
 *    remains as a belt-and-suspenders guard for mislabeled docs).
 */

import { extractPageBlocks } from './pdf-block-extractor';
import { cropRegion, type RegionCrop, type CropOptions } from './page-region-cropper';
import { asTaskEngine, type IOCREngine } from './ocr-engine';
import { normalizeTableOutput } from './otsl';
import type { PageText } from './pdf-parser';
import { createLogger } from '../logger';

const logger = createLogger('StructureProducer');

export interface StructureCounters {
  pdfBlockPages: number;
  ocrFlatPages: number;
  tableRegionsAttempted: number;
  tableRegionsAccepted: number;
  /** Pages given RR speaker-turn blocks (transcriptDoc route). */
  rrPages: number;
  /** Figure blocks OCR'd via the 'ocr' task (task #11). */
  figuresOcrAttempted: number;
  figuresOcrAccepted: number;
}

export interface ProduceOptions {
  filePath: string;
  pages: PageText[];
  /** Density threshold separating born-digital from scanned (pipeline's ocrThreshold). */
  ocrThreshold: number;
  /** Engine for table escalation; escalation is skipped when absent or when
   * the engine does not support the 'table' task. */
  ocrEngine?: IOCREngine | null;
  /** Reporter's Record / transcript document (PLAN-rr-structure item 6).
   * Fed from the pipeline's isRR union — the SAME signal that routed text
   * extraction through extractTextForRR. When true, ALL pages get RR
   * speaker-turn blocks from page.rrLines and structureOnly=true, so the
   * StructuredChunker delegates the whole document to the legacy chunker
   * (chunk text byte-identical) while Meta View gets full structure. */
  transcriptDoc?: boolean;
  /** Injectable for tests. */
  cropFn?: (filePath: string, pageNum: number, bbox: [number, number, number, number], opts?: CropOptions) => Promise<RegionCrop | null>;
  extractFn?: typeof extractPageBlocks;
  /**
   * Progress feedback for long runs (escalation OCR on exhibit-heavy pages
   * can take minutes) — called after each processed page with a live detail
   * string. Consumers publish it to the doc-progress channel so the UI
   * never shows a stale "Starting...".
   */
  onProgress?: (done: number, total: number, detail: string) => void;
}

/**
 * Mutates pages in place (sets page.blocks) and returns counters.
 * Never throws for per-page/per-region failures.
 */
export async function produceStructuredPages(opts: ProduceOptions): Promise<StructureCounters> {
  const crop = opts.cropFn ?? cropRegion;
  const extract = opts.extractFn ?? extractPageBlocks;
  const counters: StructureCounters = {
    pdfBlockPages: 0,
    ocrFlatPages: 0,
    tableRegionsAttempted: 0,
    tableRegionsAccepted: 0,
    rrPages: 0,
    figuresOcrAttempted: 0,
    figuresOcrAccepted: 0,
  };

  // Transcript documents: RR blocks from the lines already reconstructed by
  // extractTextForRR — never the geometry extractor, never table escalation.
  // structureOnly is set on EVERY page (even ones without rrLines) so the
  // chunking gate is document-level, matching the byte-identity guarantee.
  if (opts.transcriptDoc) {
    const { buildRRBlocks } = await import('./rr-block-producer');
    let rrDone = 0;
    for (const page of opts.pages) {
      page.structureOnly = true;
      rrDone++;
      if (rrDone % 50 === 0) {
        opts.onProgress?.(rrDone, opts.pages.length, `Structuring transcript page ${page.pageNumber}`);
      }
      if (!page.rrLines || page.rrLines.length === 0) continue;
      const blocks = buildRRBlocks(page.rrLines, page.pageHeight ?? 0);
      if (blocks.length === 0) continue;
      page.blocks = blocks;
      counters.rrPages++;
    }
    logger.info('RR structure produced', { rrPages: counters.rrPages, file: opts.filePath.split('/').pop() });
    return counters;
  }

  const bornDigital = opts.pages.filter(p => p.textDensity >= opts.ocrThreshold && p.text.trim().length > 0);
  const scanned = opts.pages.filter(p => p.textDensity < opts.ocrThreshold && p.text.trim().length > 0);

  // Scanned pages: flat single block, no geometry.
  for (const page of scanned) {
    page.blocks = [{ type: 'paragraph', text: page.text, bbox: null, order: 0 }];
    counters.ocrFlatPages++;
  }

  if (bornDigital.length === 0) return counters;

  opts.onProgress?.(scanned.length, scanned.length + bornDigital.length, `Extracting geometry for ${bornDigital.length} page(s)...`);
  let extracted;
  try {
    extracted = await extract(opts.filePath, bornDigital.map(p => p.pageNumber));
  } catch (err) {
    logger.warn('Block extraction failed — pages stay unstructured', {
      error: err instanceof Error ? err.message : String(err),
    });
    return counters;
  }
  const byPage = new Map(extracted.map(r => [r.pageNumber, r]));

  const taskEngine = opts.ocrEngine ? asTaskEngine(opts.ocrEngine) : null;
  const canEscalate = !!taskEngine && taskEngine.supportsTask('table');

  let structuredDone = 0;
  for (const page of bornDigital) {
    structuredDone++;
    opts.onProgress?.(
      scanned.length + structuredDone,
      scanned.length + bornDigital.length,
      `Structuring page ${page.pageNumber} (tables ${counters.tableRegionsAccepted}/${counters.tableRegionsAttempted}, figures ${counters.figuresOcrAccepted}/${counters.figuresOcrAttempted})`,
    );
    const result = byPage.get(page.pageNumber);
    if (!result || result.blocks.length === 0) continue;
    page.blocks = result.blocks;
    if (result.width) page.pageWidth = result.width;
    if (result.height) page.pageHeight = result.height;
    counters.pdfBlockPages++;

    // Figure OCR (task #11): crop each embedded-image region and run the
    // plain 'ocr' task so exhibit screenshots carry their text in Meta View.
    // Failures/rejections leave text '' — never fatal.
    if (taskEngine && taskEngine.supportsTask('ocr')) {
      for (const block of result.blocks) {
        if (block.type !== 'figure' || !block.bbox) continue;
        counters.figuresOcrAttempted++;
        try {
          const region = await crop(opts.filePath, page.pageNumber, block.bbox);
          if (!region) continue;
          const ocr = await taskEngine.recognizeTask(region.buffer, 'ocr');
          if (ocr.text && ocr.text.trim().length > 0) {
            block.text = ocr.text.trim();
            counters.figuresOcrAccepted++;
            // Line alignment (best-effort): ink-density bands from the crop
            // give each OCR line its true position so Meta View can
            // superimpose text where it appears in the image. Empty on
            // band/line-count disagreement — the viewer falls back to the
            // unaligned panel.
            try {
              const sharp = (await import('sharp')).default;
              const { data, info } = await sharp(region.buffer)
                .grayscale()
                .raw()
                .toBuffer({ resolveWithObject: true });
              const { detectTextBands, alignOcrLines } = await import('./figure-line-align');
              const bands = detectTextBands(new Uint8Array(data), info.width, info.height);
              const aligned = alignOcrLines(block.text, bands, region);
              if (aligned.length > 0) block.lines = aligned;
            } catch (alignErr) {
              logger.debug?.('Figure line alignment failed — unaligned panel', {
                pageNumber: page.pageNumber,
                error: alignErr instanceof Error ? alignErr.message : String(alignErr),
              });
            }
          }
        } catch (err) {
          logger.warn('Figure OCR failed — figure keeps empty text', {
            pageNumber: page.pageNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (!canEscalate) continue;
    for (const block of result.blocks) {
      if (block.type !== 'table' || !block.bbox) continue;
      counters.tableRegionsAttempted++;
      try {
        const region = await crop(opts.filePath, page.pageNumber, block.bbox);
        if (!region) continue;
        const ocr = await taskEngine!.recognizeTask(region.buffer, 'table');
        if (!ocr.text) continue; // gate-rejected or empty — keep plain text
        const normalized = normalizeTableOutput(ocr.text);
        if (normalized.format === 'text' || normalized.rowCount < 2) continue;
        block.html = normalized.html;
        block.markdown = normalized.markdown;
        if (normalized.cellText.trim().length > 0) block.text = normalized.cellText;
        counters.tableRegionsAccepted++;
      } catch (err) {
        logger.warn('Table escalation failed — block keeps plain text', {
          pageNumber: page.pageNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info('Structured pages produced', { ...counters, file: opts.filePath.split('/').pop() });
  return counters;
}
