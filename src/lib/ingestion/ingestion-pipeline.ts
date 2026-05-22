/**
 * IngestionPipeline orchestrates the complete document processing workflow.
 *
 * This class wires together all ingestion components (PDFParser, OCREngine,
 * TextChunker, EmbeddingProvider, VectorStore) and manages the document
 * processing lifecycle from QUEUED → PROCESSING → INDEXED (or ERROR).
 *
 * Requirements: 2.4, 2.5, 2.6, 2.7, 3.4
 */

import { PDFParser, PageText } from './pdf-parser';
import { IOCREngine, OCREngine, CachedOCREngine } from './ocr-engine';
import { ITextChunker, Chunk, SacContext } from './text-chunker';
import { EmbeddingProvider, EmbeddedChunk } from './embedding-provider';
import { DocumentSummarizer } from './document-summarizer';
import { VectorStore } from '../vector/vector-store';
import { ExhibitExtractor, ExhibitMetadata, ExhibitBoundary, detectExhibitBoundaries } from './exhibit-extractor';
import { preprocessImage, batchPreprocessImages, clearDocumentExhibits } from './image-preprocessor';
import { extractMotionSections, MotionSection } from './toc-parser';
import { isPopplerAvailable, listPdfImages, filterWorthyImages, PdfImageInfo } from './poppler-images';
import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../logger';
import { getRedis, isRedisAvailable } from '../redis';
import { verifyIndexing, VerificationResult } from './indexing-verifier';
import { extractAnnotationsForDocument, PageAnnotation, buildAnnotationMarkers } from './annotation-extractor';
import { detectLineNumbers } from '../citations/line-number-detector';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PIPELINE_STAGES } from '../pipeline-stages';
// p-queue is ESM-only; use dynamic import to avoid Jest transform issues
type PQueueType = import('p-queue').default;

/**
 * Thrown when a document's status has been set to STOPPED by the user.
 * Caught in processDocument() to cleanly abort without setting ERROR status.
 */
class DocumentStoppedError extends Error {
  constructor(documentId: string, stage: string) {
    super(`Document ${documentId} was stopped by user during stage "${stage}"`);
    this.name = 'DocumentStoppedError';
  }
}

/**
 * Lightweight checkpoint for stage-level resume tracking.
 * Stored as JSON in Document.ingestCheckpoint.
 * Per-page text data is stored in the PageCache table.
 */
export interface IngestCheckpoint {
  lastCompletedStage?: string;
  totalPages?: number;
  updatedAt?: string;
}

/**
 * Result from filing type detection
 */
export interface FilingDetectionResult {
  filingType: string;
  title: string;
  confidence: number;
  source: 'regex' | 'semantic' | 'cache';
}

/**
 * Result from document ingestion
 */
export interface IngestionResult {
  success: boolean;
  pageCount?: number;
  exhibitCount?: number;
  chunkCount?: number;
  ocrFallbackPages?: number;
  filingDetection?: FilingDetectionResult;
  error?: string;
  failedStage?: string;
  stageTimings?: Record<string, number>;
}

/**
 * Configuration for IngestionPipeline
 */
export interface IngestionPipelineConfig {
  publicDir?: string;
  ocrThreshold?: number; // Text density threshold for OCR (default: 50)
  embeddingBatchSize?: number; // Max chunks per embedding/indexing batch (default: 100)
  ocrConcurrency?: number; // Number of parallel OCR workers for fallback (default: 2)
  /** CPU load average threshold (per core) above which OCR workers are reduced. Default: 0.8 */
  cpuThreshold?: number;
  /** When true, OCR runs on a remote GPU — skip local CPU load throttling. */
  ocrRemote?: boolean;
  /** Image preprocessing settings for OCR optimization. Uses defaults if not provided. */
  preprocessSettings?: import('./image-preprocessor').ImagePreprocessSettings;
}

/**
 * IngestionPipeline orchestrates the complete document processing workflow.
 *
 * The pipeline processes documents through these stages:
 * 1. Preflight — file size, page count, memory diagnostics
 * 2. Filing detection — identify filing type from first pages
 * 3. Extract text and images from PDF
 * 4. Apply OCR to low-density pages and exhibits
 * 5. Chunk text into overlapping segments
 * 6. Generate embeddings for all chunks
 * 7. Index chunks in vector store
 *
 * The pipeline updates document status at each stage and handles errors
 * by rolling back partial data and setting ERROR status.
 */
export class IngestionPipeline {
  private pdfParser: PDFParser;
  private ocrEngine: CachedOCREngine;
  private ocrWorkerPool: IOCREngine[];
  private textChunker: ITextChunker;
  private embeddingProvider: EmbeddingProvider;
  private vectorStore: VectorStore;
  private exhibitExtractor: ExhibitExtractor;
  private database: PrismaClient;
  private config: IngestionPipelineConfig;
  private logger: Logger;
  private currentStage: string = '';

  constructor(
    pdfParser: PDFParser,
    ocrEngine: IOCREngine,
    textChunker: ITextChunker,
    embeddingProvider: EmbeddingProvider,
    vectorStore: VectorStore,
    database: PrismaClient,
    config: IngestionPipelineConfig = {},
    ocrWorkerFactory?: () => IOCREngine,
  ) {
    this.pdfParser = pdfParser;
    // Wrap OCR engine with cache so OCR fallback + exhibit extraction share results
    this.ocrEngine = new CachedOCREngine(ocrEngine);
    this.textChunker = textChunker;
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.database = database;
    this.exhibitExtractor = new ExhibitExtractor(config.publicDir || 'public', pdfParser, this.ocrEngine);
    this.config = {
      ocrThreshold: config.ocrThreshold || 50,
      embeddingBatchSize: config.embeddingBatchSize || 50,
      ocrConcurrency: config.ocrConcurrency ?? 2,
      cpuThreshold: config.cpuThreshold ?? 0.8,
      ...config,
    };
    this.logger = createLogger('IngestionPipeline');

    // Create OCR worker pool. Each worker shares the same OCR result cache
    // so exhibit extraction can reuse results from the OCR fallback stage.
    const poolSize = this.config.ocrConcurrency!;
    this.ocrWorkerPool = [];
    const sharedCache = this.ocrEngine.getCache();
    const factory = ocrWorkerFactory || (() => new OCREngine());
    for (let i = 0; i < poolSize; i++) {
      this.ocrWorkerPool.push(new CachedOCREngine(factory(), sharedCache));
    }
    this.logger.info(`OCR worker pool created`, { poolSize });
  }

  /**
   * Publish granular stage progress to Redis so the UI can display
   * what the parser is currently doing for each document.
   * Key: soundsuite:doc_progress:{documentId}, TTL: 5 minutes.
   */
  private async publishProgress(documentId: string, stage: string, detail: string, progress: number): Promise<void> {
    try {
      if (await isRedisAvailable()) {
        const key = `soundsuite:doc_progress:${documentId}`;
        const redis = getRedis();
        const stageIndex = PIPELINE_STAGES.indexOf(stage as any);
        const totalStages = PIPELINE_STAGES.length;
        await redis.hmset(key, {
          stage,
          detail,
          progress: String(Math.round(progress)),
          stageIndex: String(stageIndex >= 0 ? stageIndex : 0),
          totalStages: String(totalStages),
        });
        await redis.expire(key, 300); // 5 min TTL
      }
    } catch {
      // Non-critical — UI will just not show detail
    }
  }

  /**
   * Start a periodic heartbeat that re-publishes the current stage progress
   * to Redis every 60 seconds, keeping the 5-minute TTL alive during long stages.
   */
  private startHeartbeat(documentId: string, stage: string, detail: string, progress: number): NodeJS.Timeout {
    let currentDetail = detail;
    let currentProgress = progress;
    const interval = setInterval(() => {
      this.publishProgress(documentId, stage, currentDetail, currentProgress).catch(() => {});
    }, 60_000);
    // Attach updater so callers can update detail/progress without restarting the heartbeat
    (interval as any).__updateHeartbeat = (newDetail: string, newProgress: number) => {
      currentDetail = newDetail;
      currentProgress = newProgress;
    };
    return interval;
  }

  /**
   * Update the detail and progress values of a running heartbeat timer.
   */
  private updateHeartbeat(hb: NodeJS.Timeout, detail: string, progress: number): void {
    (hb as any).__updateHeartbeat?.(detail, progress);
  }

  /**
   * Clear progress from Redis when processing is done.
   */
  private async clearProgress(documentId: string): Promise<void> {
    try {
      if (await isRedisAvailable()) {
        await getRedis().del(`soundsuite:doc_progress:${documentId}`);
      }
    } catch { /* ignore */ }
  }

  /* ─────────── Checkpoint / PageCache helpers for crash-resume ─────────── */

  /**
   * Load stage-level checkpoint from the database.
   */
  private async loadCheckpoint(documentId: string): Promise<IngestCheckpoint | null> {
    try {
      const doc = await this.database.document.findUnique({
        where: { id: documentId },
        select: { ingestCheckpoint: true },
      });
      if (doc?.ingestCheckpoint) {
        return JSON.parse(doc.ingestCheckpoint) as IngestCheckpoint;
      }
    } catch {
      this.logger.warn('Failed to load checkpoint', { documentId });
    }
    return null;
  }

  /**
   * Save stage-level checkpoint.
   */
  private async saveStageCheckpoint(documentId: string, stage: string, totalPages?: number): Promise<void> {
    try {
      const data: IngestCheckpoint = { lastCompletedStage: stage, totalPages, updatedAt: new Date().toISOString() };
      await this.database.document.update({
        where: { id: documentId },
        data: { ingestCheckpoint: JSON.stringify(data) },
      });
    } catch {
      this.logger.warn('Failed to save stage checkpoint', { documentId, stage });
    }
  }

  /**
   * Save a single page's text to the PageCache table (upsert).
   * Retries up to 3 times with exponential backoff to handle SQLite write contention.
   */
  private async cachePageText(
    documentId: string,
    pageNumber: number,
    text: string,
    textDensity: number,
    source: 'extract' | 'ocr',
    confidence?: number
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await (this.database as any).pageCache.upsert({
          where: { documentId_pageNumber: { documentId, pageNumber } },
          create: { documentId, pageNumber, text, textDensity, source, confidence },
          update: { text, textDensity, source, confidence },
        });
        return;
      } catch (e) {
        const isTimeout = e instanceof Error && (e.message.includes('timed out') || e.message.includes('SQLITE_BUSY'));
        if (isTimeout && attempt < 2) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        this.logger.warn('Failed to cache page text', { documentId, pageNumber, attempt, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /**
   * Batch-insert extracted pages into PageCache using createMany.
   * Filters out pages that already exist to avoid unique constraint violations.
   * (Prisma+SQLite does not support skipDuplicates.)
   */
  private async batchCachePages(
    documentId: string,
    pages: { pageNumber: number; text: string; textDensity: number }[]
  ): Promise<void> {
    if (pages.length === 0) return;
    try {
      // Find which pages already exist in cache to avoid unique constraint violations
      const existing = await (this.database as any).pageCache.findMany({
        where: { documentId },
        select: { pageNumber: true },
      });
      const existingPages = new Set(existing.map((r: { pageNumber: number }) => r.pageNumber));
      const newPages = pages.filter(p => !existingPages.has(p.pageNumber));

      if (newPages.length === 0) return;

      // SQLite has a variable limit per statement (~999). Batch in groups of 100.
      for (let i = 0; i < newPages.length; i += 100) {
        const batch = newPages.slice(i, i + 100);
        await (this.database as any).pageCache.createMany({
          data: batch.map(p => ({
            documentId,
            pageNumber: p.pageNumber,
            text: p.text,
            textDensity: p.textDensity,
            source: 'extract',
          })),
        });
      }
    } catch (e) {
      this.logger.warn('Failed to batch cache pages', {
        documentId, count: pages.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Load all cached pages for a document from PageCache.
   * Returns a Map of pageNumber -> { text, textDensity, source, confidence }.
   */
  private async loadPageCache(documentId: string): Promise<Map<number, { text: string; textDensity: number; source: string; confidence: number | null }>> {
    const map = new Map<number, { text: string; textDensity: number; source: string; confidence: number | null }>();
    try {
      const rows = await (this.database as any).pageCache.findMany({
        where: { documentId },
        select: { pageNumber: true, text: true, textDensity: true, source: true, confidence: true },
      });
      for (const row of rows) {
        map.set(row.pageNumber, { text: row.text, textDensity: row.textDensity, source: row.source, confidence: row.confidence });
      }
    } catch {
      this.logger.warn('Failed to load page cache', { documentId });
    }
    return map;
  }

  /**
   * Clear checkpoint and page cache after successful completion.
   */
  private async clearCheckpoint(documentId: string): Promise<void> {
    try {
      await this.database.document.update({
        where: { id: documentId },
        data: { ingestCheckpoint: null },
      });
    } catch { /* ignore */ }
    try {
      await (this.database as any).pageCache.deleteMany({ where: { documentId } });
    } catch { /* ignore */ }
  }

  /**
   * Format a duration in milliseconds to a human-readable string.
   */
  private static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  }

  /**
   * Get the effective OCR concurrency based on current CPU load.
   * When CPU load (1-minute average per core) exceeds the threshold,
   * reduce concurrency to 1. Otherwise use the configured pool size.
   */
  private getEffectiveOcrConcurrency(): number {
    const maxConcurrency = this.ocrWorkerPool.length;

    // Remote OCR (Ollama on GPU) — no local CPU throttling needed
    if (this.config.ocrRemote) {
      return maxConcurrency;
    }

    // Local OCR — throttle based on CPU load
    const cpuCount = os.cpus().length;
    const loadAvg1m = os.loadavg()[0];
    const loadPerCore = loadAvg1m / cpuCount;
    const threshold = this.config.cpuThreshold ?? 0.8;

    if (loadPerCore > threshold) {
      const reduced = Math.max(1, Math.floor(maxConcurrency / 2));
      this.logger.info(`CPU load high, reducing OCR concurrency`, {
        loadAvg1m: loadAvg1m.toFixed(2),
        loadPerCore: loadPerCore.toFixed(2),
        cpuCount,
        threshold,
        concurrency: `${maxConcurrency} → ${reduced}`,
      });
      return reduced;
    }

    return maxConcurrency;
  }

  /**
   * Check if the document has been stopped by the user.
   * Queries the database for the current status and throws DocumentStoppedError if STOPPED.
   */
  private async checkIfStopped(documentId: string): Promise<void> {
    const doc = await this.database.document.findUnique({
      where: { id: documentId },
      select: { status: true },
    });
    if (doc?.status === 'STOPPED') {
      throw new DocumentStoppedError(documentId, this.currentStage);
    }
  }

  /**
   * Run a pipeline stage with timing, memory tracking, and structured logging.
   * Checks for stop signal before each stage.
   * On failure, re-throws with a descriptive message including stage name and duration.
   */
  private async runStage<T>(
    name: string,
    documentId: string,
    stageTimings: Record<string, number>,
    fn: () => Promise<T>
  ): Promise<T> {
    // Check for stop signal before starting each stage
    await this.checkIfStopped(documentId);

    this.currentStage = name;
    const heapBefore = process.memoryUsage().heapUsed;
    const stageStart = Date.now();

    this.logger.info(`[Stage: ${name}] Starting`, { documentId });

    try {
      const result = await fn();
      const durationMs = Date.now() - stageStart;
      const heapDeltaMB = ((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(1);
      stageTimings[name] = durationMs;

      this.logger.info(`[Stage: ${name}] Completed`, {
        documentId,
        durationMs,
        durationHuman: IngestionPipeline.formatDuration(durationMs),
        heapDeltaMB,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - stageStart;
      stageTimings[name] = durationMs;
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      const errName = error instanceof Error ? error.constructor.name : typeof error;

      this.logger.error(`[Stage: ${name}] Failed after ${IngestionPipeline.formatDuration(durationMs)}`, error, {
        documentId,
        stage: name,
        durationMs,
        errorType: errName,
        errorMessage: errMsg,
        errorStack: errStack,
        embeddingProvider: this.embeddingProvider?.getModelName?.() ?? 'unknown',
      });

      throw new Error(`Stage "${name}" failed after ${IngestionPipeline.formatDuration(durationMs)}: ${errMsg}`);
    }
  }

  /**
   * Run preflight diagnostics — file size, page count, and memory snapshot.
   * Warns if the file is larger than 50 MB.
   */
  private async runPreflight(filePath: string, documentId: string): Promise<{
    fileSizeBytes: number;
    fileSizeMB: string;
    estimatedPageCount: number;
    isLargeFile: boolean;
  }> {
    const stat = await fs.stat(filePath);
    const fileSizeBytes = stat.size;
    const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(1);
    const estimatedPageCount = await this.pdfParser.getPageCount(filePath);
    const mem = process.memoryUsage();

    this.logger.info('Preflight diagnostic', {
      documentId,
      fileSizeMB: `${fileSizeMB}MB`,
      estimatedPageCount,
      heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(0),
      rssMB: (mem.rss / 1024 / 1024).toFixed(0),
    });

    const isLargeFile = fileSizeBytes > 50 * 1024 * 1024;
    if (isLargeFile) {
      this.logger.warn('Large file detected - processing may take extended time', {
        documentId,
        fileSizeMB: `${fileSizeMB}MB`,
      });
    }

    return { fileSizeBytes, fileSizeMB, estimatedPageCount, isLargeFile };
  }

  /**
   * Process a document through the complete ingestion pipeline.
   *
   * This method orchestrates all stages of document processing:
   * - Updates status to PROCESSING
   * - Runs preflight diagnostics
   * - Extracts text and images
   * - Applies OCR where needed
   * - Chunks text
   * - Generates embeddings
   * - Indexes in vector store
   * - Updates status to INDEXED on success or ERROR on failure
   * - Creates JobLog record
   *
   * @param documentId - UUID of the document to process
   * @param filePath - Path to the PDF file
   * @returns IngestionResult with success status and metadata
   */
  async processDocument(documentId: string, filePath: string): Promise<IngestionResult> {
    const startTime = Date.now();
    let jobLogId: string | null = null;
    const stageTimings: Record<string, number> = {};
    let documentLoaded = false;

    this.logger.info(`Starting document processing`, { documentId, filePath });

    // Clear OCR cache from previous document
    if (this.ocrEngine instanceof CachedOCREngine) {
      this.ocrEngine.clearCache();
    }

    try {
      // Get document from database to get caseId
      const document = await this.database.document.findUnique({
        where: { id: documentId },
        include: { case: true },
      });

      if (!document) {
        throw new Error(`Document ${documentId} not found in database`);
      }

      const caseId = document.caseId;

      // Create JobLog record
      const jobLog = await this.database.jobLog.create({
        data: {
          documentsQueued: 1,
          documentsProcessed: 0,
          documentsFailed: 0,
        },
      });
      jobLogId = jobLog.id;

      // Update document status to PROCESSING
      await this.database.document.update({
        where: { id: documentId },
        data: { status: 'PROCESSING' },
      });

      // Remove any existing vectors for this document (reindex scenario)
      try {
        await this.vectorStore.deleteByDocument(documentId);
        this.logger.debug('Cleared existing vectors before re-indexing', { documentId });
      } catch {
        // Table may not exist yet on first run — safe to ignore
      }

      // Clear cached exhibit images from previous run (reindex scenario)
      await clearDocumentExhibits(caseId, documentId, this.config.publicDir || 'public');

      // Load document into cache once for entire pipeline run
      await this.pdfParser.loadDocument(filePath);
      documentLoaded = true;

      // Stage: preflight
      await this.publishProgress(documentId, 'preflight', 'Checking file...', 0);
      await this.runStage('preflight', documentId, stageTimings, () =>
        this.runPreflight(filePath, documentId)
      );

      // Stage: filing-detection
      await this.publishProgress(documentId, 'filing-detection', 'Detecting filing type...', 5);
      let filingDetection: FilingDetectionResult | undefined;
      try {
        filingDetection = await this.runStage('filing-detection', documentId, stageTimings, () =>
          this.detectFilingType(filePath, documentId, caseId)
        );
      } catch (detectionError) {
        this.logger.warn('Filing type detection failed, continuing with ingestion', { documentId });
      }

      // Stage: text-extraction
      // Route Reporter's Record documents to layout-aware extraction for line numbers
      const isRR = filingDetection?.filingType
        ? (() => {
            const ft = filingDetection.filingType.toLowerCase();
            return ft.includes('reporter') || ft === 'rr';
          })()
        : false;
      await this.publishProgress(documentId, 'text-extraction', isRR ? 'Extracting text (layout-aware for RR)...' : 'Extracting text...', 10);
      const pages = await this.runStage('text-extraction', documentId, stageTimings, () =>
        isRR ? this.extractTextRR(filePath, documentId) : this.extractText(filePath, documentId)
      );
      const pageCount = pages.length;

      // Stage: document-summarization (SAC) — runs after text extraction so we have page text
      await this.publishProgress(documentId, 'document-summarization', 'Generating document summary...', 23);
      let documentSummary: string | null = null;
      try {
        documentSummary = await this.runStage('document-summarization', documentId, stageTimings, async () => {
          const summarizer = new DocumentSummarizer();
          // Use first 5 pages of extracted text for summary context
          const headerText = pages.slice(0, 5).map(p => p.text).join('\n\n');
          return summarizer.generateSummary({
            headerText,
            filingType: filingDetection?.filingType,
            filingTitle: filingDetection?.title,
            fileName: path.basename(filePath),
          });
        });
        if (documentSummary) {
          await this.database.document.update({
            where: { id: documentId },
            data: { documentSummary },
          });
          this.logger.info('Document summary generated for SAC', {
            documentId,
            summaryLength: documentSummary.length,
          });
        }
      } catch (summaryError) {
        this.logger.warn('Document summarization failed, continuing without SAC', { documentId });
      }

      // Update page count
      await this.database.document.update({
        where: { id: documentId },
        data: { pageCount },
      });

      // ═══════════════════════════════════════════════════════════════════
      // POPPLER-FIRST FLOW: scan metadata → detect boundaries → targeted extraction
      // ═══════════════════════════════════════════════════════════════════

      // Stage: image-scan — fast metadata scan via poppler (or pdfdown fallback)
      await this.publishProgress(documentId, 'image-scan', 'Scanning image metadata...', 25);
      let worthyImagePages = new Set<number>();
      let popplerImages: PdfImageInfo[] | null = null;

      await this.runStage('image-scan', documentId, stageTimings, async () => {
        const popplerOk = await isPopplerAvailable();
        if (popplerOk) {
          const allPopplerImages = await listPdfImages(filePath);
          const worthy = filterWorthyImages(allPopplerImages);
          popplerImages = allPopplerImages;
          worthyImagePages = new Set(worthy.map(img => img.page));
          this.logger.info(`Poppler scan found ${allPopplerImages.length} images, ${worthy.length} worthy on ${worthyImagePages.size} pages`, {
            documentId,
            totalImages: allPopplerImages.length,
            worthyImages: worthy.length,
            worthyPages: worthyImagePages.size,
          });
        } else {
          // Fallback: use pdfdown's imagePages list
          const { pdfDown } = await (this.pdfParser as any).getOrLoadPdfDown(filePath);
          const doc = await pdfDown.documentAsync();
          worthyImagePages = new Set<number>(doc.imagePages as number[]);
          this.logger.info(`Poppler not available, using pdfdown image page list: ${worthyImagePages.size} pages with images`, {
            documentId,
            pagesWithImages: worthyImagePages.size,
          });
        }
      });

      // Stage: exhibit-boundary-detection — regex scan for "EXHIBIT A" etc.
      await this.publishProgress(documentId, 'exhibit-boundary-detection', 'Detecting exhibit boundaries...', 30);
      let exhibitBoundaries: ExhibitBoundary[] = [];
      await this.runStage('exhibit-boundary-detection', documentId, stageTimings, async () => {
        exhibitBoundaries = detectExhibitBoundaries(pages);
        if (exhibitBoundaries.length > 0) {
          this.logger.info(`Detected ${exhibitBoundaries.length} exhibit boundaries from text layer`, {
            documentId,
            boundaries: exhibitBoundaries.map((b) => `${b.label} (pp. ${b.startPage}-${b.endPage})`),
          });
        }
      });

      // Stage: toc-extraction — extract motion sections from PDF outline/text
      await this.publishProgress(documentId, 'toc-extraction', 'Extracting table of contents...', 33);
      let motionSections: MotionSection[] = [];
      await this.runStage('toc-extraction', documentId, stageTimings, async () => {
        try {
          motionSections = await extractMotionSections(filePath, pages, pageCount);
          if (motionSections.length > 0) {
            this.logger.info(`Extracted ${motionSections.length} motion sections from TOC`, {
              documentId,
              sections: motionSections.map((s) => `${s.title} (pp. ${s.startPage}-${s.endPage ?? 'end'})`),
            });
          }
        } catch (tocError) {
          this.logger.warn('TOC parsing failed, continuing without motion names', { documentId });
        }
      });

      // Pass filing type and motion sections to exhibit extractor for descriptive image naming
      this.exhibitExtractor.filingType = filingDetection?.filingType;
      this.exhibitExtractor.motionSections = motionSections;

      // Stage: exhibit-extraction (poppler-driven — targeted extraction + OCR)
      await this.publishProgress(documentId, 'exhibit-extraction', 'Extracting exhibits...', 35);
      let exhibitHb = this.startHeartbeat(documentId, 'exhibit-extraction', 'Extracting exhibits...', 35);
      let exhibitResult: { exhibits: ExhibitMetadata[]; totalCount: number };
      try {
        exhibitResult = await this.runStage('exhibit-extraction', documentId, stageTimings, () =>
          this.extractExhibits(filePath, caseId, documentId, exhibitBoundaries, (processed, total) => {
            const subProgress = 35 + Math.round((processed / total) * 14); // 35-49%
            const detail = `Processing exhibit ${processed}/${total}...`;
            this.updateHeartbeat(exhibitHb, detail, subProgress);
            this.publishProgress(documentId, 'exhibit-extraction', detail, subProgress).catch(() => {});
          }, {
            popplerImages: popplerImages ?? undefined,
            worthyImagePages,
            pages,
            motionSections,
            preprocessSettings: this.config.preprocessSettings,
          })
        );
      } finally {
        clearInterval(exhibitHb);
      }
      const exhibitCount = exhibitResult.totalCount;

      // Build set of pages handled by exhibit extraction for OCR fallback skip.
      // Includes both exhibit boundary pages AND motion section pages,
      // since buildInterestingPages() in the exhibit extractor processes both.
      const exhibitPageSet = new Set<number>();
      for (const b of exhibitBoundaries) {
        for (let p = b.startPage; p <= b.endPage; p++) {
          exhibitPageSet.add(p);
        }
      }
      for (const s of motionSections) {
        const endPage = s.endPage ?? s.startPage + 50;
        for (let p = s.startPage; p <= endPage; p++) {
          exhibitPageSet.add(p);
        }
      }

      // Stage: ocr-fallback — only non-exhibit low-density pages
      await this.publishProgress(documentId, 'ocr-fallback', 'Checking for OCR pages...', 50);
      let ocrHb = this.startHeartbeat(documentId, 'ocr-fallback', 'Checking for OCR pages...', 50);
      let ocrFallbackCount: number;
      try {
        ocrFallbackCount = await this.runStage('ocr-fallback', documentId, stageTimings, () =>
          this.applyOcrFallback(pages, filePath, documentId, ocrHb, exhibitPageSet)
        );
      } finally {
        clearInterval(ocrHb);
      }

      // Update exhibit count
      await this.database.document.update({
        where: { id: documentId },
        data: { detectedExhibits: exhibitCount },
      });

      // Stage: annotation-extraction (non-fatal — extracts highlights, strikethrough, comments)
      let pageAnnotations = new Map<number, PageAnnotation[]>();
      try {
        await this.publishProgress(documentId, 'text-chunking', 'Extracting annotations...', 58);
        pageAnnotations = await this.runStage('annotation-extraction', documentId, stageTimings, () =>
          extractAnnotationsForDocument(filePath)
        );
      } catch (annError) {
        this.logger.warn('Annotation extraction failed (non-fatal)', {
          documentId,
          error: annError instanceof Error ? annError.message : String(annError),
        });
      }

      // Stage: text-chunking
      // Build SAC context: case name, filing type, and document summary
      // are prepended to every chunk for better embedding retrieval quality.
      const sacContext: SacContext = {
        caseName: document.case?.name,
        filingType: filingDetection?.filingType,
        documentSummary: documentSummary || undefined,
      };

      await this.publishProgress(documentId, 'text-chunking', 'Chunking text...', 60);
      const allChunks = await this.runStage('text-chunking', documentId, stageTimings, async () => {
        const chunks = await this.chunkText(pages, documentId, caseId, sacContext);
        const exhibitChunks = await this.chunkExhibitText(exhibitResult.exhibits, documentId, caseId, sacContext);
        const combined = [...chunks, ...exhibitChunks];

        // Enrich chunks with filing metadata for Texas citation formatting
        const docWithFiling = await this.database.document.findUnique({
          where: { id: documentId },
          include: { case: true, filing: true },
        });
        if (docWithFiling) {
          const chunkFilingType = docWithFiling.filing?.filingType || docWithFiling.documentType || undefined;
          const isChunkRR = chunkFilingType
            ? (() => { const ft = chunkFilingType.toLowerCase(); return ft.includes('reporter') || ft === 'rr'; })()
            : false;

          for (const chunk of combined) {
            chunk.metadata.filingId = docWithFiling.filing?.id;
            chunk.metadata.filingType = chunkFilingType;
            chunk.metadata.volumeNumber = (docWithFiling.filing as any)?.volumeNumber ?? undefined;
            chunk.metadata.caseNumber = docWithFiling.case?.caseNumber || undefined;
            chunk.metadata.documentType = docWithFiling.documentType || undefined;

            // Extract line numbers for RR chunks from properly formatted text
            if (isChunkRR) {
              const lineRange = detectLineNumbers(chunk.text);
              chunk.metadata.startLine = lineRange.startLine;
              chunk.metadata.endLine = lineRange.endLine;
            }
          }
        }

        // Enrich chunks with annotation data
        if (pageAnnotations.size > 0) {
          let annotatedChunks = 0;
          for (const chunk of combined) {
            const pageAnns = pageAnnotations.get(chunk.metadata.pageNumber);
            if (!pageAnns || pageAnns.length === 0) continue;

            // Match annotations to this chunk by checking if covered text appears in chunk text
            const matchingAnns = pageAnns.filter(ann =>
              ann.coveredText && chunk.text.includes(ann.coveredText)
            );

            if (matchingAnns.length > 0) {
              chunk.metadata.annotations = JSON.stringify(matchingAnns);
              // Prepend annotation markers to chunk text for searchability
              const markers = buildAnnotationMarkers(matchingAnns);
              chunk.text = markers + chunk.text;
              annotatedChunks++;
            }
          }
          if (annotatedChunks > 0) {
            this.logger.info('Enriched chunks with annotation data', {
              documentId,
              annotatedChunks,
              totalAnnotations: Array.from(pageAnnotations.values()).reduce((sum, anns) => sum + anns.length, 0),
            });
          }
        }

        return combined;
      });

      // Stage: embedding-generation (with heartbeat — batch embedding can be slow for many chunks)
      await this.publishProgress(documentId, 'embedding-generation', `Generating embeddings (${allChunks.length} chunks)...`, 65);
      let embeddingHb = this.startHeartbeat(documentId, 'embedding-generation', `Generating embeddings (${allChunks.length} chunks)...`, 65);
      let embeddedChunks: EmbeddedChunk[];
      try {
        embeddedChunks = await this.runStage('embedding-generation', documentId, stageTimings, () =>
          this.generateEmbeddings(allChunks, documentId, (batchNum, totalBatches) => {
            const subProgress = 65 + Math.round((batchNum / totalBatches) * 24); // 65-89%
            const detail = `Embeddings: batch ${batchNum}/${totalBatches} (${allChunks.length} chunks)`;
            this.updateHeartbeat(embeddingHb, detail, subProgress);
          })
        );
      } finally {
        clearInterval(embeddingHb);
      }

      // Stage: vector-indexing
      await this.publishProgress(documentId, 'vector-indexing', `Indexing ${embeddedChunks.length} vectors...`, 90);
      await this.runStage('vector-indexing', documentId, stageTimings, () =>
        this.indexChunks(embeddedChunks, documentId)
      );

      // Stage: verification (non-fatal — checks page coverage and chunk counts)
      let verification: VerificationResult | undefined;
      try {
        await this.publishProgress(documentId, 'vector-indexing', 'Verifying indexing...', 93);
        verification = await verifyIndexing(documentId, pageCount, embeddedChunks.length, this.database);

        // Store verification result in checkpoint for admin visibility
        const existingCheckpoint: IngestCheckpoint = {};
        try {
          const data: IngestCheckpoint = {
            ...existingCheckpoint,
            lastCompletedStage: 'verification',
            totalPages: pageCount,
            updatedAt: new Date().toISOString(),
          };
          (data as any).verification = verification;
          await this.database.document.update({
            where: { id: documentId },
            data: { ingestCheckpoint: JSON.stringify(data) },
          });
        } catch { /* ignore */ }
      } catch (verifyError) {
        this.logger.warn('Indexing verification failed (non-fatal)', {
          documentId,
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        });
      }

      // Stage: filing-index (non-fatal — builds structural overview of filings for the case)
      try {
        await this.publishProgress(documentId, 'vector-indexing', 'Building filing index...', 95);
        await this.buildFilingIndex(caseId, documentId);
      } catch (indexError) {
        this.logger.warn('Filing index build failed (non-fatal)', {
          documentId,
          error: indexError instanceof Error ? indexError.message : String(indexError),
        });
      }

      await this.publishProgress(documentId, 'complete', 'Done', 100);
      await this.clearProgress(documentId);

      // Clear checkpoint on successful completion
      await this.clearCheckpoint(documentId);

      // Final stop check — don't overwrite STOPPED with INDEXED
      await this.checkIfStopped(documentId);

      // Update document status to INDEXED and stamp the embedding model used
      const modelName = this.embeddingProvider.getModelName();
      await this.database.document.update({
        where: { id: documentId },
        data: {
          status: 'INDEXED',
          errorMessage: null,
          embeddingModel: modelName,
        },
      });

      // Update JobLog with success
      await this.database.jobLog.update({
        where: { id: jobLogId },
        data: {
          completedAt: new Date(),
          documentsProcessed: 1,
        },
      });

      const duration = Date.now() - startTime;
      this.logger.info(`Document processing completed successfully`, {
        documentId,
        pageCount,
        exhibitCount,
        chunkCount: embeddedChunks.length,
        ocrFallbackPages: ocrFallbackCount,
        durationMs: duration,
        durationHuman: IngestionPipeline.formatDuration(duration),
        stageTimings,
      });

      return {
        success: true,
        pageCount,
        exhibitCount,
        chunkCount: embeddedChunks.length,
        ocrFallbackPages: ocrFallbackCount,
        filingDetection,
        stageTimings,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.clearProgress(documentId);

      // If the user stopped the document, clean up without setting ERROR status
      if (error instanceof DocumentStoppedError) {
        this.logger.info(`Document processing stopped by user`, {
          documentId,
          filePath,
          stoppedAtStage: this.currentStage,
        });

        // Rollback partial vector data
        try {
          await this.vectorStore.deleteByDocument(documentId);
        } catch { /* ignore */ }

        if (jobLogId) {
          try {
            await this.database.jobLog.update({
              where: { id: jobLogId },
              data: { completedAt: new Date(), documentsFailed: 0 },
            });
          } catch { /* ignore */ }
        }

        return {
          success: false,
          error: errorMessage,
          failedStage: this.currentStage,
          stageTimings,
        };
      }

      this.logger.error(`Error processing document`, error, {
        documentId,
        filePath,
        failedStage: this.currentStage,
      });

      // Rollback: Delete any partial data from vector store
      try {
        await this.vectorStore.deleteByDocument(documentId);
        this.logger.info(`Rolled back vector store data`, { documentId });
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback vector store data`, rollbackError, { documentId });
      }

      // Update document status to ERROR — but only if it hasn't been set to STOPPED
      try {
        const currentDoc = await this.database.document.findUnique({
          where: { id: documentId },
          select: { status: true },
        });
        if (currentDoc?.status !== 'STOPPED') {
          await this.database.document.update({
            where: { id: documentId },
            data: {
              status: 'ERROR',
              errorMessage,
            },
          });
        }
      } catch (dbError) {
        this.logger.error(`Failed to update document status to ERROR`, dbError, { documentId });
      }

      // Update JobLog with failure
      if (jobLogId) {
        try {
          await this.database.jobLog.update({
            where: { id: jobLogId },
            data: {
              completedAt: new Date(),
              documentsFailed: 1,
              errorSummary: errorMessage,
            },
          });
        } catch (logError) {
          this.logger.error(`Failed to update JobLog`, logError, { jobLogId });
        }
      }

      return {
        success: false,
        error: errorMessage,
        failedStage: this.currentStage,
        stageTimings,
      };
    } finally {
      if (documentLoaded) {
        try {
          await this.pdfParser.releaseDocument(filePath);
        } catch (releaseError) {
          this.logger.warn('Failed to release document from cache', { filePath });
        }
      }
    }
  }

  /**
   * Extract text from PDF using batched processing.
   * Pages where extraction fails (JPEG2000 etc) are flagged with renderFailed.
   * Uses PageCache for resume: if all pages are cached, skips PDF extraction.
   *
   * @param filePath - Path to the PDF file
   * @returns Array of PageText objects
   */
  private async extractText(filePath: string, documentId?: string): Promise<PageText[]> {
    // Check PageCache for previously extracted pages
    if (documentId) {
      const cachedPages = await this.loadPageCache(documentId);
      if (cachedPages.size > 0) {
        const pageCount = await this.pdfParser.getPageCount(filePath);
        // If we have all pages cached (from a prior extraction), restore from cache
        const extractedPages = [...cachedPages.entries()].filter(([, v]) => v.source === 'extract' || v.source === 'ocr');
        if (extractedPages.length >= pageCount) {
          this.logger.info(`Restoring ${extractedPages.length} pages from PageCache (skipping PDF extraction)`, { documentId });
          await this.publishProgress(documentId, 'text-extraction', `Restored ${extractedPages.length} pages from cache`, 25);
          return extractedPages
            .sort(([a], [b]) => a - b)
            .map(([pageNumber, data]) => ({
              pageNumber,
              text: data.text,
              textDensity: data.textDensity,
              renderFailed: false,
            }));
        }
      }
    }

    const pages = await this.pdfParser.extractText(filePath, async (processed, total) => {
      this.logger.info(`Text extraction progress: ${processed}/${total} (${Math.round((processed / total) * 100)}%)`, {
        processed,
        total,
        progressPercent: Math.round((processed / total) * 100),
      });
      if (documentId) {
        const pct = 10 + Math.round((processed / total) * 15); // 10-25% range
        await this.publishProgress(documentId, 'text-extraction', `Extracting text: page ${processed}/${total}`, pct);
      }
    });

    // Cache all extracted pages to PageCache for crash resume.
    // Uses createMany (single transaction per batch) to avoid SQLite write contention.
    if (documentId && pages.length > 0) {
      this.logger.info(`Caching ${pages.length} extracted pages to PageCache`, { documentId });
      await this.batchCachePages(documentId, pages);
      await this.saveStageCheckpoint(documentId, 'text-extraction', pages.length);
    }

    return pages;
  }

  /**
   * Layout-aware text extraction for Reporter's Record (RR) documents.
   * Uses pdfjs-dist with positional data to reconstruct line numbers.
   * Falls back to regular pdfdown extraction if layout-aware produces worse results.
   */
  private async extractTextRR(filePath: string, documentId?: string): Promise<PageText[]> {
    // Check PageCache first (same as extractText)
    if (documentId) {
      const cachedPages = await this.loadPageCache(documentId);
      if (cachedPages.size > 0) {
        const pageCount = await this.pdfParser.getPageCount(filePath);
        const extractedPages = [...cachedPages.entries()].filter(([, v]) => v.source === 'extract' || v.source === 'ocr');
        if (extractedPages.length >= pageCount) {
          this.logger.info(`Restoring ${extractedPages.length} RR pages from PageCache`, { documentId });
          return extractedPages
            .sort(([a], [b]) => a - b)
            .map(([pageNumber, data]) => ({
              pageNumber,
              text: data.text,
              textDensity: data.textDensity,
              renderFailed: false,
            }));
        }
      }
    }

    this.logger.info('Using layout-aware extraction for Reporter\'s Record', { documentId, filePath });

    let rrPages: PageText[];
    try {
      rrPages = await this.pdfParser.extractTextForRR(filePath, async (processed, total) => {
        if (documentId) {
          const pct = 10 + Math.round((processed / total) * 15);
          await this.publishProgress(documentId, 'text-extraction', `Layout-aware extraction: page ${processed}/${total}`, pct);
        }
      });
    } catch (err) {
      this.logger.warn('Layout-aware RR extraction failed, falling back to regular extraction', {
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.extractText(filePath, documentId);
    }

    // Quality check: compare text density with regular extraction.
    // If layout-aware produces significantly less text (< 50% density), fall back.
    const rrDensity = rrPages.reduce((sum, p) => sum + p.textDensity, 0);
    if (rrDensity === 0) {
      this.logger.warn('Layout-aware RR extraction produced no text, falling back to regular extraction', { documentId });
      return this.extractText(filePath, documentId);
    }

    // Spot-check: compare a sample page against pdfdown
    const samplePageIdx = Math.min(5, rrPages.length - 1);
    const regularPages = await this.pdfParser.extractText(filePath);
    const regularDensity = regularPages.reduce((sum, p) => sum + p.textDensity, 0);

    if (regularDensity > 0 && rrDensity < regularDensity * 0.5) {
      this.logger.warn('Layout-aware RR extraction produced <50% of regular text density, falling back', {
        documentId,
        rrDensity,
        regularDensity,
      });
      return regularPages;
    }

    this.logger.info('Layout-aware RR extraction succeeded', {
      documentId,
      pageCount: rrPages.length,
      totalDensity: rrDensity,
    });

    // Cache all extracted pages
    if (documentId && rrPages.length > 0) {
      await this.batchCachePages(documentId, rrPages);
      await this.saveStageCheckpoint(documentId, 'text-extraction', rrPages.length);
    }

    return rrPages;
  }

  /**
   * Apply OCR fallback to pages that failed text extraction or have low density.
   *
   * Simplified flow (post-refactor):
   *   1. Identify candidate pages (low density or render-failed)
   *   2. Restore any previously-OCR'd pages from PageCache (crash resume)
   *   3. For remaining pages: extract best candidate image → preprocess via sharp → OCR
   *   4. Strict error handling: any single page OCR failure fails the entire document
   *
   * @param pages - Mutable array of PageText objects (updated in place)
   * @param filePath - Path to the PDF file (for rendering)
   * @returns Number of pages where OCR fallback was applied
   */
  private async applyOcrFallback(pages: PageText[], filePath: string, documentId?: string, heartbeat?: NodeJS.Timeout, exhibitPageSet?: Set<number>): Promise<number> {
    let exhibitSkipCount = 0;
    const allPagesToOcr = pages.filter((p) => {
      if (!(p.renderFailed || p.textDensity < this.config.ocrThreshold!)) return false;
      // Skip pages already handled by exhibit extraction
      if (exhibitPageSet?.has(p.pageNumber)) {
        exhibitSkipCount++;
        return false;
      }
      return true;
    });

    if (exhibitSkipCount > 0) {
      this.logger.info(`Skipping ${exhibitSkipCount} exhibit pages from OCR fallback`, { documentId, exhibitSkipCount });
    }

    if (allPagesToOcr.length === 0) return 0;

    // --- PageCache resume: load previously completed OCR pages ---
    const completedOcrSet = new Set<number>();
    let resumedCount = 0;

    if (documentId) {
      const cachedPages = await this.loadPageCache(documentId);
      for (const [pageNum, data] of cachedPages) {
        if (data.source === 'ocr') {
          completedOcrSet.add(pageNum);
          // Restore the OCR text into the pages array so downstream stages see it
          const page = pages.find(p => p.pageNumber === pageNum);
          if (page) {
            page.text = data.text;
            page.textDensity = data.textDensity;
            page.renderFailed = false;
          }
        }
      }
      resumedCount = completedOcrSet.size;
      if (resumedCount > 0) {
        this.logger.info(`Resuming OCR from PageCache: ${resumedCount}/${allPagesToOcr.length} pages already completed`, { documentId });
      }
    }

    // Filter out already-completed pages
    const pagesToOcr = allPagesToOcr.filter(p => !completedOcrSet.has(p.pageNumber));
    const totalOcrPages = allPagesToOcr.length;

    if (pagesToOcr.length === 0) {
      this.logger.info(`All ${resumedCount} OCR pages restored from PageCache, skipping OCR stage`, { documentId });
      return resumedCount;
    }

    const effectiveConcurrency = this.getEffectiveOcrConcurrency();
    this.logger.info(`OCR: ${pagesToOcr.length} pages to process (${resumedCount} resumed), concurrency ${effectiveConcurrency}`);

    // ═══════════════════════════════════════════════════════════════════
    // TWO-PHASE OCR: separate CPU work (extract+preprocess) from IO (OCR)
    // Phase 1: Extract & preprocess images SERIALLY — one at a time to
    //          avoid CPU spikes from concurrent sharp/pdfjs work.
    // Phase 2: Send preprocessed buffers to OCR engine with limited
    //          concurrency — mostly network IO, minimal CPU.
    // ═══════════════════════════════════════════════════════════════════

    let skippedCount = 0;

    // Phase 1: Extract + preprocess (serial, CPU-bound)
    interface PreparedPage {
      page: PageText;
      buffer: Buffer;
      originalSizeKB: number;
      optimizedSizeKB: number;
    }
    const preparedPages: PreparedPage[] = [];

    if (documentId) {
      const detail = `Extracting images: 0/${pagesToOcr.length}`;
      if (heartbeat) this.updateHeartbeat(heartbeat, detail, 25);
      await this.publishProgress(documentId, 'ocr-fallback', detail, 25);
    }

    for (let i = 0; i < pagesToOcr.length; i++) {
      const page = pagesToOcr[i];

      // Check for stop signal periodically
      if (i % 20 === 0) {
        await this.checkIfStopped(documentId!);
      }

      // Progress update for extraction phase (25-35% range)
      if (documentId && i % 5 === 0) {
        const pct = 25 + Math.round((i / pagesToOcr.length) * 10);
        const detail = `Extracting images: ${i + 1}/${pagesToOcr.length}`;
        if (heartbeat) this.updateHeartbeat(heartbeat, detail, pct);
        await this.publishProgress(documentId, 'ocr-fallback', detail, pct);
      }

      // Skip text-only pages (no embedded images)
      const hasImages = await this.pdfParser.pageHasImages(filePath, page.pageNumber);
      if (!hasImages) {
        skippedCount++;
        this.logger.info(`Skipping OCR for text-only page ${page.pageNumber} (no embedded images)`, {
          pageNumber: page.pageNumber,
          textDensity: page.textDensity,
        });
        continue;
      }

      // Extract best candidate image
      const candidate = await this.pdfParser.getOcrCandidateImage(filePath, page.pageNumber);
      if (!candidate) {
        skippedCount++;
        this.logger.info(`No OCR-worthy images on page ${page.pageNumber}, skipping`, {
          pageNumber: page.pageNumber,
        });
        continue;
      }

      // Preprocess image through sharp pipeline
      const originalSizeKB = Math.round(candidate.buffer.length / 1024);
      const preprocessedBuffer = await preprocessImage(candidate.buffer, this.config.preprocessSettings);
      const optimizedSizeKB = Math.round(preprocessedBuffer.length / 1024);

      this.logger.info(`Image prepared for page ${page.pageNumber}`, {
        pageNumber: page.pageNumber,
        originalSizeKB,
        optimizedSizeKB,
        sizeDelta: `${optimizedSizeKB >= originalSizeKB ? '+' : ''}${optimizedSizeKB - originalSizeKB}KB`,
      });

      preparedPages.push({ page, buffer: preprocessedBuffer, originalSizeKB, optimizedSizeKB });

      // Yield to event loop every 10 pages to prevent blocking
      if (i % 10 === 9) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    this.logger.info(`Phase 1 complete: ${preparedPages.length} images extracted & preprocessed, ${skippedCount} skipped`, { documentId });

    if (preparedPages.length === 0) {
      this.logger.info(`No images to OCR after extraction, all ${skippedCount} pages skipped`, { documentId });
      return resumedCount;
    }

    // Phase 2: OCR (concurrent, IO-bound — send to Ollama/PaddleOCR)
    let ocrCount = resumedCount;
    let processedOcr = 0;
    let workerIdx = 0;
    let lastCpuCheck = Date.now();
    const { default: PQueue } = await import('p-queue');
    const queue = new PQueue({ concurrency: effectiveConcurrency });
    const pageErrors: { pageNumber: number; error: Error }[] = [];

    if (documentId) {
      const detail = `OCR: 0/${preparedPages.length} pages`;
      if (heartbeat) this.updateHeartbeat(heartbeat, detail, 35);
      await this.publishProgress(documentId, 'ocr-fallback', detail, 35);
    }

    for (const prepared of preparedPages) {
      const worker = this.ocrWorkerPool[workerIdx % this.ocrWorkerPool.length];
      workerIdx++;

      queue.add(async () => {
        // Re-check CPU load every 30 seconds and adjust queue concurrency (local OCR only)
        if (!this.config.ocrRemote) {
          const now = Date.now();
          if (now - lastCpuCheck > 30_000) {
            lastCpuCheck = now;
            const newConcurrency = this.getEffectiveOcrConcurrency();
            if (newConcurrency !== queue.concurrency) {
              queue.concurrency = newConcurrency;
              this.logger.info(`Adjusted OCR queue concurrency to ${newConcurrency}`);
            }
          }
        }

        processedOcr++;
        const totalProcessed = processedOcr + resumedCount;
        if (documentId) {
          const pct = 35 + Math.round((processedOcr / preparedPages.length) * 15); // 35-50% range
          const resumeNote = resumedCount > 0 ? ` (${resumedCount} resumed)` : '';
          const detail = `OCR: page ${prepared.page.pageNumber} (${totalProcessed}/${totalOcrPages}${resumeNote})`;
          if (heartbeat) this.updateHeartbeat(heartbeat, detail, pct);
          await this.publishProgress(documentId, 'ocr-fallback', detail, pct);
        }

        try {
          const ocrResult = await worker.recognizeImage(prepared.buffer);

          const trimmedText = ocrResult.text?.trim() || '';

          if (trimmedText.length >= 100) {
            // Meaningful OCR text — update page and cache
            prepared.page.text = ocrResult.text;
            prepared.page.textDensity = ocrResult.text.length;
            prepared.page.renderFailed = false;
            ocrCount++;
            this.logger.info(`OCR succeeded for page ${prepared.page.pageNumber}`, {
              pageNumber: prepared.page.pageNumber,
              confidence: ocrResult.confidence,
              textLength: trimmedText.length,
              imageSizeKB: prepared.optimizedSizeKB,
            });

            // Save to PageCache immediately (per-page persistence)
            if (documentId) {
              await this.cachePageText(documentId, prepared.page.pageNumber, ocrResult.text, ocrResult.text.length, 'ocr', ocrResult.confidence);
            }
          } else if (trimmedText.length > 0) {
            // Too short to index — likely a logo, stamp, or page number
            this.logger.info(`OCR text too short to index for page ${prepared.page.pageNumber}, skipping`, {
              pageNumber: prepared.page.pageNumber,
              textLength: trimmedText.length,
              confidence: ocrResult.confidence,
            });
          } else {
            this.logger.warn(`OCR produced no text for page ${prepared.page.pageNumber}`, {
              pageNumber: prepared.page.pageNumber,
              confidence: ocrResult.confidence,
            });
          }
        } catch (ocrError) {
          const err = ocrError instanceof Error ? ocrError : new Error(String(ocrError));
          this.logger.error(`OCR failed for page ${prepared.page.pageNumber}`, ocrError, {
            pageNumber: prepared.page.pageNumber,
          });
          pageErrors.push({ pageNumber: prepared.page.pageNumber, error: err });
        }
      });
    }

    await queue.onIdle();

    // Save stage completion
    if (documentId) {
      await this.saveStageCheckpoint(documentId, 'ocr-fallback', totalOcrPages);
    }

    // Strict error handling: if any page OCR failed, fail the entire document
    if (pageErrors.length > 0) {
      const failedPages = pageErrors.map(e => e.pageNumber).join(', ');
      const firstError = pageErrors[0].error.message;
      throw new Error(
        `OCR failed for ${pageErrors.length} page(s) [${failedPages}] — failing entire document. First error: ${firstError}`
      );
    }

    this.logger.info(`OCR complete`, {
      ocrCount,
      resumedFromPageCache: resumedCount,
      skippedTextOnly: skippedCount,
      preparedImages: preparedPages.length,
      totalPages: totalOcrPages,
    });
    return ocrCount;
  }

  /**
   * Detect filing type from the first 5 pages of a PDF.
   * When auto-filing is enabled for the case, automatically creates or assigns
   * a Filing record and links the document to it.
   *
   * @param filePath - Path to the PDF file
   * @param documentId - UUID of the document
   * @param caseId - UUID of the case
   * @returns FilingDetectionResult with type, title, and confidence
   */
  private async detectFilingType(
    filePath: string,
    documentId: string,
    caseId: string
  ): Promise<FilingDetectionResult | undefined> {
    this.logger.info('Detecting filing type from first 5 pages', { documentId, filePath });

    try {
      const { detectFiling } = await import('@/services/filing-detector');
      const detection = await detectFiling(filePath);

      if (!detection || !detection.filingType) {
        this.logger.info('No filing type detected', { documentId });
        return undefined;
      }

      const result: FilingDetectionResult = {
        filingType: detection.filingType,
        title: detection.title,
        confidence: detection.confidence,
        source: 'regex',
      };

      this.logger.info('Filing type detected', {
        documentId,
        filingType: result.filingType,
        title: result.title,
        confidence: result.confidence,
      });

      // Update document type in the database
      await this.database.document.update({
        where: { id: documentId },
        data: { documentType: result.filingType },
      });

      // Check if auto-filing is enabled for this case
      const autoFilingConfig = await this.database.config.findUnique({
        where: { key: `case.${caseId}.autoFiling` },
      });
      const autoFilingEnabled = autoFilingConfig?.value === 'true';

      if (autoFilingEnabled && result.confidence >= 0.6) {
        await this.autoAssignFiling(documentId, caseId, result);
      }

      return result;
    } catch (error) {
      this.logger.error('Filing detection failed', error, { documentId });
      return undefined;
    }
  }

  /**
   * Auto-assign a document to a filing based on detection results.
   * Creates a new filing if one with the same slug doesn't exist.
   */
  private async autoAssignFiling(
    documentId: string,
    caseId: string,
    detection: FilingDetectionResult
  ): Promise<void> {
    try {
      // Skip auto-filing if the document already belongs to a filing (e.g. during reparse)
      const existing = await this.database.document.findUnique({
        where: { id: documentId },
        select: { filingId: true },
      });
      if (existing?.filingId) {
        this.logger.info('Document already assigned to a filing, skipping auto-assign', {
          documentId,
          filingId: existing.filingId,
        });
        return;
      }

      const slug = `${detection.filingType}-${detection.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      // Find or create filing
      let filing = await (this.database as any).filing.findUnique({
        where: { caseId_slug: { caseId, slug } },
      });

      if (!filing) {
        filing = await (this.database as any).filing.create({
          data: {
            caseId,
            filingType: detection.filingType,
            title: detection.title,
            slug,
          },
        });
        this.logger.info('Auto-created filing', {
          documentId,
          filingId: filing.id,
          filingType: detection.filingType,
          title: detection.title,
        });
      }

      // Assign document to filing. When the filing is a Reporter's/Clerk's
      // Record (whole-volume case record), also explicitly clear any
      // exhibitLabel: those filings don't host exhibits, and a stale label
      // from a prior misclassification would otherwise hide the document
      // under "Exhibits" instead of the main documents list (Task #2).
      const normType = (filing.filingType ?? '')
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const isWholeRecord =
        normType === 'reporters record' ||
        normType === 'clerks record' ||
        normType === 'rr' ||
        normType === 'cr';
      await this.database.document.update({
        where: { id: documentId },
        data: isWholeRecord
          ? { filingId: filing.id, exhibitLabel: null }
          : { filingId: filing.id },
      });

      this.logger.info('Auto-assigned document to filing', {
        documentId,
        filingId: filing.id,
      });
    } catch (error) {
      this.logger.error('Auto-filing assignment failed', error, { documentId });
    }
  }

  /**
   * Extract exhibits from PDF and run OCR on them.
   *
   * @param filePath - Path to the PDF file
   * @param caseId - UUID of the case
   * @param documentId - UUID of the document
   * @param boundaries - Optional exhibit boundaries for context-aware filtering
   * @param onProgress - Optional progress callback
   * @param options - Poppler metadata, worthy image pages, page text for smart filtering
   * @returns ExhibitExtractionResult with metadata
   */
  private async extractExhibits(
    filePath: string,
    caseId: string,
    documentId: string,
    boundaries?: ExhibitBoundary[],
    onProgress?: (processed: number, total: number) => void,
    options?: {
      popplerImages?: PdfImageInfo[];
      worthyImagePages?: Set<number>;
      pages?: PageText[];
      motionSections?: MotionSection[];
      preprocessSettings?: import('./image-preprocessor').ImagePreprocessSettings;
    },
  ): Promise<{ exhibits: ExhibitMetadata[]; totalCount: number }> {
    return await this.exhibitExtractor.extractExhibits(filePath, caseId, documentId, boundaries, onProgress, options);
  }

  /**
   * Chunk text from pages into overlapping segments.
   *
   * @param pages - Array of PageText objects
   * @param documentId - UUID of the document
   * @param caseId - UUID of the case
   * @returns Array of Chunk objects
   */
  private async chunkText(
    pages: PageText[],
    documentId: string,
    caseId: string,
    sacContext?: SacContext,
  ): Promise<Chunk[]> {
    return await this.textChunker.chunkPages(pages, documentId, caseId, sacContext);
  }

  /**
   * Chunk exhibit OCR text into segments.
   *
   * @param exhibits - Array of ExhibitMetadata objects
   * @param documentId - UUID of the document
   * @param caseId - UUID of the case
   * @returns Array of Chunk objects
   */
  private async chunkExhibitText(
    exhibits: ExhibitMetadata[],
    documentId: string,
    caseId: string,
    sacContext?: SacContext,
  ): Promise<Chunk[]> {
    const chunks: Chunk[] = [];

    for (const exhibit of exhibits) {
      if (exhibit.extractedText && exhibit.extractedText.trim().length > 0) {
        const exhibitChunks = await this.textChunker.chunkExhibitText(
          exhibit.extractedText,
          {
            pageNumber: exhibit.pageNumber,
            imagePath: exhibit.imagePath,
            ocrText: exhibit.extractedText,
            documentId,
            caseId,
          },
          sacContext,
        );
        chunks.push(...exhibitChunks);
      }
    }

    return chunks;
  }

  /**
   * Generate embeddings for all chunks in batches to manage memory.
   *
   * @param chunks - Array of Chunk objects
   * @returns Array of EmbeddedChunk objects
   */
  private async generateEmbeddings(chunks: Chunk[], documentId?: string, onProgress?: (batchNum: number, totalBatches: number) => void): Promise<EmbeddedChunk[]> {
    if (chunks.length === 0) {
      this.logger.warn('generateEmbeddings called with 0 chunks — skipping', { documentId });
      return [];
    }

    const providerName = this.embeddingProvider.getModelName();
    const dims = this.embeddingProvider.getDimensions();
    const batchSize = this.config.embeddingBatchSize!;
    const totalBatches = Math.ceil(chunks.length / batchSize);
    const embeddedChunks: EmbeddedChunk[] = [];

    this.logger.info('Embedding generation starting', {
      documentId,
      provider: providerName,
      dimensions: dims,
      chunkCount: chunks.length,
      batchSize,
      totalBatches,
    });

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const texts = batch.map((chunk) => chunk.text);
      const avgTextLen = Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length);

      if (documentId) {
        const pct = 65 + Math.round((batchNum / totalBatches) * 25); // 65-90% range
        await this.publishProgress(documentId, 'embedding-generation', `Embeddings: batch ${batchNum}/${totalBatches}`, pct);
      }

      this.logger.info(`Embedding batch ${batchNum}/${totalBatches} starting`, {
        documentId,
        provider: providerName,
        batchNum,
        batchSize: texts.length,
        avgTextLength: avgTextLen,
      });

      const batchStart = Date.now();
      let embeddings: number[][];
      try {
        embeddings = await this.embeddingProvider.embed(texts);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(`Embedding batch ${batchNum}/${totalBatches} FAILED`, error, {
          documentId,
          provider: providerName,
          batchNum,
          batchSize: texts.length,
          durationMs: Date.now() - batchStart,
          errorMessage: msg,
          errorStack: stack,
          firstChunkPreview: texts[0]?.substring(0, 100),
        });
        throw error;
      }

      const batchDuration = Date.now() - batchStart;
      const embDims = embeddings[0]?.length ?? 0;

      for (let j = 0; j < batch.length; j++) {
        embeddedChunks.push({
          text: batch[j].text,
          embedding: embeddings[j],
          metadata: batch[j].metadata,
        });
      }

      this.logger.info(`Embedding batch ${batchNum}/${totalBatches} complete`, {
        documentId,
        batchNum,
        batchSize: batch.length,
        durationMs: batchDuration,
        embeddingDimensions: embDims,
        totalProgress: `${i + batch.length}/${chunks.length}`,
        progressPercent: Math.round(((i + batch.length) / chunks.length) * 100),
      });

      // Notify caller of batch progress (updates heartbeat)
      onProgress?.(batchNum, totalBatches);

      // Yield to event loop so UI requests (SSE, API calls) can be served
      // between embedding batches. ONNX Runtime runs synchronously in WASM,
      // so we need a real delay (not just setTimeout(0)) to give the event
      // loop time to process pending HTTP requests.
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return embeddedChunks;
  }

  /**
   * Index embedded chunks in the vector store in batches.
   *
   * @param chunks - Array of EmbeddedChunk objects
   * @param documentId - UUID of the document
   */
  private async indexChunks(chunks: EmbeddedChunk[], documentId: string): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const batchSize = this.config.embeddingBatchSize!;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      await this.vectorStore.insertChunks(batch);

      this.logger.info(`Vector index batch complete`, {
        batchStart: i,
        batchEnd: i + batch.length,
        total: chunks.length,
        progressPercent: Math.round(((i + batch.length) / chunks.length) * 100),
      });

      // Yield to event loop between vector index batches
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  /**
   * Build a filing index for the case — a synthetic chunk that lists all filings,
   * motions, and exhibits. This helps vector search find structural information
   * like "find Motion for Reconsideration" even when no chunk contains those exact words.
   */
  private async buildFilingIndex(caseId: string, documentId: string): Promise<void> {
    try {
      const caseData = await this.database.case.findUnique({
        where: { id: caseId },
        include: {
          filings: {
            include: {
              documents: { select: { fileName: true, pageCount: true } },
              motions: {
                include: {
                  exhibits: true,
                },
              },
            },
          },
        },
      });

      if (!caseData || caseData.filings.length === 0) {
        this.logger.info('No filings found for case, skipping filing index', { caseId });
        return;
      }

      // Build structured text listing
      const lines: string[] = [
        `FILING INDEX for case: ${caseData.name}`,
        caseData.caseNumber ? `Case Number: ${caseData.caseNumber}` : '',
        `Total filings: ${caseData.filings.length}`,
        '',
      ].filter(Boolean);

      for (const filing of caseData.filings) {
        const vol = filing.volumeNumber ? ` (Volume ${filing.volumeNumber})` : '';
        lines.push(`--- ${filing.filingType}: ${filing.title}${vol} ---`);
        if (filing.description) lines.push(`  Description: ${filing.description}`);
        for (const doc of filing.documents) {
          lines.push(`  Document: ${doc.fileName} (${doc.pageCount ?? '?'} pages)`);
        }
        for (const motion of (filing as any).motions || []) {
          const pages = motion.endPage
            ? `pp. ${motion.startPage}-${motion.endPage}`
            : `p. ${motion.startPage}`;
          lines.push(`  Motion: ${motion.title} (${pages})`);
          for (const exhibit of motion.exhibits || []) {
            const exPages = exhibit.endPage
              ? `pp. ${exhibit.startPage}-${exhibit.endPage}`
              : `p. ${exhibit.startPage}`;
            lines.push(`    Exhibit: ${exhibit.label}${exhibit.title ? ` — ${exhibit.title}` : ''} (${exPages})`);
          }
        }
        lines.push('');
      }

      const indexText = lines.join('\n');

      // Delete any existing filing index chunks for this case
      // (They have document_type = 'filing_index')
      try {
        if (this.vectorStore) {
          // Use text search to find and delete existing filing index entries
          // We store them under a synthetic documentId to make cleanup easy
          const syntheticDocId = `filing-index-${caseId}`;
          await this.vectorStore.deleteByDocument(syntheticDocId);
        }
      } catch {
        // May not exist yet
      }

      // Embed and insert the filing index
      const chunks: Chunk[] = [{
        text: indexText,
        metadata: {
          documentId: `filing-index-${caseId}`,
          caseId,
          pageNumber: 0,
          chunkIndex: 0,
          isExhibit: false,
          documentType: 'filing_index',
          caseNumber: caseData.caseNumber || undefined,
        },
      }];

      const embeddings = await this.embeddingProvider.embed([indexText]);
      const embeddedChunks: EmbeddedChunk[] = [{
        text: indexText,
        embedding: embeddings[0],
        metadata: chunks[0].metadata,
      }];

      await this.vectorStore.insertChunks(embeddedChunks);

      this.logger.info('Filing index built and inserted', {
        caseId,
        filingCount: caseData.filings.length,
        indexTextLength: indexText.length,
      });
    } catch (error) {
      this.logger.warn('Failed to build filing index', {
        caseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cleanup resources.
   * Should be called when pipeline is no longer needed.
   */
  async terminate(): Promise<void> {
    await this.ocrEngine.terminate();
    await Promise.all(this.ocrWorkerPool.map((w) => w.terminate()));
    await this.exhibitExtractor.terminate();
    this.textChunker.dispose();
  }
}
