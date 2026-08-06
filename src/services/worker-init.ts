/**
 * Worker initialization singleton.
 *
 * Lazily creates and initializes the ParsingWorkerManager the first time
 * it's requested. Uses a real IngestionPipeline's processDocument method
 * as the processing function for each worker.
 *
 * This avoids the need for a separate startup script — the workers spin up
 * on the first API call that touches them (e.g. GET /api/workers or
 * POST /api/config with a worker count change).
 */

import { ParsingWorkerManager } from './parsing-worker-manager';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';
import { getServicesManager } from '@/lib/services-manager';

const logger = createLogger('WorkerInit');

let managerInstance: ParsingWorkerManager | null = null;
let initPromise: Promise<ParsingWorkerManager> | null = null;
let daemonStarted = false;
let coreServicesStarted = false;

/**
 * Build a processDocument function that creates a lightweight pipeline
 * for each document. We import lazily to avoid circular deps and heavy
 * module loading at import time.
 */
async function buildProcessDocumentFn(): Promise<(documentId: string, filePath: string) => Promise<void>> {
  // Lazy imports to keep the module lightweight
  const { PDFParser } = await import('@/lib/ingestion/pdf-parser');
  const { OCREngine } = await import('@/lib/ingestion/ocr-engine');
  const { LangChainTextChunker } = await import('@/lib/ingestion/langchain-text-chunker');
  const { VectorStore } = await import('@/lib/vector/vector-store');
  const { IngestionPipeline } = await import('@/lib/ingestion/ingestion-pipeline');
  const { getConfig } = await import('@/lib/db/config');

  const config = await getConfig();

  const pdfParser = new PDFParser();
  // StructuredChunker chunks block-carrying pages structurally (real
  // headings, atomic tables, furniture excluded) and delegates pages
  // without blocks to LangChainTextChunker unchanged — so with
  // docparseEnabled off this is byte-identical to the bare chunker.
  const { StructuredChunker } = await import('@/lib/ingestion/structured-chunker');
  const textChunker = new StructuredChunker(new LangChainTextChunker());

  // Instantiate OCR engine based on admin config
  let ocrEngine: import('@/lib/ingestion/ocr-engine').IOCREngine;
  let ocrWorkerFactory: (() => import('@/lib/ingestion/ocr-engine').IOCREngine) | undefined;

  if (config.ocrProvider === 'ollama') {
    const { OllamaOCREngine } = await import('@/lib/ingestion/ollama-ocr-engine');
    const ocrHost = config.ocrOllamaHost || config.ollamaHost || 'http://localhost:11434';
    const ocrModel = config.ocrOllamaModel || 'richardyoung/olmocr2:7b-q8';
    const ocrOrchestrator = !!config.ocrUseOrchestrator;

    logger.info('OCR route', {
      host: ocrHost,
      model: ocrModel,
      orchestrator: ocrOrchestrator,
      note: ocrOrchestrator ? 'host resolved per-request via fleet-router' : 'static host',
    });

    const ocrTimeoutMs = config.ocrTimeoutMs;
    ocrEngine = new OllamaOCREngine({ host: ocrHost, model: ocrModel, useOrchestrator: ocrOrchestrator, timeoutMs: ocrTimeoutMs });
    // Ollama vision models should be called sequentially (one GPU request at a time)
    ocrWorkerFactory = () => new OllamaOCREngine({ host: ocrHost, model: ocrModel, useOrchestrator: ocrOrchestrator, timeoutMs: ocrTimeoutMs });
    logger.info('OCR provider: Ollama', { host: ocrHost, model: ocrModel });
  } else {
    ocrEngine = new OCREngine();
    ocrWorkerFactory = () => new OCREngine();
    logger.info('OCR provider: Local PaddleOCR');
  }

  // Instantiate the embedding provider based on admin config
  let embeddingProvider: import('@/lib/ingestion/embedding-provider').EmbeddingProvider;
  switch (config.embeddingProvider) {
    case 'openai': {
      const { OpenAIEmbeddingProvider } = await import('@/lib/ingestion/openai-embedding-provider');
      embeddingProvider = new OpenAIEmbeddingProvider(config.openaiApiKey || '', config.embeddingModel);
      break;
    }
    case 'claude': {
      const { ClaudeEmbeddingProvider } = await import('@/lib/ingestion/claude-embedding-provider');
      embeddingProvider = new ClaudeEmbeddingProvider(config.claudeApiKey || '', config.embeddingModel);
      break;
    }
    case 'ollama': {
      const { OllamaEmbeddingProvider } = await import('@/lib/ingestion/ollama-embedding-provider');
      const embeddingHost = config.ollamaHost || 'http://localhost:11434';

      logger.info('Embedding route', {
        host: embeddingHost,
        model: config.ollamaModel || config.embeddingModel,
        orchestrator: !!config.embeddingUseOrchestrator,
        note: config.embeddingUseOrchestrator ? 'host resolved per-request via fleet-router' : 'static host',
      });

      embeddingProvider = new OllamaEmbeddingProvider({
        host: embeddingHost,
        model: config.ollamaModel || config.embeddingModel || 'all-minilm',
        useOrchestrator: config.embeddingUseOrchestrator,
      });
      break;
    }
    default: {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel);
      break;
    }
  }
  logger.info(`Embedding provider initialized`, {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    providerClass: embeddingProvider.constructor.name,
    dimensions: embeddingProvider.getDimensions(),
    modelName: embeddingProvider.getModelName(),
    ...(config.embeddingProvider === 'ollama' ? { ollamaHost: config.ollamaHost, ollamaModel: config.ollamaModel } : {}),
  });
  const vectorStore = new VectorStore({
    dbPath: process.env.LANCEDB_PATH || 'data/lancedb',
    tableName: process.env.LANCEDB_TABLE || 'chunks',
  });
  await vectorStore.initialize();

  // For Ollama OCR, allow 2 concurrent requests (minicpm-v ~8GB, A6000 has 48GB).
  // For local PaddleOCR, use the user-configured concurrency.
  const effectiveOcrConcurrency = config.ocrProvider === 'ollama'
    ? Math.min(config.ocrConcurrency ?? 2, 3)
    : config.ocrConcurrency;

  const pipeline = new IngestionPipeline(
    pdfParser,
    ocrEngine,
    textChunker,
    embeddingProvider,
    vectorStore,
    prisma,
    {
      embeddingBatchSize: config.embeddingBatchSize,
      ocrConcurrency: effectiveOcrConcurrency,
      ocrThreshold: config.ocrThreshold,
      ocrRemote: config.ocrProvider === 'ollama',
      readinessEnabled: config.readinessEnabled,
      readinessThreshold: config.readinessThreshold,
      readinessGating: config.readinessGating,
      preprocessSettings: {
        upscale: config.ocrUpscale,
        minWidth: config.ocrMinWidth,
        minDpi: config.ocrMinDpi,
        grayscale: config.ocrGrayscale,
        normalize: config.ocrNormalize,
        clahe: config.ocrClahe,
        claheClipLimit: config.ocrClaheClipLimit,
        sharpen: config.ocrSharpen,
        sharpenSigma: config.ocrSharpenSigma,
        resize: config.ocrResize,
        maxWidth: config.ocrMaxWidth,
        pngCompressionLevel: config.ocrPngCompression,
      },
    },
    ocrWorkerFactory,
  );

  logger.info('IngestionPipeline created for workers');

  return async (documentId: string, filePath: string) => {
    await pipeline.processDocument(documentId, filePath);
  };
}

/**
 * Get (or create) the singleton ParsingWorkerManager.
 * Safe to call from any API route — only initializes once.
 */
export async function getWorkerManager(): Promise<ParsingWorkerManager> {
  if (managerInstance) return managerInstance;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        // Recover orphaned PROCESSING documents from previous server run.
        // These documents were mid-pipeline when the server restarted —
        // re-queue them so they get re-processed cleanly.
        const orphaned = await prisma.$executeRaw`
          UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
          WHERE "status" = 'PROCESSING'
        `;
        if (orphaned > 0) {
          logger.info(`Recovered ${orphaned} orphaned PROCESSING documents → QUEUED`);
        }

        // Auto-queue unparsed documents that have a filing attached.
        // On restart, any filed document that isn't INDEXED or already QUEUED/PROCESSING
        // should be queued for parsing automatically.
        const autoQueued = await prisma.$executeRaw`
          UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
          WHERE "filingId" IS NOT NULL
            AND "status" NOT IN ('QUEUED', 'PROCESSING', 'INDEXED')
        `;
        if (autoQueued > 0) {
          logger.info(`Auto-queued ${autoQueued} unparsed documents with filings`);
        }

        logger.info('Initializing ParsingWorkerManager...');
        const processDocument = await buildProcessDocumentFn();
        const manager = new ParsingWorkerManager(processDocument, prisma);
        await manager.initialize(); // reads count from Config table
        managerInstance = manager;
        getServicesManager().registerParsingWorkerManager(manager);
        logger.info('ParsingWorkerManager initialized', { workerCount: manager.getWorkerCount() });

        // Start the background scanner daemon (fire-and-forget)
        startDaemonIfNeeded();

        // Start core services: FileWatcher, JobQueue, MCP Server (fire-and-forget)
        startCoreServicesIfNeeded(processDocument);

        // Register cross-platform shutdown handlers
        registerShutdownHandlers();

        return manager;
      } catch (err) {
        // Reset so next call retries instead of returning the failed promise
        initPromise = null;
        logger.error('Failed to initialize ParsingWorkerManager', err);
        throw err;
      }
    })();
  }

  return initPromise;
}


/**
 * Reinitialize the ingestion pipeline with fresh config from the database.
 * Call this after the admin changes embedding provider/model/host so that
 * running workers pick up the new settings without a server restart.
 */
export async function reinitializePipeline(): Promise<void> {
  if (!managerInstance) {
    logger.warn('reinitializePipeline called but no manager exists — skipping');
    return;
  }

  logger.info('Reinitializing ingestion pipeline with fresh config...');
  const newProcessFn = await buildProcessDocumentFn();
  await managerInstance.replaceProcessFn(newProcessFn);
  logger.info('Pipeline reinitialized — workers restarted with new embedding provider');
}

/**
 * Start the BackgroundScannerDaemon if not already running.
 * Runs the PID controller loop, processes UI/BG queues, and seeds background tasks.
 * Fire-and-forget — errors are logged but don't crash the app.
 */
async function startDaemonIfNeeded(): Promise<void> {
  if (daemonStarted) return;
  daemonStarted = true;

  try {
    const { isRedisAvailable } = await import('@/lib/redis');
    if (!(await isRedisAvailable())) {
      logger.warn('Redis not available, skipping daemon startup');
      daemonStarted = false;
      return;
    }

    const { WorkerPoolService } = await import('./worker-pool-service');
    const { FolderIndexService } = await import('./folder-index-service');
    const { BackgroundScannerDaemon } = await import('./background-scanner-daemon');

    const pool = await WorkerPoolService.fromConfig();
    const index = new FolderIndexService();

    const { getConfig } = await import('@/lib/db/config');
    const appCfg = await getConfig();
    const daemon = new BackgroundScannerDaemon(pool, index, {
      maxParsingWorkers: appCfg.maxParsingWorkers,
    });

    // Attach parsing manager so daemon can dynamically scale parsing workers
    if (managerInstance) {
      daemon.setParsingManager(managerInstance);
    }

    // Register pool and daemon with ServicesManager for health checks
    const sm = getServicesManager();
    sm.registerWorkerPoolService(pool);
    sm.registerBackgroundDaemon(daemon);

    // Track the main process PID for the daemon
    await sm.trackWorkerPid('daemon', process.pid);

    // Run in background — don't await
    daemon.start().catch(err => {
      logger.error('BackgroundScannerDaemon crashed', err);
      daemonStarted = false; // allow restart on next worker init
    });

    logger.info('BackgroundScannerDaemon started');
  } catch (err) {
    logger.error('Failed to start BackgroundScannerDaemon', err);
    daemonStarted = false;
  }
}

/**
 * Start core services (FileWatcher, JobQueue, MCP Server) and register
 * them with ServicesManager so health checks show green indicators.
 * Fire-and-forget — errors are logged but don't crash the app.
 */
let shuttingDown = false;

/**
 * Register signal handlers for graceful shutdown on all platforms.
 * Listens for SIGTERM, SIGINT, and SIGBREAK (Windows).
 */
function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      // Stop background scanner daemon
      const sm = getServicesManager();
      const daemon = (sm as any).backgroundDaemon;
      if (daemon?.stop) {
        await daemon.stop();
        logger.info('BackgroundScannerDaemon stopped');
      }

      // Stop all parsing workers
      if (managerInstance) {
        await managerInstance.stopAll();
        logger.info('ParsingWorkerManager stopped');
      }

      // Stop FileWatcher
      const watcher = (sm as any).fileWatcher;
      if (watcher?.stop) {
        await watcher.stop();
        logger.info('FileWatcher stopped');
      }

      // Clean up PID files
      const fs = await import('fs/promises');
      const path = await import('path');
      const pidDir = path.join(process.cwd(), '.pids');
      try {
        const files = await fs.readdir(pidDir);
        for (const f of files) {
          await fs.unlink(path.join(pidDir, f)).catch(() => {});
        }
        await fs.rmdir(pidDir).catch(() => {});
        logger.info('PID directory cleaned up');
      } catch {
        // .pids may not exist
      }
    } catch (err) {
      logger.error('Error during shutdown', err);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGBREAK is Windows-specific (Ctrl+Break)
  if (process.platform === 'win32') {
    process.on('SIGBREAK' as any, () => shutdown('SIGBREAK'));
  }
}

async function startCoreServicesIfNeeded(
  processDocument: (documentId: string, filePath: string) => Promise<void>,
): Promise<void> {
  if (coreServicesStarted) return;
  coreServicesStarted = true;

  try {
    const sm = getServicesManager();

    // --- FileWatcher ---
    const { FileWatcher } = await import('./file-watcher');
    const cases = await prisma.case.findMany({ select: { path: true } });
    const casePaths = cases.map(c => c.path);

    if (casePaths.length > 0) {
      const fileWatcher = new FileWatcher({ watchPaths: casePaths }, prisma);
      await fileWatcher.start();
      sm.registerFileWatcher(fileWatcher);
      await sm.trackWorkerPid('file-watcher', process.pid);
      logger.info('FileWatcher started', { pathCount: casePaths.length });
    } else {
      logger.warn('No case paths found — FileWatcher not started');
    }

    // --- JobQueue ---
    const { JobQueue } = await import('./job-queue');
    const jobQueue = new JobQueue({}, processDocument, prisma);
    sm.registerJobQueue(jobQueue);
    logger.info('JobQueue registered');

    // --- MCP ToolRegistry (tools served via Next.js API at /api/mcp/execute) ---
    const { getToolRegistry } = await import('@/lib/mcp/get-tool-registry');
    const registry = await getToolRegistry();
    sm.registerToolRegistry(registry);
    logger.info('MCP ToolRegistry registered (served via /api/mcp/execute)');

    // --- GPU WebSocket Relay (sidecars connect here for tunneled communication) ---
    try {
      const { startWsRelay } = await import('@/lib/gpu/ws-relay');
      startWsRelay();
      logger.info('GPU WebSocket relay started on port 3002');
    } catch (err) {
      logger.warn('Failed to start GPU WebSocket relay', { error: (err as Error).message });
    }

    // --- Command Queue Cleanup (expires stale commands) ---
    try {
      const { startCleanupLoop } = await import('@/lib/gpu/command-queue');
      startCleanupLoop();
      logger.info('Sidecar command queue cleanup loop started');
    } catch (err) {
      logger.warn('Failed to start command queue cleanup', { error: (err as Error).message });
    }

    // --- Minimum Online Enforcement (ensures N containers stay running per role) ---
    try {
      const { startMinOnlineEnforcement } = await import('@/lib/gpu/fleet-router');
      startMinOnlineEnforcement();
      logger.info('Minimum-online enforcement loop started');
    } catch (err) {
      logger.warn('Failed to start min-online enforcement', { error: (err as Error).message });
    }

    // --- Sidecar Reconnect Watchdog (reverse-pushes canonical master URL to stale sidecars) ---
    try {
      const { startSidecarReconnectWatchdog } = await import('@/lib/gpu/sidecar-reconnect-watchdog');
      startSidecarReconnectWatchdog();
      logger.info('Sidecar reconnect watchdog started');
    } catch (err) {
      logger.warn('Failed to start sidecar reconnect watchdog', { error: (err as Error).message });
    }

    // --- Stale JobLog Reaper (closes orphan jobs from worker crashes/restarts) ---
    try {
      const { startJobLogReaper } = await import('@/lib/ingestion/joblog-reaper');
      startJobLogReaper();
      logger.info('JobLog reaper started');
    } catch (err) {
      logger.warn('Failed to start JobLog reaper', { error: (err as Error).message });
    }
  } catch (err) {
    logger.error('Failed to start core services', err);
    coreServicesStarted = false; // allow retry on next worker init
  }
}
