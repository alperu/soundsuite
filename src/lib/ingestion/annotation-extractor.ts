/**
 * Extracts PDF annotations (highlights, strikethrough, underline, comments)
 * and maps them to the underlying text via coordinate matching.
 *
 * Uses pdfjs-dist's getAnnotations() + getTextContent() to correlate
 * annotation bounding boxes with positioned text items.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../logger';

const logger = createLogger('AnnotationExtractor');

// Lazy-init pdfjs-dist (reuse pattern from pdf-parser.ts)
let _pdfjsLib: any = null;

async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib;
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

/** Annotation types we care about */
export type AnnotationType = 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'comment';

/** A single annotation on a page with its covered text */
export interface PageAnnotation {
  type: AnnotationType;
  author?: string;
  comment?: string;
  color?: [number, number, number];
  coveredText: string;
  charStartOffset: number;
  charEndOffset: number;
  creationDate?: string;
}

// pdfjs-dist annotation subtype constants
const ANNOTATION_TYPE_MAP: Record<number, AnnotationType> = {
  1: 'comment',     // Text (sticky note)
  9: 'highlight',
  10: 'underline',
  11: 'squiggly',
  12: 'strikeout',
};

/**
 * Extract annotations for an entire PDF document.
 * Early-exits if the first 3 pages have no annotations.
 *
 * @param filePath Path to the PDF file
 * @param pageNumbers Optional subset of pages to extract (1-indexed)
 * @returns Map of pageNumber -> PageAnnotation[]
 */
export async function extractAnnotationsForDocument(
  filePath: string,
  pageNumbers?: number[],
): Promise<Map<number, PageAnnotation[]>> {
  const pdfjsLib = await getPdfjsLib();
  const fileBuffer = await fs.readFile(filePath);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
    wasmUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/'),
  }).promise;

  const result = new Map<number, PageAnnotation[]>();
  const totalPages = doc.numPages;
  const pagesToProcess = pageNumbers ?? Array.from({ length: totalPages }, (_, i) => i + 1);

  // Early exit: check first 3 pages for annotations
  let earlyCheckCount = 0;
  let foundAny = false;

  for (const pageNum of pagesToProcess) {
    if (pageNum < 1 || pageNum > totalPages) continue;

    const page = await doc.getPage(pageNum);
    const annotations = await extractPageAnnotations(page);
    page.cleanup();

    if (annotations.length > 0) {
      result.set(pageNum, annotations);
      foundAny = true;
    }

    earlyCheckCount++;
    // After checking 3 pages with no annotations, skip the rest
    if (earlyCheckCount >= 3 && !foundAny) {
      logger.debug('No annotations in first 3 pages, skipping rest', { filePath });
      break;
    }
  }

  await doc.destroy();

  if (result.size > 0) {
    let totalAnnotations = 0;
    for (const anns of result.values()) totalAnnotations += anns.length;
    logger.info('Extracted annotations from document', {
      filePath: path.basename(filePath),
      pagesWithAnnotations: result.size,
      totalAnnotations,
    });
  }

  return result;
}

/**
 * Extract annotations from a single PDF page.
 * Filters to markup annotations (highlight, underline, squiggly, strikeout)
 * and text annotations (sticky notes) that have content.
 */
export async function extractPageAnnotations(pdfPage: any): Promise<PageAnnotation[]> {
  const rawAnnotations = await pdfPage.getAnnotations({ intent: 'display' });

  // Filter to relevant annotation types
  const relevant = rawAnnotations.filter((ann: any) => {
    const subtype = ann.annotationType ?? ann.subtype;
    if (ANNOTATION_TYPE_MAP[subtype]) {
      // For comment (type 1), only include if it has actual content
      if (subtype === 1) return ann.contents && ann.contents.trim().length > 0;
      return true;
    }
    return false;
  });

  if (relevant.length === 0) return [];

  // Get positioned text items for coordinate matching
  const textContent = await pdfPage.getTextContent();
  const textItems = textContent.items.filter((item: any) => item.str && item.transform);

  // Build cumulative character offsets for text items
  let cumulativeOffset = 0;
  const itemsWithOffset = textItems.map((item: any) => {
    const startOffset = cumulativeOffset;
    cumulativeOffset += item.str.length;
    return { ...item, charStart: startOffset, charEnd: cumulativeOffset };
  });

  const annotations: PageAnnotation[] = [];

  for (const ann of relevant) {
    const subtype = ann.annotationType ?? ann.subtype;
    const type = ANNOTATION_TYPE_MAP[subtype];
    if (!type) continue;

    // Map annotation to covered text
    const mapped = mapAnnotationToText(ann, itemsWithOffset);

    // For markup annotations (not comments), skip if no text was matched
    if (type !== 'comment' && !mapped.coveredText) continue;

    const color = ann.color
      ? [Math.round(ann.color[0] * 255), Math.round(ann.color[1] * 255), Math.round(ann.color[2] * 255)] as [number, number, number]
      : undefined;

    annotations.push({
      type,
      author: ann.titleObj?.str || ann.title || undefined,
      comment: ann.contentsObj?.str || ann.contents || undefined,
      color,
      coveredText: mapped.coveredText,
      charStartOffset: mapped.startOffset,
      charEndOffset: mapped.endOffset,
      creationDate: ann.creationDate || undefined,
    });
  }

  return annotations;
}

/**
 * Map an annotation's bounding region to the text it covers.
 *
 * Uses quadPoints (if available) or the annotation rect to define
 * the bounding region, then checks which text items overlap.
 */
function mapAnnotationToText(
  annotation: any,
  textItems: Array<any & { charStart: number; charEnd: number }>,
): { coveredText: string; startOffset: number; endOffset: number } {
  const empty = { coveredText: '', startOffset: 0, endOffset: 0 };

  // Parse bounding boxes from quadPoints or rect
  const boxes = getAnnotationBoxes(annotation);
  if (boxes.length === 0) return empty;

  // Find text items that overlap with annotation boxes
  const matchedItems: Array<{ item: any; charStart: number; charEnd: number }> = [];

  for (const item of textItems) {
    const itemX = item.transform[4];
    const itemY = item.transform[5];
    const itemWidth = item.width || (item.str.length * 6); // rough fallback
    const itemXCenter = itemX + itemWidth / 2;
    const itemHeight = item.height || 12; // rough fallback
    const itemYCenter = itemY + itemHeight / 2;

    for (const box of boxes) {
      // Check if item's center falls within the annotation box (with tolerance)
      const tolerance = 2;
      if (
        itemXCenter >= box.minX - tolerance &&
        itemXCenter <= box.maxX + tolerance &&
        itemYCenter >= box.minY - tolerance &&
        itemYCenter <= box.maxY + tolerance
      ) {
        matchedItems.push({
          item,
          charStart: item.charStart,
          charEnd: item.charEnd,
        });
        break; // Don't double-count an item across boxes
      }
    }
  }

  if (matchedItems.length === 0) return empty;

  // Sort by position (y descending for PDF coords, then x ascending)
  matchedItems.sort((a, b) => {
    const yDiff = b.item.transform[5] - a.item.transform[5];
    if (Math.abs(yDiff) > 2) return yDiff;
    return a.item.transform[4] - b.item.transform[4];
  });

  const coveredText = matchedItems.map(m => m.item.str).join(' ');
  const startOffset = matchedItems[0].charStart;
  const endOffset = matchedItems[matchedItems.length - 1].charEnd;

  return { coveredText, startOffset, endOffset };
}

/**
 * Parse annotation bounding boxes from quadPoints or rect.
 * quadPoints is a Float32Array where every 8 floats = 4 corners of a quad.
 */
function getAnnotationBoxes(annotation: any): Array<{ minX: number; maxX: number; minY: number; maxY: number }> {
  const boxes: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = [];

  if (annotation.quadPoints && annotation.quadPoints.length >= 8) {
    const qp = annotation.quadPoints;
    for (let i = 0; i < qp.length; i += 8) {
      if (i + 7 >= qp.length) break;
      // quadPoints: 4 corners as (x,y) pairs
      const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]];
      const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
      boxes.push({
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      });
    }
  } else if (annotation.rect && annotation.rect.length === 4) {
    // rect: [x1, y1, x2, y2]
    boxes.push({
      minX: Math.min(annotation.rect[0], annotation.rect[2]),
      maxX: Math.max(annotation.rect[0], annotation.rect[2]),
      minY: Math.min(annotation.rect[1], annotation.rect[3]),
      maxY: Math.max(annotation.rect[1], annotation.rect[3]),
    });
  }

  return boxes;
}

/**
 * Build text augmentation markers for annotations to prepend to chunk text.
 * This makes annotations searchable via vector/FTS search.
 */
export function buildAnnotationMarkers(annotations: PageAnnotation[]): string {
  if (annotations.length === 0) return '';

  const markers: string[] = [];
  for (const ann of annotations) {
    const authorStr = ann.author ? ` by ${ann.author}` : '';
    const commentStr = ann.comment ? `: "${ann.comment}"` : '';
    const textSnippet = ann.coveredText
      ? `"${ann.coveredText.slice(0, 100)}${ann.coveredText.length > 100 ? '...' : ''}"`
      : '';

    switch (ann.type) {
      case 'strikeout':
        markers.push(`[STRUCK THROUGH${authorStr}${commentStr}] ${textSnippet}`);
        break;
      case 'highlight':
        markers.push(`[HIGHLIGHTED${authorStr}${commentStr}] ${textSnippet}`);
        break;
      case 'underline':
        markers.push(`[UNDERLINED${authorStr}${commentStr}] ${textSnippet}`);
        break;
      case 'squiggly':
        markers.push(`[SQUIGGLY UNDERLINED${authorStr}${commentStr}] ${textSnippet}`);
        break;
      case 'comment':
        markers.push(`[COMMENT${authorStr}] ${ann.comment || ''}`);
        break;
    }
  }

  return markers.join('\n') + '\n';
}
