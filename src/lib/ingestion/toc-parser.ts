/**
 * TOC Parser — extracts motion sections from a PDF's table of contents
 * (built-in outline or heading detection from page text).
 *
 * Used during ingestion to determine which motion an exhibit image belongs to,
 * enabling descriptive filenames like:
 *   reporters-record_motion-to-compel_exhibit-a_page20_img0.png
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PageText } from './pdf-parser';
import { createLogger } from '../logger';

const logger = createLogger('TocParser');

// ---------------------------------------------------------------------------
// pdfjs-dist lazy init (reuses the same polyfill pattern as pdf-parser.ts)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A section within a filing identified from the TOC / outline.
 * For a Reporter's Record this is typically a motion (e.g. "Motion to Compel").
 */
export interface MotionSection {
  /** Human-readable title from the TOC entry (e.g. "Motion to Compel Discovery") */
  title: string;
  /** 1-indexed start page */
  startPage: number;
  /** 1-indexed end page (inclusive). null = to end of document. */
  endPage: number | null;
}

// ---------------------------------------------------------------------------
// Outline-based extraction (built-in PDF bookmarks)
// ---------------------------------------------------------------------------

interface RawOutlineItem {
  title: string;
  dest: any;
  items?: RawOutlineItem[];
}

/**
 * Resolve a PDF outline destination to a 1-indexed page number.
 * Destinations can be: [pageRef, ...] arrays, named strings, or null.
 */
async function resolveDestToPage(pdfDoc: any, dest: any): Promise<number | null> {
  try {
    if (!dest) return null;

    // Named destination — resolve to explicit dest first
    if (typeof dest === 'string') {
      dest = await pdfDoc.getDestination(dest);
      if (!dest) return null;
    }

    // dest should now be an array: [pageRef, fitType, ...params]
    if (!Array.isArray(dest) || dest.length === 0) return null;

    const pageRef = dest[0];
    // getPageIndex returns 0-indexed
    const pageIndex = await pdfDoc.getPageIndex(pageRef);
    return pageIndex + 1; // convert to 1-indexed
  } catch {
    return null;
  }
}

/**
 * Flatten a nested outline tree into a flat list of { title, page } entries,
 * resolving all destinations to page numbers.
 */
async function flattenOutline(
  pdfDoc: any,
  items: RawOutlineItem[],
): Promise<{ title: string; page: number }[]> {
  const entries: { title: string; page: number }[] = [];

  for (const item of items) {
    const page = await resolveDestToPage(pdfDoc, item.dest);
    if (page !== null && item.title?.trim()) {
      entries.push({ title: item.title.trim(), page });
    }
    // Recurse into children
    if (item.items?.length) {
      const children = await flattenOutline(pdfDoc, item.items);
      entries.push(...children);
    }
  }

  // Sort by page number
  entries.sort((a, b) => a.page - b.page);
  return entries;
}

// ---------------------------------------------------------------------------
// Motion detection from TOC entries or page text
// ---------------------------------------------------------------------------

/**
 * Keywords that indicate a TOC entry is a motion or substantive filing section.
 * Matched case-insensitively against the title.
 */
const MOTION_KEYWORDS = [
  'motion',
  'petition',
  'order',
  'hearing',
  'testimony',
  'deposition',
  'affidavit',
  'brief',
  'response',
  'reply',
  'objection',
  'request',
  'notice',
  'memorandum',
  'argument',
  'trial',
  'proceeding',
  'voir dire',
  'cross-examination',
  'direct examination',
  'closing argument',
  'opening statement',
];

const MOTION_KEYWORD_RE = new RegExp(
  `\\b(?:${MOTION_KEYWORDS.join('|')})\\b`,
  'i',
);

/**
 * Headings in page text that look like motion titles.
 * Matches patterns commonly found in Reporter's Records and Clerk's Records.
 */
const MOTION_HEADING_PATTERNS = [
  // "MOTION TO COMPEL DISCOVERY" — all-caps motion heading
  /^\s*(MOTION\s+(?:TO|FOR|IN)\s+[A-Z\s]{3,})/im,
  // "PETITION FOR BILL OF REVIEW" — all-caps petition heading
  /^\s*(PETITION\s+(?:TO|FOR|IN|OF)\s+[A-Z\s]{3,})/im,
  // "ORDER ON MOTION TO COMPEL" — all-caps order heading
  /^\s*(ORDER\s+(?:ON|GRANTING|DENYING|FOR)\s+[A-Z\s]{3,})/im,
  // "HEARING ON MOTION..." — hearing reference
  /^\s*(HEARING\s+ON\s+[A-Z\s]{3,})/im,
  // "TESTIMONY OF JOHN DOE" — testimony sections in reporter's records
  /^\s*((?:DIRECT|CROSS|RE-DIRECT|RE-CROSS)\s+EXAMINATION\s+OF\s+.+)/im,
  /^\s*(TESTIMONY\s+OF\s+.+)/im,
  // "VOIR DIRE EXAMINATION" — jury selection
  /^\s*(VOIR\s+DIRE\s+(?:EXAMINATION|OF)\s+.+)/im,
  // "OPENING STATEMENT" / "CLOSING ARGUMENT"
  /^\s*((?:OPENING|CLOSING)\s+(?:STATEMENT|ARGUMENT)(?:\s+BY\s+.+)?)/im,
];

/**
 * Filter TOC entries to only motion-relevant sections.
 * Skips generic entries like "Table of Contents", "Index", "Certificate", etc.
 */
const SKIP_PATTERNS = [
  /^\s*(?:table\s+of\s+contents|index|certificate|appearance|caption|cover)/i,
  /^\s*(?:page|vol(?:ume)?\.?\s*\d)/i,
];

function isMotionEntry(title: string): boolean {
  if (SKIP_PATTERNS.some((p) => p.test(title))) return false;
  return MOTION_KEYWORD_RE.test(title);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract motion sections from a PDF using its built-in outline (bookmarks).
 *
 * Falls back to scanning page text for motion headings if no outline exists.
 *
 * @param filePath - Path to the PDF file
 * @param pages - Already-extracted page text (from text-extraction stage)
 * @param totalPages - Total page count of the document
 * @returns Array of MotionSection sorted by startPage
 */
export async function extractMotionSections(
  filePath: string,
  pages: PageText[],
  totalPages: number,
): Promise<MotionSection[]> {
  // Try outline-based extraction first
  let sections = await extractFromOutline(filePath, totalPages);

  if (sections.length > 0) {
    logger.info(`Extracted ${sections.length} motion sections from PDF outline`, {
      filePath: path.basename(filePath),
      sections: sections.map((s) => `${s.title} (pp. ${s.startPage}-${s.endPage ?? 'end'})`),
    });
    return sections;
  }

  // Fallback: detect motion headings from page text
  sections = extractFromPageText(pages, totalPages);

  if (sections.length > 0) {
    logger.info(`Detected ${sections.length} motion sections from page headings`, {
      filePath: path.basename(filePath),
      sections: sections.map((s) => `${s.title} (pp. ${s.startPage}-${s.endPage ?? 'end'})`),
    });
  } else {
    logger.debug('No motion sections found in outline or page text', {
      filePath: path.basename(filePath),
    });
  }

  return sections;
}

/**
 * Extract motion sections from the PDF's built-in outline/bookmarks.
 */
async function extractFromOutline(
  filePath: string,
  totalPages: number,
): Promise<MotionSection[]> {
  try {
    const pdfjsLib = await getPdfjsLib();
    const fileBuffer = await fs.readFile(filePath);
    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl: path.join(
        process.cwd(),
        'node_modules/pdfjs-dist/standard_fonts/',
      ),
    }).promise;

    try {
      const rawOutline = await pdfDoc.getOutline();
      if (!rawOutline?.length) return [];

      const entries = await flattenOutline(pdfDoc, rawOutline);
      if (entries.length === 0) return [];

      // Filter to motion-relevant entries
      const motionEntries = entries.filter((e) => isMotionEntry(e.title));

      if (motionEntries.length === 0) {
        // If no entries match motion keywords, use ALL outline entries
        // (the outline itself represents the document structure)
        return buildSections(entries, totalPages);
      }

      return buildSections(motionEntries, totalPages);
    } finally {
      await pdfDoc.destroy();
    }
  } catch (err) {
    logger.debug('Failed to extract PDF outline', {
      filePath: path.basename(filePath),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Detect motion sections from page text by scanning for motion heading patterns.
 */
function extractFromPageText(
  pages: PageText[],
  totalPages: number,
): MotionSection[] {
  const entries: { title: string; page: number }[] = [];

  for (const page of pages) {
    const lines = page.text.split('\n');
    for (const line of lines) {
      for (const pattern of MOTION_HEADING_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          const title = match[1].trim();
          // Skip very short matches (likely false positives)
          if (title.length < 10) continue;
          // Skip if we already found a heading on this page
          if (entries.length > 0 && entries[entries.length - 1].page === page.pageNumber) continue;
          entries.push({ title, page: page.pageNumber });
          break;
        }
      }
    }
  }

  return buildSections(entries, totalPages);
}

/**
 * Convert a flat list of { title, page } entries into MotionSection[] with page ranges.
 * Each section spans from its page to the page before the next section (or totalPages).
 */
function buildSections(
  entries: { title: string; page: number }[],
  totalPages: number,
): MotionSection[] {
  if (entries.length === 0) return [];

  // Deduplicate by page (keep first entry per page)
  const deduped: typeof entries = [];
  for (const e of entries) {
    if (deduped.length === 0 || deduped[deduped.length - 1].page !== e.page) {
      deduped.push(e);
    }
  }

  const sections: MotionSection[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const endPage = i + 1 < deduped.length
      ? deduped[i + 1].page - 1
      : totalPages;

    sections.push({
      title: deduped[i].title,
      startPage: deduped[i].page,
      endPage,
    });
  }

  return sections;
}

/**
 * Find which motion section a given page belongs to.
 * Returns the section title or undefined if the page is outside all sections.
 */
export function findMotionForPage(
  pageNumber: number,
  sections: MotionSection[],
): string | undefined {
  for (const section of sections) {
    const end = section.endPage ?? Infinity;
    if (pageNumber >= section.startPage && pageNumber <= end) {
      return section.title;
    }
  }
  return undefined;
}