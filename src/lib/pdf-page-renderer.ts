/**
 * Server-side PDF page renderer using pdfjs-dist + @napi-rs/canvas.
 *
 * Used as a fallback for pages that fail client-side rendering (JPEG2000, etc.)
 * and for the page-image API endpoint.
 *
 * Features:
 * - LRU document pool (max 5 open PDFDocumentProxy instances)
 * - In-memory LRU page cache (keyed by filePath:pageNum:scale, max 200 entries)
 * - Real DOMMatrix + createCanvas from @napi-rs/canvas for proper rendering
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);

const logger = createLogger('PdfPageRenderer');

// NOTE: pdfjs concatenates filenames directly onto these ("wasmUrl + 'openjpeg.wasm'"),
// and path.join strips trailing slashes — the '/' must be re-appended or the
// JPX/JBIG2 wasm decoders fail to load and scanned-page bodies render blank.
const standardFontDataUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + '/';
const wasmUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm') + '/';
const cMapUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps') + '/';

// ---------------------------------------------------------------------------
// pdfjs-dist initialization (same pattern as pdf-parser.ts but with real DOMMatrix)
// ---------------------------------------------------------------------------

let _pdfjsLib: any = null;
let _napiCanvas: typeof import('@napi-rs/canvas') | null = null;

async function getNapiCanvas() {
  if (_napiCanvas) return _napiCanvas;
  _napiCanvas = await import('@napi-rs/canvas');
  return _napiCanvas;
}

async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib;

  // Use the REAL DOMMatrix/Path2D/ImageData from @napi-rs/canvas. pdfjs uses
  // DOMMatrix arithmetic for text/glyph transforms — the old no-op polyfill
  // (multiplySelf returning this, identity inverse) silently broke text
  // painting, producing blank page renders (only image XObjects like stamps
  // survived). Observed 2026-08-05 on the page-image viewer AND the OCR
  // full-page-render fallback, where blank renders caused hallucinated OCR.
  try {
    const napi = await getNapiCanvas();
    const n = napi as any;
    // FORCE-overwrite: pdf-parser.ts / filing-detector install their own
    // minimal no-op DOMMatrix polyfill at module load (fine for text
    // extraction, fatal for rendering — identity inverse/multiply smears
    // tiling patterns and drops image placement). Whichever module loads
    // first would otherwise win; rendering needs the real implementation.
    if (n.DOMMatrix) (globalThis as any).DOMMatrix = n.DOMMatrix;
    if (n.Path2D) (globalThis as any).Path2D = n.Path2D;
    if (n.ImageData) (globalThis as any).ImageData = n.ImageData;
  } catch {
    // Fallback polyfill if @napi-rs/canvas not available
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
  }

  // The legacy build carries pdfjs's Node.js support (NodeCanvasFactory,
  // fs-based font/wasm loading, no createImageBitmap/OffscreenCanvas
  // assumptions). The modern build assumes browser APIs and silently drops
  // image XObjects in Node — scanned-page bodies rendered blank.
  _pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  _pdfjsLib.GlobalWorkerOptions.workerPort = null;
  return _pdfjsLib;
}

// ---------------------------------------------------------------------------
// LRU Document Pool
// ---------------------------------------------------------------------------

interface PoolEntry {
  doc: any; // PDFDocumentProxy
  filePath: string;
  lastUsed: number;
}

const MAX_POOL_SIZE = 5;
const docPool: PoolEntry[] = [];

async function getPooledDocument(filePath: string): Promise<any> {
  // Check pool
  const idx = docPool.findIndex(e => e.filePath === filePath);
  if (idx >= 0) {
    docPool[idx].lastUsed = Date.now();
    return docPool[idx].doc;
  }

  // Evict oldest if full
  if (docPool.length >= MAX_POOL_SIZE) {
    docPool.sort((a, b) => a.lastUsed - b.lastUsed);
    const evicted = docPool.shift()!;
    try { await evicted.doc.destroy(); } catch {}
  }

  // Load new document
  const pdfjsLib = await getPdfjsLib();
  const fileBuffer = await fs.readFile(filePath);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    standardFontDataUrl,
    wasmUrl,
    // CID-keyed fonts (common in court-clerk scan text layers) need the CMap
    // tables to resolve glyphs; without cMapUrl those pages render with the
    // body text missing (only stamps/footers visible) — OCR then transcribes
    // just the footer. Observed on clerk-record pages 7-44, 2026-08-05.
    cMapUrl,
    cMapPacked: true,
    // Node has no FontFace API — without this, pdfjs skips glyph painting
    // for embedded fonts and pages render blank (graphics only). With it,
    // glyphs are drawn as vector paths from the embedded font programs.
    disableFontFace: true,
  }).promise;

  docPool.push({ doc, filePath, lastUsed: Date.now() });
  return doc;
}

// ---------------------------------------------------------------------------
// LRU Page Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  buffer: Buffer;
  width: number;
  height: number;
  lastUsed: number;
}

const MAX_CACHE_SIZE = 200;
const pageCache = new Map<string, CacheEntry>();

function cacheKey(filePath: string, pageNum: number, scale: number): string {
  return `${filePath}:${pageNum}:${scale}`;
}

function pruneCache() {
  if (pageCache.size <= MAX_CACHE_SIZE) return;
  const entries = [...pageCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
  for (const [key] of toRemove) {
    pageCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  /**
   * True when the buffer is NOT a faithful render of the page — the 1x1
   * placeholder or the blank white-canvas fallback produced after a render
   * failure. Consumers doing content analysis (blank-page ink checks, OCR)
   * must treat placeholder renders as "render failed", never as evidence
   * the page is empty.
   */
  placeholder?: boolean;
}

export interface DocumentInfo {
  numPages: number;
  defaultWidth: number;
  defaultHeight: number;
}

/**
 * Render a page via poppler's pdftoppm (subprocess). Preferred path: unlike
 * pdfjs-in-Node, poppler correctly paints scanned-image bodies, embedded-font
 * text, and tiling patterns (pdfjs silently dropped all three on clerk's
 * record pages — observed 2026-08-05: a text-dense scan rendered 0.67%
 * non-white ink through pdfjs vs. a complete page through pdftoppm).
 */
async function renderPageWithPoppler(filePath: string, pageNum: number, scale: number): Promise<RenderResult> {
  // PDF user space is 72 dpi; scale 1.5 → 108 dpi. Clamp to sane bounds.
  const dpi = Math.min(300, Math.max(36, Math.round(72 * scale)));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-page-render-'));
  try {
    const prefix = path.join(tmpDir, 'p');
    await execFileAsync('pdftoppm', [
      '-f', String(pageNum), '-l', String(pageNum),
      '-r', String(dpi),
      '-jpeg', '-jpegopt', 'quality=85',
      filePath, prefix,
    ], { timeout: 60_000 });

    const produced = (await fs.readdir(tmpDir)).filter(f => f.endsWith('.jpg'));
    if (produced.length !== 1) {
      throw new Error(`pdftoppm produced ${produced.length} files for page ${pageNum}`);
    }
    const buffer = await fs.readFile(path.join(tmpDir, produced[0]));
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buffer).metadata();
    return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render a single PDF page to a JPEG buffer — pdftoppm first, @napi-rs/canvas
 * + pdfjs as fallback when poppler is unavailable.
 */
export async function renderPage(filePath: string, pageNum: number, scale: number = 1.5): Promise<RenderResult> {
  const key = cacheKey(filePath, pageNum, scale);

  // Check cache
  const cached = pageCache.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return { buffer: cached.buffer, width: cached.width, height: cached.height };
  }

  try {
    const result = await renderPageWithPoppler(filePath, pageNum, scale);
    pageCache.set(key, { ...result, lastUsed: Date.now() });
    pruneCache();
    return result;
  } catch (popplerErr) {
    logger.warn('pdftoppm render failed — falling back to pdfjs canvas render', {
      pageNum,
      error: popplerErr instanceof Error ? popplerErr.message : String(popplerErr),
    });
  }

  const doc = await getPooledDocument(filePath);

  if (pageNum < 1 || pageNum > doc.numPages) {
    throw new Error(`Page ${pageNum} out of range (1-${doc.numPages})`);
  }

  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);

  let jpegBuffer: Buffer;
  let placeholder = false;

  try {
    const napi = await getNapiCanvas();
    const canvas = napi.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Render the page
    await page.render({
      canvasContext: ctx as any,
      viewport,
    }).promise;

    jpegBuffer = canvas.toBuffer('image/jpeg');
  } catch (renderErr) {
    // If @napi-rs/canvas rendering fails, fall back to sharp-based approach
    logger.warn('Canvas render failed, using sharp fallback', {
      pageNum,
      error: renderErr instanceof Error ? renderErr.message : String(renderErr),
    });

    const canvasData = new Uint8ClampedArray(width * height * 4);
    // White background
    for (let i = 0; i < canvasData.length; i += 4) {
      canvasData[i] = 255; canvasData[i + 1] = 255;
      canvasData[i + 2] = 255; canvasData[i + 3] = 255;
    }

    // Both branches below produce a stand-in, not a render of the page.
    placeholder = true;
    try {
      const sharp = (await import('sharp')).default;
      jpegBuffer = await sharp(Buffer.from(canvasData.buffer), {
        raw: { width, height, channels: 4 },
      }).jpeg({ quality: 85 }).toBuffer();
    } catch {
      // Last resort: return a 1x1 gray pixel
      jpegBuffer = createPlaceholderJpeg();
    }
  } finally {
    page.cleanup();
  }

  // Cache the result (placeholders are NOT cached — a later retry may succeed)
  if (!placeholder) {
    pageCache.set(key, { buffer: jpegBuffer, width, height, lastUsed: Date.now() });
    pruneCache();
  }

  return { buffer: jpegBuffer, width, height, placeholder };
}

/**
 * Get page dimensions at scale=1 without rendering.
 */
export async function getPageDimensions(filePath: string, pageNum: number): Promise<{ width: number; height: number }> {
  const doc = await getPooledDocument(filePath);
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  page.cleanup();
  return { width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
}

/**
 * Get basic document info without rendering any pages.
 */
export async function getDocumentInfo(filePath: string): Promise<DocumentInfo> {
  const doc = await getPooledDocument(filePath);
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  page.cleanup();
  return {
    numPages: doc.numPages,
    defaultWidth: Math.floor(viewport.width),
    defaultHeight: Math.floor(viewport.height),
  };
}

/**
 * Create a minimal 1x1 gray JPEG for error fallback.
 */
function createPlaceholderJpeg(): Buffer {
  // Minimal JPEG: 1x1 gray pixel
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0x7b, 0x94, 0x11, 0x00, 0x00, 0x00, 0x00, 0xff,
    0xd9,
  ]);
}

/**
 * Evict a document from the pool (e.g. when file changes on disk).
 */
export async function evictDocument(filePath: string): Promise<void> {
  const idx = docPool.findIndex(e => e.filePath === filePath);
  if (idx >= 0) {
    try { await docPool[idx].doc.destroy(); } catch {}
    docPool.splice(idx, 1);
  }
  // Also clear cached pages for this document
  for (const key of pageCache.keys()) {
    if (key.startsWith(filePath + ':')) {
      pageCache.delete(key);
    }
  }
}
