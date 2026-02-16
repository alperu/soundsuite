/**
 * Poppler CLI wrapper for fast PDF image metadata scanning and extraction.
 *
 * Uses `pdfimages -list` to scan image metadata from the PDF xref table
 * without decoding pixel data (~1-2s for 400+ page PDFs).
 *
 * Uses `pdfimages -png -f N -l M` for batch image extraction of specific
 * page ranges, only decoding the images we actually need.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('PopplerImages');

/**
 * Metadata for a single image embedded in a PDF, from `pdfimages -list`.
 */
export interface PdfImageInfo {
  page: number;
  imageNum: number;
  type: string;       // image | mask | smask | stencil
  width: number;
  height: number;
  colorSpace: string; // rgb | gray | cmyk | icc
  bpc: number;        // bits per component
  encoding: string;   // jpeg | jp2 | jbig2 | ccitt | image (raw)
  sizeBytes: number;  // compressed size in PDF
  xPpi: number;
  yPpi: number;
}

/** Cache poppler availability check across calls */
let _popplerAvailable: boolean | null = null;

/**
 * Check if poppler's pdfimages CLI is available on the system.
 * Result is cached after the first call.
 */
export async function isPopplerAvailable(): Promise<boolean> {
  if (_popplerAvailable !== null) return _popplerAvailable;
  try {
    await execFileAsync('pdfimages', ['-v']);
    _popplerAvailable = true;
    logger.info('Poppler pdfimages is available');
  } catch {
    _popplerAvailable = false;
    logger.info('Poppler pdfimages not found — will use pdfdown fallback');
  }
  return _popplerAvailable;
}

/**
 * List all images in a PDF without extracting pixel data.
 * Reads the PDF xref table only — typically ~1-2s for 400+ page PDFs.
 *
 * @param filePath - Path to the PDF file
 * @returns Array of PdfImageInfo metadata for every image in the PDF
 */
export async function listPdfImages(filePath: string): Promise<PdfImageInfo[]> {
  const { stdout } = await execFileAsync('pdfimages', ['-list', filePath], {
    maxBuffer: 10 * 1024 * 1024, // 10MB — large PDFs can have thousands of images
  });
  return parsePdfImagesList(stdout);
}

/**
 * Extract images from a specific page range as PNG files.
 * Only decodes images within the specified range — much faster than extracting all.
 *
 * @param filePath - Path to the PDF file
 * @param firstPage - First page number (1-indexed)
 * @param lastPage - Last page number (1-indexed, inclusive)
 * @param outputDir - Directory to write extracted PNGs
 * @param prefix - Filename prefix for extracted images (e.g. "exhibit-")
 * @returns Array of absolute paths to extracted PNG files
 */
export async function extractPageRangeImages(
  filePath: string,
  firstPage: number,
  lastPage: number,
  outputDir: string,
  prefix: string,
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const outputPrefix = path.join(outputDir, prefix);

  await execFileAsync('pdfimages', [
    '-png',
    '-f', String(firstPage),
    '-l', String(lastPage),
    filePath,
    outputPrefix,
  ], {
    maxBuffer: 50 * 1024 * 1024, // 50MB for image extraction
    timeout: 120_000, // 2 min timeout per range
  });

  // Read the output directory and find all PNGs with our prefix
  const files = await fs.readdir(outputDir);
  return files
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort()
    .map(f => path.join(outputDir, f));
}

/**
 * Filter image metadata to find "worthy" images — large enough to be real
 * document content, not icons/logos/stamps/masks.
 *
 * @param images - Raw image metadata from listPdfImages()
 * @param options - Filtering thresholds
 * @returns Filtered array of worthy images
 */
export function filterWorthyImages(
  images: PdfImageInfo[],
  options: {
    minWidth?: number;
    minHeight?: number;
    minArea?: number;
    minBytes?: number;
  } = {},
): PdfImageInfo[] {
  const minWidth = options.minWidth ?? 150;
  const minHeight = options.minHeight ?? 150;
  const minArea = options.minArea ?? 40_000;
  const minBytes = options.minBytes ?? 5_000;

  return images.filter(img => {
    // Skip masks and stencils — these are transparency layers, not content
    if (img.type !== 'image') return false;
    if (img.width < minWidth || img.height < minHeight) return false;
    if (img.width * img.height < minArea) return false;
    if (img.sizeBytes > 0 && img.sizeBytes < minBytes) return false;
    return true;
  });
}

/**
 * Group an array of page numbers into contiguous ranges for efficient
 * pdfimages -f/-l calls. E.g. [1,2,3,7,8,12] → [[1,3],[7,8],[12,12]]
 */
export function groupIntoRanges(pages: number[]): Array<[number, number]> {
  if (pages.length === 0) return [];
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push([start, end]);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push([start, end]);
  return ranges;
}

// ─── Internal parser ────────────────────────────────────────────────

/**
 * Parse the tabular output from `pdfimages -list`.
 *
 * Example output:
 * ```
 * page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
 * --------------------------------------------------------------------------------------------
 *    1     0 image    2550  3300  rgb     3   8  jpeg   no        10  0   300   300  195K 2.4%
 * ```
 */
function parsePdfImagesList(output: string): PdfImageInfo[] {
  const lines = output.split('\n');
  const results: PdfImageInfo[] = [];

  // Skip header lines (first 2 lines: column headers + dashes separator)
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 14) continue;

    // Columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi [size] [ratio]
    const page = parseInt(parts[0], 10);
    if (isNaN(page)) continue;

    results.push({
      page,
      imageNum: parseInt(parts[1], 10),
      type: parts[2],
      width: parseInt(parts[3], 10),
      height: parseInt(parts[4], 10),
      colorSpace: parts[5],
      bpc: parseInt(parts[7], 10),
      encoding: parts[8],
      xPpi: parseInt(parts[12], 10),
      yPpi: parseInt(parts[13], 10),
      sizeBytes: parts.length > 14 ? parseSizeString(parts[14]) : 0,
    });
  }
  return results;
}

/**
 * Parse size strings like "95.2K", "1.2M", "512B" → bytes.
 */
function parseSizeString(s: string): number {
  const match = s.match(/^([\d.]+)\s*([KMG]?)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  switch (match[2].toUpperCase()) {
    case 'K': return Math.round(num * 1024);
    case 'M': return Math.round(num * 1024 * 1024);
    case 'G': return Math.round(num * 1024 * 1024 * 1024);
    default: return Math.round(num);
  }
}
