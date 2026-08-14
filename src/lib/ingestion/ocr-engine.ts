import type { ChildProcess } from 'child_process';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Configuration for OCR Engine
 */
export interface OCRConfig {
  language: string; // Default: 'eng'
  tesseractPath?: string;
  /** Run sharp preprocessing (grayscale + normalize) before OCR. Default: false.
   *  PaddleOCR handles its own image normalization, so this is usually unnecessary. */
  preprocess?: boolean;
}

/**
 * Result from OCR processing
 */
export interface OCRResult {
  text: string;
  confidence: number;
}

/**
 * Common interface for all OCR engines (local PaddleOCR, Ollama vision, etc.)
 */
export interface IOCREngine {
  recognizeImage(imageBuffer: Buffer): Promise<OCRResult>;
  terminate(): Promise<void>;
}

/**
 * Recognition task for fixed-task recognizers (PaddleOCR-VL): plain text,
 * table structure, seal, formula, or chart recognition on a page/region image.
 */
export type OcrTask = 'ocr' | 'table' | 'seal' | 'formula' | 'chart';

/**
 * Opt-in capability interface for engines that support per-request task
 * selection. Deliberately NOT a widening of IOCREngine.recognizeImage —
 * the forked-child OCREngine cannot provide tasks and must not be forced
 * into a protocol change. Callers must feature-detect via asTaskEngine().
 */
export interface ITaskOCREngine extends IOCREngine {
  recognizeTask(imageBuffer: Buffer, task: OcrTask): Promise<OCRResult>;
  supportsTask(task: OcrTask): boolean;
}

/** Feature-detect task support. Returns null for engines without it. */
export function asTaskEngine(e: IOCREngine): ITaskOCREngine | null {
  return typeof (e as Partial<ITaskOCREngine>).recognizeTask === 'function'
    ? (e as ITaskOCREngine)
    : null;
}

/**
 * Wraps any IOCREngine with an in-memory cache keyed by SHA-256 of the image buffer.
 * Prevents re-OCR-ing the same image across pipeline stages (e.g. OCR fallback → exhibit extraction).
 * The cache is per-document — call clearCache() between documents.
 */
export class CachedOCREngine implements ITaskOCREngine {
  private inner: IOCREngine;
  private cache: Map<string, OCRResult>;

  /** Pass a shared cache Map so multiple CachedOCREngine instances share results. */
  constructor(inner: IOCREngine, sharedCache?: Map<string, OCRResult>) {
    this.inner = inner;
    this.cache = sharedCache || new Map();
  }

  /** Get the underlying cache Map (pass to other CachedOCREngine instances to share). */
  getCache(): Map<string, OCRResult> {
    return this.cache;
  }

  // Cache keys are `${task}:${sha256}` — the SAME image asked with different
  // tasks (OCR: vs Table Recognition:) yields different results and MUST NOT
  // collide. recognizeImage uses the 'ocr' task key so mixed callers share.
  private key(imageBuffer: Buffer, task: OcrTask): string {
    return `${task}:${crypto.createHash('sha256').update(imageBuffer).digest('hex')}`;
  }

  async recognizeImage(imageBuffer: Buffer): Promise<OCRResult> {
    const key = this.key(imageBuffer, 'ocr');
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = await this.inner.recognizeImage(imageBuffer);
    this.cache.set(key, result);
    return result;
  }

  async recognizeTask(imageBuffer: Buffer, task: OcrTask): Promise<OCRResult> {
    const taskEngine = asTaskEngine(this.inner);
    if (!taskEngine) {
      if (task === 'ocr') return this.recognizeImage(imageBuffer);
      throw new Error(`Inner OCR engine does not support task '${task}'`);
    }
    const key = this.key(imageBuffer, task);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = await taskEngine.recognizeTask(imageBuffer, task);
    this.cache.set(key, result);
    return result;
  }

  supportsTask(task: OcrTask): boolean {
    if (task === 'ocr') return true;
    return asTaskEngine(this.inner)?.supportsTask(task) ?? false;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async terminate(): Promise<void> {
    this.cache.clear();
    await this.inner.terminate();
  }
}

interface PendingRequest {
  resolve: (result: OCRResult) => void;
  reject: (error: Error) => void;
}

/**
 * OCR Engine that delegates to a forked child process running PaddleOCR
 * via @gutenye/ocr-node. The child process loads the model once and stays
 * alive between requests, keeping the main thread completely unblocked.
 */
export class OCREngine implements IOCREngine {
  private config: OCRConfig;
  private child: ChildProcess | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private tmpFilePath: string | null = null;

  constructor(config: OCRConfig = { language: 'eng' }) {
    this.config = { preprocess: false, ...config };
  }

  /**
   * Fork the child process and wait for it to signal readiness.
   */
  private ensureChild(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      // The OCR worker runs as a separate OS process (not bundled by Next.js).
      // We use eval('require') to make the fork() call completely opaque to
      // Turbopack's static analysis — otherwise it tries to resolve the worker
      // script path as a module dependency and fails at build time.
       
      const forkFn = (eval('require') as NodeRequire)('child_process').fork as
        typeof import('child_process').fork;
      const workerPath = path.join(process.cwd(), 'workers', 'ocr-worker.js');
      this.child = forkFn(workerPath, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      // Pipe child stdout/stderr to parent for debugging
      this.child.stdout?.on('data', (data: Buffer) => {
        process.stdout.write(`[ocr-worker] ${data}`);
      });
      this.child.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(`[ocr-worker] ${data}`);
      });

      const onMessage = (msg: { type: string; id?: string; text?: string; confidence?: number; error?: string }) => {
        if (msg.type === 'ready') {
          this.ready = true;
          resolve();
          return;
        }

        if ((msg.type === 'result' || msg.type === 'error') && msg.id) {
          const req = this.pending.get(msg.id);
          if (!req) return;
          this.pending.delete(msg.id);

          if (msg.type === 'result') {
            req.resolve({ text: msg.text || '', confidence: msg.confidence || 0 });
          } else {
            req.reject(new Error(msg.error || 'OCR worker error'));
          }
        }
      };

      this.child.on('message', onMessage);

      this.child.on('error', (err) => {
        this.ready = false;
        this.readyPromise = null;
        reject(err);
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          req.reject(new Error(`OCR worker process error: ${err.message}`));
          this.pending.delete(id);
        }
      });

      this.child.on('exit', (code) => {
        this.ready = false;
        this.readyPromise = null;
        this.child = null;
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          req.reject(new Error(`OCR worker process exited with code ${code}`));
          this.pending.delete(id);
        }
      });
    });

    return this.readyPromise;
  }

  /**
   * Preprocess image for better OCR results.
   * Applies grayscale conversion and contrast enhancement.
   */
  private async preprocessImage(imageBuffer: Buffer): Promise<Buffer> {
    return sharp(imageBuffer).grayscale().normalize().png().toBuffer();
  }

  /**
   * Get (or create) a reusable temp file path for this engine instance.
   * Each OCREngine handles one request at a time, so a single file is safe.
   */
  private getTmpFilePath(): string {
    if (!this.tmpFilePath) {
      this.tmpFilePath = path.join(os.tmpdir(), `ocr-${crypto.randomUUID()}.png`);
    }
    return this.tmpFilePath;
  }

  /**
   * Extract text from an image buffer by sending it to the child process.
   * @param imageBuffer - The image data as a Buffer
   * @returns OCR result with text and confidence score
   */
  async recognizeImage(imageBuffer: Buffer): Promise<OCRResult> {
    await this.ensureChild();

    if (!this.child || !this.child.connected) {
      throw new Error('OCR worker process is not available');
    }

    // Preprocess only if explicitly enabled (PaddleOCR handles its own normalization)
    const processedBuffer = this.config.preprocess
      ? await this.preprocessImage(imageBuffer)
      : imageBuffer;

    // Reuse the same temp file path — overwritten on each call
    const tmpFile = this.getTmpFilePath();
    await fs.writeFile(tmpFile, processedBuffer);

    const id = crypto.randomUUID();

    const result = await new Promise<OCRResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.send({ type: 'ocr', id, filePath: tmpFile });
    });
    return result;
  }

  /**
   * Cleanup resources — kill the child process.
   */
  async terminate(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.ready = false;
      this.readyPromise = null;
      this.pending.clear();
    }
    // Clean up reusable temp file
    if (this.tmpFilePath) {
      await fs.unlink(this.tmpFilePath).catch(() => {});
      this.tmpFilePath = null;
    }
  }
}
