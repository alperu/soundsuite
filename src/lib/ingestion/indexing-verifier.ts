/**
 * Indexing verification — checks that every page was properly parsed,
 * reports gaps, and logs warnings for potential issues.
 */

import { PrismaClient } from '@prisma/client';
import { createLogger } from '../logger';

const logger = createLogger('IndexingVerifier');

export interface VerificationResult {
  /** Total pages in the PDF */
  totalPages: number;
  /** Pages that have text in PageCache */
  pagesWithText: number;
  /** Pages with no text at all */
  pagesWithoutText: number;
  /** Pages processed via OCR */
  ocrPages: number;
  /** Page numbers that have no text (gaps) */
  gapPages: number[];
  /** Total chunks inserted into LanceDB */
  totalChunksIndexed: number;
  /** Informational warnings */
  warnings: string[];
}

/**
 * Verify that a document was fully indexed by checking:
 * 1. Every page has text in PageCache
 * 2. Low-density pages were OCR'd
 * 3. Chunk count is reasonable relative to page count
 *
 * @param documentId - The document ID to verify
 * @param totalPages - Total page count from PDF
 * @param totalChunks - Number of chunks indexed into LanceDB
 * @param database - Prisma client
 */
export async function verifyIndexing(
  documentId: string,
  totalPages: number,
  totalChunks: number,
  database: PrismaClient,
): Promise<VerificationResult> {
  const warnings: string[] = [];
  const gapPages: number[] = [];
  let pagesWithText = 0;
  let pagesWithoutText = 0;
  let ocrPages = 0;

  try {
    // Load all cached pages
    const cachedPages = await (database as any).pageCache.findMany({
      where: { documentId },
      select: { pageNumber: true, text: true, textDensity: true, source: true },
    });

    const pageMap = new Map<number, { text: string; textDensity: number; source: string }>();
    for (const page of cachedPages) {
      pageMap.set(page.pageNumber, page);
    }

    // Check each page
    for (let p = 1; p <= totalPages; p++) {
      const cached = pageMap.get(p);
      if (!cached || !cached.text || cached.text.trim().length === 0) {
        pagesWithoutText++;
        gapPages.push(p);
      } else {
        pagesWithText++;
        if (cached.source === 'ocr') {
          ocrPages++;
        }
      }
    }

    // Check for gaps
    if (gapPages.length > 0) {
      const maxDisplay = 10;
      const displayPages = gapPages.slice(0, maxDisplay).join(', ');
      const suffix = gapPages.length > maxDisplay ? ` ... and ${gapPages.length - maxDisplay} more` : '';
      warnings.push(`${gapPages.length} page(s) have no extracted text: ${displayPages}${suffix}`);
    }

    // Check for suspiciously low chunk count
    if (totalChunks === 0 && totalPages > 0) {
      warnings.push('No chunks were indexed despite having pages — document may be image-only without OCR results');
    } else if (totalPages > 0 && totalChunks < totalPages * 0.3) {
      warnings.push(`Low chunk count (${totalChunks}) relative to page count (${totalPages}) — some pages may have insufficient text`);
    }

    // Check OCR coverage
    const expectedOcrThreshold = 50; // matches pipeline config
    const lowDensityPages = cachedPages.filter((p: any) => p.source === 'extract' && p.textDensity < expectedOcrThreshold);
    if (lowDensityPages.length > 0) {
      const pageNums = lowDensityPages.slice(0, 5).map((p: any) => p.pageNumber).join(', ');
      warnings.push(`${lowDensityPages.length} page(s) have low text density but were not OCR'd: ${pageNums}`);
    }
  } catch (error) {
    warnings.push(`Verification error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result: VerificationResult = {
    totalPages,
    pagesWithText,
    pagesWithoutText,
    ocrPages,
    gapPages,
    totalChunksIndexed: totalChunks,
    warnings,
  };

  // Log result
  if (warnings.length > 0) {
    logger.warn('Indexing verification warnings', {
      documentId,
      ...result,
      gapPages: gapPages.length > 20 ? `${gapPages.length} pages` : gapPages,
    });
  } else {
    logger.info('Indexing verification passed', {
      documentId,
      totalPages,
      pagesWithText,
      ocrPages,
      totalChunksIndexed: totalChunks,
    });
  }

  return result;
}
