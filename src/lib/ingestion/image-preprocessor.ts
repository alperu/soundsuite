/**
 * ImagePreprocessor — batch-processes extracted PDF images through sharp
 * for OCR optimization before sending to any OCR engine (local or Ollama).
 *
 * Pipeline: smart upscale → grayscale → normalize → CLAHE → sharpen → smart downscale → PNG
 *
 * Smart upscale: If width < 1000px or DPI < 150, upscale 2x with Lanczos3.
 * For 95% of legal documents, sharp + Lanczos3 upscaling is all you need
 * to make small text readable for MiniCPM-V / olmOCR.
 *
 * Each step can be toggled via ImagePreprocessSettings.
 * Saves optimized images to public/exhibits/{caseId}/ with descriptive naming.
 */

import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExtractedImage } from './pdf-parser';
import { createLogger } from '../logger';
import { MotionSection, findMotionForPage } from './toc-parser';

const logger = createLogger('ImagePreprocessor');

/** Default max width for downscaled images (keeps text readable, cuts size) */
const DEFAULT_MAX_WIDTH = 2048;
/** Width threshold below which images are upscaled for better OCR */
const DEFAULT_MIN_WIDTH = 1000;
/** DPI threshold below which images are upscaled.
 * Default 0 (disabled) — PDF-extracted images almost always report 72 DPI
 * (the PDF standard default), which is meaningless metadata, not actual
 * scan resolution. Width-based upscaling is reliable; DPI-based is not. */
const DEFAULT_MIN_DPI = 0;
/** Default sharp concurrency for batch processing */
const DEFAULT_CONCURRENCY = 4;

/**
 * Per-step settings for the image preprocessing pipeline.
 * All toggles default to true. The admin dashboard can override these.
 */
export interface ImagePreprocessSettings {
  /** Smart upscale small/low-DPI images with Lanczos3. Default: true */
  upscale?: boolean;
  /** Min width in pixels — images below this are upscaled 2x. Default: 1000 */
  minWidth?: number;
  /** Min DPI — images below this are upscaled 2x (if DPI metadata available). Default: 150 */
  minDpi?: number;
  /** Convert to grayscale. ~30% fewer tokens for OCR. Default: true */
  grayscale?: boolean;
  /** Normalize (stretch contrast). +5-10% on faded scans. Default: true */
  normalize?: boolean;
  /** CLAHE (adaptive contrast). +10-15% on poor scans. Default: true */
  clahe?: boolean;
  /** CLAHE clip limit (contrast amplification factor). Default: 3 */
  claheClipLimit?: number;
  /** Sharpen text edges. +3-5% accuracy. Default: true */
  sharpen?: boolean;
  /** Sharpen sigma (Gaussian blur radius). Default: 1.0 */
  sharpenSigma?: number;
  /** Smart downscale (only if image exceeds maxWidth after upscale). Default: true */
  resize?: boolean;
  /** Max width in pixels (aspect ratio preserved). Default: 2048 */
  maxWidth?: number;
  /** PNG compression level (0-9). Default: 6 */
  pngCompressionLevel?: number;
}

/** Default preprocessing settings — all steps enabled except DPI upscale */
export const DEFAULT_PREPROCESS_SETTINGS: Required<ImagePreprocessSettings> = {
  upscale: true,
  minWidth: DEFAULT_MIN_WIDTH,
  minDpi: DEFAULT_MIN_DPI, // 0 = disabled (PDF DPI metadata is unreliable)
  grayscale: true,
  normalize: true,
  clahe: true,
  claheClipLimit: 3,
  sharpen: true,
  sharpenSigma: 1.0,
  resize: true,
  maxWidth: DEFAULT_MAX_WIDTH,
  pngCompressionLevel: 6,
};

export interface PreprocessedImage {
  buffer: Buffer;
  filePath: string;        // Absolute path where optimized image was saved
  relativePath: string;    // Web-accessible path: /exhibits/{caseId}/{filename}
  pageNumber: number;
  imageIndex: number;
  originalSizeKB: number;
  optimizedSizeKB: number;
}

export interface PreprocessOptions {
  /** Batch concurrency for sharp processing. Default: 4 */
  concurrency?: number;
  /** Document ID for naming */
  documentId: string;
  /** Case ID for directory structure */
  caseId: string;
  /** Filing type from detection stage (e.g. "motion", "exhibit"). Falls back to "doc" */
  filingType?: string;
  /** Motion sections from TOC parsing. Used to look up motion name per image page. */
  motionSections?: MotionSection[];
  /** Public directory root. Default: "public" */
  publicDir?: string;
  /** Per-step preprocessing settings. Uses defaults if not provided. */
  settings?: ImagePreprocessSettings;
}

/**
 * Sanitize a string for use in filenames — lowercase, alphanumeric + hyphens only.
 */
function sanitizeForFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30); // cap length
}

/**
 * Build the descriptive filename for an optimized exhibit image.
 *
 * Format: {docId}_{filingType}_{motionName}_{exhibitLabel}_page{N}_img{M}.png
 * - filingType falls back to "doc" if not detected
 * - motionName is included when the image falls within a TOC motion section
 * - exhibitLabel is omitted if not available
 *
 * Examples:
 *   f9046761_reporters-record_motion-to-compel_page20_img0.png
 *   f9046761_reporters-record_motion-to-compel_exhibit-a_page20_img0.png
 */
export function buildImageFilename(
  documentId: string,
  pageNumber: number,
  imageIndex: number,
  filingType?: string,
  exhibitLabel?: string,
  motionName?: string,
): string {
  const docPrefix = documentId.slice(0, 8); // short hash prefix
  const filing = sanitizeForFilename(filingType || 'doc');
  const parts = [docPrefix, filing];

  if (motionName) {
    parts.push(sanitizeForFilename(motionName));
  }

  if (exhibitLabel) {
    parts.push(sanitizeForFilename(exhibitLabel));
  }

  parts.push(`page${pageNumber}`, `img${imageIndex}`);
  return parts.join('_') + '.png';
}

/**
 * Preprocess a single image through the sharp pipeline.
 *
 * Full pipeline (each step configurable):
 *   smart upscale → grayscale → normalize → CLAHE → sharpen → smart downscale → PNG
 *
 * Smart upscale (Step 0): If width < minWidth (1000px) or DPI < minDpi (150),
 * upscale 2x with Lanczos3 kernel. For 95% of legal documents, sharp + Lanczos3
 * is all you need to make small text readable for MiniCPM-V / olmOCR.
 *
 * Smart downscale (Step 5): Only downsizes if image exceeds maxWidth after
 * upscale, preventing unnecessary resampling of already-small images.
 *
 * @param imageBuffer - Raw image data
 * @param settings - Per-step toggle/parameter overrides
 * @returns Optimized PNG buffer
 */
export async function preprocessImage(
  imageBuffer: Buffer,
  settings?: ImagePreprocessSettings,
): Promise<Buffer> {
  const s = { ...DEFAULT_PREPROCESS_SETTINGS, ...settings };

  // Read metadata once for upscale + downscale decisions
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 0;
  const imgDpi = metadata.density || 0; // DPI from EXIF/metadata (0 if unavailable)

  // Step 0: Smart upscale — small images or low DPI get 2x Lanczos3 upscale
  // This runs BEFORE other steps to preserve maximum detail from the original.
  let inputBuffer = imageBuffer;
  if (s.upscale) {
    const tooSmall = imgWidth > 0 && imgWidth < s.minWidth;
    const lowDpi = s.minDpi > 0 && imgDpi > 0 && imgDpi < s.minDpi;
    const needsUpscale = tooSmall || lowDpi;

    if (needsUpscale) {
      const targetWidth = imgWidth * 2;
      inputBuffer = await sharp(imageBuffer)
        .resize({
          width: targetWidth,
          kernel: 'lanczos3',
          withoutEnlargement: false,
        })
        .toBuffer();

      logger.info('Upscaled small/low-DPI image', {
        originalWidth: imgWidth,
        targetWidth,
        dpi: imgDpi || 'unknown',
        reason: imgWidth < s.minWidth ? `width < ${s.minWidth}px` : `DPI < ${s.minDpi}`,
      });
    }
  }

  let pipeline = sharp(inputBuffer);

  // Step 1: Grayscale — 1 channel vs 3, ~30% fewer tokens for OCR
  if (s.grayscale) {
    pipeline = pipeline.grayscale();
  }

  // Step 2: Normalize — stretch contrast so faint text becomes clear
  if (s.normalize) {
    pipeline = pipeline.normalize();
  }

  // Step 3: CLAHE — adaptive contrast for shadows, bleed-through, uneven lighting
  if (s.clahe) {
    pipeline = pipeline.clahe({
      width: 8,   // tile grid size
      height: 8,
      maxSlope: s.claheClipLimit,
    });
  }

  // Step 4: Sharpen — crisper text edges for fewer recognition errors
  if (s.sharpen) {
    pipeline = pipeline.sharpen({ sigma: s.sharpenSigma });
  }

  // Step 5: Smart downscale — only if image exceeds maxWidth (after potential upscale)
  if (s.resize) {
    // Re-read width after upscale (may have changed)
    const currentMeta = inputBuffer !== imageBuffer
      ? await sharp(inputBuffer).metadata()
      : metadata;
    const currentWidth = currentMeta.width || 0;

    if (currentWidth > s.maxWidth) {
      pipeline = pipeline.resize({
        width: s.maxWidth,
        kernel: 'lanczos3',
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  }

  // Step 6: PNG output — avoids JPEG artifacts around text
  return pipeline
    .png({ compressionLevel: s.pngCompressionLevel })
    .toBuffer();
}

/**
 * Batch-preprocess extracted PDF images for OCR optimization.
 *
 * 1. Applies sharp pipeline: upscale → grayscale → normalize → CLAHE → sharpen → downscale → PNG
 * 2. Saves optimized images to public/exhibits/{caseId}/
 * 3. Returns PreprocessedImage[] with buffers and metadata
 */
export async function batchPreprocessImages(
  images: ExtractedImage[],
  options: PreprocessOptions,
): Promise<PreprocessedImage[]> {
  if (images.length === 0) return [];

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const publicDir = options.publicDir ?? 'public';
  const settings = options.settings;

  // Ensure output directory exists
  const exhibitDir = path.join(publicDir, 'exhibits', options.caseId);
  await fs.mkdir(exhibitDir, { recursive: true });

  const results: PreprocessedImage[] = [];
  let totalOriginalKB = 0;
  let totalOptimizedKB = 0;

  // Process in batches for controlled concurrency
  const { default: PQueue } = await import('p-queue');
  const queue = new PQueue({ concurrency });

  for (const image of images) {
    queue.add(async () => {
      const originalSizeKB = Math.round(image.buffer.length / 1024);
      totalOriginalKB += originalSizeKB;

      const optimizedBuffer = await preprocessImage(image.buffer, settings);
      const optimizedSizeKB = Math.round(optimizedBuffer.length / 1024);
      totalOptimizedKB += optimizedSizeKB;

      // Look up motion name for this image's page
      const motionName = options.motionSections?.length
        ? findMotionForPage(image.pageNumber, options.motionSections)
        : undefined;

      const filename = buildImageFilename(
        options.documentId,
        image.pageNumber,
        image.imageIndex,
        options.filingType,
        undefined, // exhibitLabel — not available in batch mode
        motionName,
      );
      const absolutePath = path.join(exhibitDir, filename);
      const relativePath = `/exhibits/${options.caseId}/${filename}`;

      // Save to disk
      await fs.writeFile(absolutePath, optimizedBuffer);

      results.push({
        buffer: optimizedBuffer,
        filePath: absolutePath,
        relativePath,
        pageNumber: image.pageNumber,
        imageIndex: image.imageIndex,
        originalSizeKB,
        optimizedSizeKB,
      });
    });
  }

  await queue.onIdle();

  const reductionPct = totalOriginalKB > 0
    ? Math.round((1 - totalOptimizedKB / totalOriginalKB) * 100)
    : 0;

  logger.info('Batch preprocessing complete', {
    imageCount: images.length,
    totalOriginalKB,
    totalOptimizedKB,
    reductionPercent: reductionPct,
    documentId: options.documentId,
  });

  return results;
}

/**
 * Clear all cached/optimized images for a specific document from the exhibits directory.
 * Used during reindex to prevent stale images.
 */
export async function clearDocumentExhibits(
  caseId: string,
  documentId: string,
  publicDir: string = 'public',
): Promise<number> {
  const exhibitDir = path.join(publicDir, 'exhibits', caseId);
  const docPrefix = documentId.slice(0, 8);
  let removed = 0;

  try {
    const files = await fs.readdir(exhibitDir);
    for (const file of files) {
      if (file.startsWith(docPrefix)) {
        await fs.unlink(path.join(exhibitDir, file));
        removed++;
      }
    }
  } catch (err: any) {
    // Directory doesn't exist yet — nothing to clear
    if (err.code !== 'ENOENT') {
      logger.warn('Failed to clear document exhibits', {
        caseId,
        documentId,
        error: err.message,
      });
    }
  }

  if (removed > 0) {
    logger.info('Cleared cached exhibit images', { caseId, documentId, removedCount: removed });
  }

  return removed;
}
