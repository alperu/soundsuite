/**
 * When the embedding/parsing worker fails to start (e.g. libonnxruntime.so is
 * missing in the image), the GPU WebSocket relay (3002), FileWatcher and
 * JobQueue must still start, and the worker error must be logged.
 */

const logged: { level: string; msg: string; meta?: unknown }[] = [];
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (msg: string, meta?: unknown) => logged.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: unknown) => logged.push({ level: 'error', msg, meta }),
    debug: () => {},
  }),
}));

const prismaMock = {
  $executeRaw: jest.fn().mockResolvedValue(0),
  case: { findMany: jest.fn().mockResolvedValue([{ path: '/watch/cases/a' }]) },
};
jest.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const sm = {
  registerFileWatcher: jest.fn(),
  registerJobQueue: jest.fn(),
  registerToolRegistry: jest.fn(),
  registerParsingWorkerManager: jest.fn(),
  trackWorkerPid: jest.fn().mockResolvedValue(undefined),
};
jest.mock('@/lib/services-manager', () => ({ getServicesManager: () => sm }));
jest.mock('@/lib/profiles', () => ({ lancedbPath: () => '/tmp/lancedb' }));
jest.mock('../parsing-worker-manager', () => ({ ParsingWorkerManager: jest.fn() }));

// Pipeline build: the embedding provider throws like a missing native lib.
jest.mock('@/lib/ingestion/pdf-parser', () => ({ PDFParser: jest.fn() }));
jest.mock('@/lib/ingestion/ocr-engine', () => ({ OCREngine: jest.fn() }));
jest.mock('@/lib/ingestion/langchain-text-chunker', () => ({ LangChainTextChunker: jest.fn() }));
jest.mock('@/lib/ingestion/structured-chunker', () => ({ StructuredChunker: jest.fn() }));
jest.mock('@/lib/vector/vector-store', () => ({ VectorStore: jest.fn() }));
jest.mock('@/lib/ingestion/ingestion-pipeline', () => ({ IngestionPipeline: jest.fn() }));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn().mockResolvedValue({ ocrProvider: 'local', embeddingProvider: 'transformers' }) }));
jest.mock('@/lib/ingestion/embedding-provider-factory', () => ({
  createEmbeddingProvider: jest.fn().mockRejectedValue(
    new Error('libonnxruntime.so.1.14.0: cannot open shared object file: No such file or directory'),
  ),
}));

const watcherStart = jest.fn().mockResolvedValue(undefined);
jest.mock('../file-watcher', () => ({ FileWatcher: jest.fn().mockImplementation(() => ({ start: watcherStart })) }));
jest.mock('../job-queue', () => ({ JobQueue: jest.fn().mockImplementation(() => ({})) }));
jest.mock('@/lib/mcp/get-tool-registry', () => ({ getToolRegistry: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/fs-sidecar/start', () => ({ startFsSidecarLinkFromEnv: jest.fn().mockResolvedValue(null) }));
const startWsRelay = jest.fn();
jest.mock('@/lib/gpu/ws-relay', () => ({ startWsRelay }));
jest.mock('@/lib/gpu/command-queue', () => ({ startCleanupLoop: jest.fn() }));
jest.mock('@/lib/gpu/fleet-router', () => ({ startMinOnlineEnforcement: jest.fn() }));
jest.mock('@/lib/gpu/sidecar-reconnect-watchdog', () => ({ startSidecarReconnectWatchdog: jest.fn() }));
jest.mock('@/lib/ingestion/joblog-reaper', () => ({ startJobLogReaper: jest.fn() }));

describe('worker-init: core services start when the worker fails', () => {
  beforeEach(() => {
    delete (globalThis as { __ssWorkerInit?: unknown }).__ssWorkerInit;
  });

  it('starts relay, file watcher and job queue, logs the worker error, and still rejects', async () => {
    const { getWorkerManager } = await import('../worker-init');

    await expect(getWorkerManager()).rejects.toThrow('libonnxruntime.so.1.14.0');

    expect(startWsRelay).toHaveBeenCalledTimes(1);
    expect(watcherStart).toHaveBeenCalledTimes(1);
    expect(sm.registerFileWatcher).toHaveBeenCalledTimes(1);
    expect(sm.registerJobQueue).toHaveBeenCalledTimes(1);
    expect(sm.registerParsingWorkerManager).not.toHaveBeenCalled();

    const err = logged.find((l) => l.level === 'error' && /worker failed to start/i.test(l.msg));
    expect(err).toBeDefined();
    expect(JSON.stringify(err!.meta)).toContain('libonnxruntime.so.1.14.0');
    expect(logged.some((l) => /GPU WebSocket relay started/.test(l.msg))).toBe(true);
  });

  it('starts the relay even if the FileWatcher fails', async () => {
    jest.resetModules();
    startWsRelay.mockClear();
    prismaMock.case.findMany.mockRejectedValueOnce(new Error('db locked'));
    const { getWorkerManager } = await import('../worker-init');

    await expect(getWorkerManager()).rejects.toThrow();
    expect(startWsRelay).toHaveBeenCalledTimes(1);
    expect(logged.some((l) => l.level === 'error' && l.msg === 'Failed to start FileWatcher')).toBe(true);
  });
});
