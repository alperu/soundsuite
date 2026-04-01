/**
 * Configuration management utilities
 * 
 * Provides functions for reading and writing configuration values
 * to the Config table in the database.
 * 
 * Requirements: 18.1, 18.9, 18.10
 */

import { prisma } from './prisma';

export interface AppConfig {
  embeddingProvider: 'transformers' | 'openai' | 'claude' | 'ollama';
  embeddingModel: string;
  openaiApiKey?: string;
  claudeApiKey?: string;
  groqApiKey?: string;
  grokApiKey?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  ollamaCompletionHost?: string;
  ollamaCompletionModel?: string;
  enableDocumentSummary?: boolean;
  workerPoolSize: number;
  minUiWorkers: number;
  minBgWorkers: number;
  pidKp: number;
  pidKi: number;
  pidKd: number;
  maxParsingWorkers: number;
  ocrProvider: 'local' | 'ollama';
  ocrOllamaHost?: string;
  ocrOllamaModel?: string;
  parsingWorkerCount: number;
  ocrThreshold: number;
  ocrConcurrency: number;
  embeddingBatchSize: number;
  // Reranking settings
  rerankEnabled: boolean;
  rerankProvider: 'vllm' | 'none';
  rerankModel: string;
  rerankHost: string;
  rerankTopN: number;
  rerankAutoManage: boolean;
  rerankIdleTimeoutMin: number;
  rerankScoreValidation: boolean;
  rerankFallbackModel: string;
  // Per-model GPU idle timeouts (minutes, 0 = never stop)
  gpuIdleEmbeddingMin: number;
  gpuIdleCompletionMin: number;
  gpuIdleOcrMin: number;
  gpuIdleRerankerMin: number;
  // Per-model minimum online instances (0 = no minimum)
  gpuMinEmbedding: number;
  gpuMinCompletion: number;
  gpuMinOcr: number;
  gpuMinReranker: number;
  // Registered GPU sidecars (JSON string)
  gpuSidecars: string;
  // GPU orchestrator mode and auto-management
  gpuMode: 'indexing' | 'searching';
  gpuAutoManage: boolean;
  // Per-role "Use Orchestrator" toggles
  embeddingUseOrchestrator: boolean;
  completionUseOrchestrator: boolean;
  ocrUseOrchestrator: boolean;
  rerankUseOrchestrator: boolean;
  // Image preprocessing settings
  ocrUpscale: boolean;
  ocrMinWidth: number;
  ocrMinDpi: number;
  ocrGrayscale: boolean;
  ocrNormalize: boolean;
  ocrClahe: boolean;
  ocrClaheClipLimit: number;
  ocrSharpen: boolean;
  ocrSharpenSigma: number;
  ocrResize: boolean;
  ocrMaxWidth: number;
  ocrPngCompression: number;
  // Draft settings
  draftPageSize: 'letter' | 'a4' | 'legal';
  draftMarginTop: number;
  draftMarginBottom: number;
  draftMarginLeft: number;
  draftMarginRight: number;
  // Draft style defaults
  draftDefaultFont: string;
  draftDefaultFontSize: string;
  draftH1Size: string;
  draftH2Size: string;
  draftH3Size: string;
  draftH4Size: string;
  draftH5Size: string;
  draftLineSpacing: string;
  draftParagraphSpacing: string;
}

export interface ModelDownloadInfo {
  modelName: string;
  provider: string;
  status: 'not_downloaded' | 'downloading' | 'downloaded' | 'error';
  downloadProgress: number;
  sizeBytes?: bigint;
  downloadedAt?: Date;
  errorMessage?: string;
}

/**
 * Get the current application configuration
 */
export async function getConfig(): Promise<AppConfig> {
  const configs = await prisma.config.findMany();
  
  const configMap = new Map(configs.map(c => [c.key, c.value]));
  
  return {
    embeddingProvider: (configMap.get('embedding.provider') as any) || 'transformers',
    embeddingModel: configMap.get('embedding.model') || 'Xenova/all-MiniLM-L6-v2',
    openaiApiKey: configMap.get('embedding.openaiApiKey'),
    claudeApiKey: configMap.get('embedding.claudeApiKey'),
    groqApiKey: configMap.get('ai.groqApiKey'),
    grokApiKey: configMap.get('ai.grokApiKey'),
    ollamaHost: configMap.get('embedding.ollamaHost'),
    ollamaModel: configMap.get('embedding.ollamaModel'),
    ollamaCompletionHost: configMap.get('ai.ollamaCompletionHost'),
    ollamaCompletionModel: configMap.get('ai.ollamaCompletionModel'),
    enableDocumentSummary: configMap.get('embedding.enableDocumentSummary') !== 'false',
    workerPoolSize: parseInt(configMap.get('workers.poolSize') || process.env.WORKER_POOL_SIZE || '20', 10),
    minUiWorkers: parseInt(configMap.get('workers.minUi') || process.env.MIN_UI_WORKERS || '3', 10),
    minBgWorkers: parseInt(configMap.get('workers.minBg') || process.env.MIN_BG_WORKERS || '2', 10),
    pidKp: parseFloat(configMap.get('workers.pidKp') || process.env.PID_KP || '2.0'),
    pidKi: parseFloat(configMap.get('workers.pidKi') || process.env.PID_KI || '0.5'),
    pidKd: parseFloat(configMap.get('workers.pidKd') || process.env.PID_KD || '0.1'),
    maxParsingWorkers: parseInt(configMap.get('parsing.maxWorkerCount') || process.env.MAX_PARSING_WORKERS || '4', 10),
    ocrProvider: (configMap.get('pipeline.ocrProvider') as any) || 'local',
    ocrOllamaHost: configMap.get('pipeline.ocrOllamaHost'),
    ocrOllamaModel: configMap.get('pipeline.ocrOllamaModel'),
    parsingWorkerCount: parseInt(configMap.get('parsing.workerCount') || '1', 10),
    ocrThreshold: parseInt(configMap.get('pipeline.ocrThreshold') || '50', 10),
    ocrConcurrency: parseInt(configMap.get('pipeline.ocrConcurrency') || '2', 10),
    embeddingBatchSize: parseInt(configMap.get('pipeline.embeddingBatchSize') || '50', 10),
    // Image preprocessing settings (defaults match DEFAULT_PREPROCESS_SETTINGS)
    ocrUpscale: configMap.get('pipeline.ocrUpscale') !== 'false',
    ocrMinWidth: parseInt(configMap.get('pipeline.ocrMinWidth') || '1000', 10),
    ocrMinDpi: parseInt(configMap.get('pipeline.ocrMinDpi') || '150', 10),
    ocrGrayscale: configMap.get('pipeline.ocrGrayscale') !== 'false',
    ocrNormalize: configMap.get('pipeline.ocrNormalize') !== 'false',
    ocrClahe: configMap.get('pipeline.ocrClahe') !== 'false',
    ocrClaheClipLimit: parseInt(configMap.get('pipeline.ocrClaheClipLimit') || '3', 10),
    ocrSharpen: configMap.get('pipeline.ocrSharpen') !== 'false',
    ocrSharpenSigma: parseFloat(configMap.get('pipeline.ocrSharpenSigma') || '1.0'),
    ocrResize: configMap.get('pipeline.ocrResize') !== 'false',
    ocrMaxWidth: parseInt(configMap.get('pipeline.ocrMaxWidth') || '2048', 10),
    ocrPngCompression: parseInt(configMap.get('pipeline.ocrPngCompression') || '6', 10),
    // Draft settings
    draftPageSize: (configMap.get('draft.pageSize') as any) || 'letter',
    draftMarginTop: parseInt(configMap.get('draft.marginTop') || '96', 10),
    draftMarginBottom: parseInt(configMap.get('draft.marginBottom') || '96', 10),
    draftMarginLeft: parseInt(configMap.get('draft.marginLeft') || '96', 10),
    draftMarginRight: parseInt(configMap.get('draft.marginRight') || '96', 10),
    // Draft style defaults
    draftDefaultFont: configMap.get('draft.defaultFont') || 'Times New Roman',
    draftDefaultFontSize: configMap.get('draft.defaultFontSize') || '12px',
    draftH1Size: configMap.get('draft.h1Size') || '24px',
    draftH2Size: configMap.get('draft.h2Size') || '20px',
    draftH3Size: configMap.get('draft.h3Size') || '16px',
    draftH4Size: configMap.get('draft.h4Size') || '14px',
    draftH5Size: configMap.get('draft.h5Size') || '12px',
    draftLineSpacing: configMap.get('draft.lineSpacing') || '1.5',
    draftParagraphSpacing: configMap.get('draft.paragraphSpacing') || '12px',
    // Reranking
    rerankEnabled: configMap.get('rerank.enabled') === 'true',
    rerankProvider: (configMap.get('rerank.provider') as any) || 'vllm',
    rerankModel: configMap.get('rerank.model') || 'Qwen/Qwen3-Reranker-8B',
    rerankHost: configMap.get('rerank.host') || '',
    rerankTopN: parseInt(configMap.get('rerank.topN') || '10', 10),
    rerankAutoManage: configMap.get('rerank.autoManage') !== 'false', // default: true
    rerankIdleTimeoutMin: parseInt(configMap.get('rerank.idleTimeoutMin') || '5', 10),
    rerankScoreValidation: configMap.get('rerank.scoreValidation') !== 'false', // default: true
    rerankFallbackModel: configMap.get('rerank.fallbackModel') || '',
    // Per-model GPU idle timeouts
    gpuIdleEmbeddingMin: parseInt(configMap.get('gpu.idle.embedding') || '0', 10),
    gpuIdleCompletionMin: parseInt(configMap.get('gpu.idle.completion') || '10', 10),
    gpuIdleOcrMin: parseInt(configMap.get('gpu.idle.ocr') || '5', 10),
    gpuIdleRerankerMin: parseInt(configMap.get('gpu.idle.reranker') || '5', 10),
    // Per-model minimum online instances
    gpuMinEmbedding: parseInt(configMap.get('gpu.min.embedding') || '0', 10),
    gpuMinCompletion: parseInt(configMap.get('gpu.min.completion') || '0', 10),
    gpuMinOcr: parseInt(configMap.get('gpu.min.ocr') || '0', 10),
    gpuMinReranker: parseInt(configMap.get('gpu.min.reranker') || '0', 10),
    // Registered sidecars
    gpuSidecars: configMap.get('gpu.sidecars') || '[]',
    // GPU orchestrator
    gpuMode: (configMap.get('gpu.mode') as any) || 'searching',
    gpuAutoManage: configMap.get('gpu.autoManage') === 'true',
    // Per-role "Use Orchestrator" toggles — backward compat: if key not set but gpuAutoManage is true, default to true
    embeddingUseOrchestrator: configMap.has('embedding.useOrchestrator')
      ? configMap.get('embedding.useOrchestrator') === 'true'
      : configMap.get('gpu.autoManage') === 'true',
    completionUseOrchestrator: configMap.has('ai.completionUseOrchestrator')
      ? configMap.get('ai.completionUseOrchestrator') === 'true'
      : configMap.get('gpu.autoManage') === 'true',
    ocrUseOrchestrator: configMap.has('pipeline.ocrUseOrchestrator')
      ? configMap.get('pipeline.ocrUseOrchestrator') === 'true'
      : configMap.get('gpu.autoManage') === 'true',
    rerankUseOrchestrator: configMap.has('rerank.useOrchestrator')
      ? configMap.get('rerank.useOrchestrator') === 'true'
      : configMap.get('gpu.autoManage') === 'true',
  };
}

// --- Per-sidecar idle timeout overrides ---

export type SidecarIdleTimeouts = { embedding?: number; completion?: number; ocr?: number; reranker?: number };

/** Derive a stable DB key segment from a sidecar URL. */
function sidecarIdFromUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Get effective idle timeouts for a specific sidecar (per-sidecar overrides + global fallback). */
export async function getSidecarIdleTimeouts(sidecarUrl: string): Promise<SidecarIdleTimeouts> {
  const id = sidecarIdFromUrl(sidecarUrl);
  const configs = await prisma.config.findMany({
    where: { key: { startsWith: `gpu.idle.sidecar.${id}.` } },
  });
  const overrides: Record<string, number> = {};
  for (const c of configs) {
    const role = c.key.split('.').pop()!;
    overrides[role] = parseInt(c.value, 10);
  }
  return overrides;
}

/** Save per-sidecar idle timeout overrides. Only saves defined keys. */
export async function setSidecarIdleTimeouts(sidecarUrl: string, timeouts: SidecarIdleTimeouts): Promise<void> {
  const id = sidecarIdFromUrl(sidecarUrl);
  const ops = Object.entries(timeouts)
    .filter(([, v]) => v !== undefined)
    .map(([role, val]) =>
      prisma.config.upsert({
        where: { key: `gpu.idle.sidecar.${id}.${role}` },
        update: { value: String(val), updatedAt: new Date() },
        create: { key: `gpu.idle.sidecar.${id}.${role}`, value: String(val) },
      })
    );
  await Promise.all(ops);
}

/** Clear all per-sidecar idle timeout overrides (reset to global). */
export async function clearSidecarIdleTimeouts(sidecarUrl: string): Promise<void> {
  const id = sidecarIdFromUrl(sidecarUrl);
  await prisma.config.deleteMany({ where: { key: { startsWith: `gpu.idle.sidecar.${id}.` } } });
}

/** Get per-sidecar overrides for all given sidecar URLs. */
export async function getAllSidecarIdleTimeouts(sidecarUrls: string[]): Promise<Record<string, SidecarIdleTimeouts>> {
  const result: Record<string, SidecarIdleTimeouts> = {};
  const allConfigs = await prisma.config.findMany({
    where: { key: { startsWith: 'gpu.idle.sidecar.' } },
  });
  for (const url of sidecarUrls) {
    const id = sidecarIdFromUrl(url);
    const prefix = `gpu.idle.sidecar.${id}.`;
    const overrides: Record<string, number> = {};
    for (const c of allConfigs) {
      if (c.key.startsWith(prefix)) {
        const role = c.key.slice(prefix.length);
        overrides[role] = parseInt(c.value, 10);
      }
    }
    if (Object.keys(overrides).length > 0) {
      result[url] = overrides;
    }
  }
  return result;
}

/**
 * Update a configuration value
 */
export async function setConfigValue(key: string, value: string): Promise<void> {
  await prisma.config.upsert({
    where: { key },
    update: { value, updatedAt: new Date() },
    create: { key, value },
  });
}

/**
 * Update multiple configuration values
 */
export async function updateConfig(config: Partial<AppConfig>): Promise<void> {
  const updates: Array<{ key: string; value: string }> = [];
  
  if (config.embeddingProvider) {
    updates.push({ key: 'embedding.provider', value: config.embeddingProvider });
  }
  
  if (config.embeddingModel) {
    updates.push({ key: 'embedding.model', value: config.embeddingModel });
  }
  
  if (config.openaiApiKey !== undefined) {
    updates.push({ key: 'embedding.openaiApiKey', value: config.openaiApiKey });
  }
  
  if (config.claudeApiKey !== undefined) {
    updates.push({ key: 'embedding.claudeApiKey', value: config.claudeApiKey });
  }

  if (config.groqApiKey !== undefined) {
    updates.push({ key: 'ai.groqApiKey', value: config.groqApiKey });
  }

  if (config.grokApiKey !== undefined) {
    updates.push({ key: 'ai.grokApiKey', value: config.grokApiKey });
  }

  if (config.ollamaHost !== undefined) {
    updates.push({ key: 'embedding.ollamaHost', value: config.ollamaHost });
  }

  if (config.ollamaModel !== undefined) {
    updates.push({ key: 'embedding.ollamaModel', value: config.ollamaModel });
  }

  if (config.ollamaCompletionHost !== undefined) {
    updates.push({ key: 'ai.ollamaCompletionHost', value: config.ollamaCompletionHost });
  }

  if (config.ollamaCompletionModel !== undefined) {
    updates.push({ key: 'ai.ollamaCompletionModel', value: config.ollamaCompletionModel });
  }

  if (config.enableDocumentSummary !== undefined) {
    updates.push({ key: 'embedding.enableDocumentSummary', value: String(config.enableDocumentSummary) });
  }

  if (config.workerPoolSize !== undefined) {
    updates.push({ key: 'workers.poolSize', value: String(config.workerPoolSize) });
  }

  if (config.minUiWorkers !== undefined) {
    updates.push({ key: 'workers.minUi', value: String(config.minUiWorkers) });
  }

  if (config.minBgWorkers !== undefined) {
    updates.push({ key: 'workers.minBg', value: String(config.minBgWorkers) });
  }

  if (config.pidKp !== undefined) {
    updates.push({ key: 'workers.pidKp', value: String(config.pidKp) });
  }

  if (config.pidKi !== undefined) {
    updates.push({ key: 'workers.pidKi', value: String(config.pidKi) });
  }

  if (config.pidKd !== undefined) {
    updates.push({ key: 'workers.pidKd', value: String(config.pidKd) });
  }

  if (config.maxParsingWorkers !== undefined) {
    updates.push({ key: 'parsing.maxWorkerCount', value: String(config.maxParsingWorkers) });
  }

  if (config.ocrProvider !== undefined) {
    updates.push({ key: 'pipeline.ocrProvider', value: config.ocrProvider });
  }

  if (config.ocrOllamaHost !== undefined) {
    updates.push({ key: 'pipeline.ocrOllamaHost', value: config.ocrOllamaHost });
  }

  if (config.ocrOllamaModel !== undefined) {
    updates.push({ key: 'pipeline.ocrOllamaModel', value: config.ocrOllamaModel });
  }

  // Reranking settings
  if (config.rerankEnabled !== undefined) {
    updates.push({ key: 'rerank.enabled', value: String(config.rerankEnabled) });
  }
  if (config.rerankProvider !== undefined) {
    updates.push({ key: 'rerank.provider', value: config.rerankProvider });
  }
  if (config.rerankModel !== undefined) {
    updates.push({ key: 'rerank.model', value: config.rerankModel });
  }
  if (config.rerankHost !== undefined) {
    updates.push({ key: 'rerank.host', value: config.rerankHost });
  }
  if (config.rerankTopN !== undefined) {
    updates.push({ key: 'rerank.topN', value: String(config.rerankTopN) });
  }
  if (config.rerankAutoManage !== undefined) {
    updates.push({ key: 'rerank.autoManage', value: String(config.rerankAutoManage) });
  }
  if (config.rerankIdleTimeoutMin !== undefined) {
    updates.push({ key: 'rerank.idleTimeoutMin', value: String(config.rerankIdleTimeoutMin) });
  }
  if (config.rerankScoreValidation !== undefined) {
    updates.push({ key: 'rerank.scoreValidation', value: String(config.rerankScoreValidation) });
  }
  if (config.rerankFallbackModel !== undefined) {
    updates.push({ key: 'rerank.fallbackModel', value: config.rerankFallbackModel });
  }

  // Per-model GPU idle timeouts
  if (config.gpuIdleEmbeddingMin !== undefined) {
    updates.push({ key: 'gpu.idle.embedding', value: String(config.gpuIdleEmbeddingMin) });
  }
  if (config.gpuIdleCompletionMin !== undefined) {
    updates.push({ key: 'gpu.idle.completion', value: String(config.gpuIdleCompletionMin) });
  }
  if (config.gpuIdleOcrMin !== undefined) {
    updates.push({ key: 'gpu.idle.ocr', value: String(config.gpuIdleOcrMin) });
  }
  if (config.gpuIdleRerankerMin !== undefined) {
    updates.push({ key: 'gpu.idle.reranker', value: String(config.gpuIdleRerankerMin) });
  }
  // Per-model minimum online instances
  if (config.gpuMinEmbedding !== undefined) {
    updates.push({ key: 'gpu.min.embedding', value: String(config.gpuMinEmbedding) });
  }
  if (config.gpuMinCompletion !== undefined) {
    updates.push({ key: 'gpu.min.completion', value: String(config.gpuMinCompletion) });
  }
  if (config.gpuMinOcr !== undefined) {
    updates.push({ key: 'gpu.min.ocr', value: String(config.gpuMinOcr) });
  }
  if (config.gpuMinReranker !== undefined) {
    updates.push({ key: 'gpu.min.reranker', value: String(config.gpuMinReranker) });
  }
  if (config.gpuSidecars !== undefined) {
    updates.push({ key: 'gpu.sidecars', value: config.gpuSidecars });
  }
  if (config.gpuMode !== undefined) {
    updates.push({ key: 'gpu.mode', value: config.gpuMode });
  }
  if (config.gpuAutoManage !== undefined) {
    updates.push({ key: 'gpu.autoManage', value: String(config.gpuAutoManage) });
  }
  // Per-role "Use Orchestrator" toggles
  if (config.embeddingUseOrchestrator !== undefined) {
    updates.push({ key: 'embedding.useOrchestrator', value: String(config.embeddingUseOrchestrator) });
  }
  if (config.completionUseOrchestrator !== undefined) {
    updates.push({ key: 'ai.completionUseOrchestrator', value: String(config.completionUseOrchestrator) });
  }
  if (config.ocrUseOrchestrator !== undefined) {
    updates.push({ key: 'pipeline.ocrUseOrchestrator', value: String(config.ocrUseOrchestrator) });
  }
  if (config.rerankUseOrchestrator !== undefined) {
    updates.push({ key: 'rerank.useOrchestrator', value: String(config.rerankUseOrchestrator) });
  }

  // Draft settings
  if (config.draftPageSize !== undefined) {
    updates.push({ key: 'draft.pageSize', value: config.draftPageSize });
  }
  if (config.draftMarginTop !== undefined) {
    updates.push({ key: 'draft.marginTop', value: String(config.draftMarginTop) });
  }
  if (config.draftMarginBottom !== undefined) {
    updates.push({ key: 'draft.marginBottom', value: String(config.draftMarginBottom) });
  }
  if (config.draftMarginLeft !== undefined) {
    updates.push({ key: 'draft.marginLeft', value: String(config.draftMarginLeft) });
  }
  if (config.draftMarginRight !== undefined) {
    updates.push({ key: 'draft.marginRight', value: String(config.draftMarginRight) });
  }
  // Draft style defaults
  if (config.draftDefaultFont !== undefined) {
    updates.push({ key: 'draft.defaultFont', value: config.draftDefaultFont });
  }
  if (config.draftDefaultFontSize !== undefined) {
    updates.push({ key: 'draft.defaultFontSize', value: config.draftDefaultFontSize });
  }
  if (config.draftH1Size !== undefined) {
    updates.push({ key: 'draft.h1Size', value: config.draftH1Size });
  }
  if (config.draftH2Size !== undefined) {
    updates.push({ key: 'draft.h2Size', value: config.draftH2Size });
  }
  if (config.draftH3Size !== undefined) {
    updates.push({ key: 'draft.h3Size', value: config.draftH3Size });
  }
  if (config.draftH4Size !== undefined) {
    updates.push({ key: 'draft.h4Size', value: config.draftH4Size });
  }
  if (config.draftH5Size !== undefined) {
    updates.push({ key: 'draft.h5Size', value: config.draftH5Size });
  }
  if (config.draftLineSpacing !== undefined) {
    updates.push({ key: 'draft.lineSpacing', value: config.draftLineSpacing });
  }
  if (config.draftParagraphSpacing !== undefined) {
    updates.push({ key: 'draft.paragraphSpacing', value: config.draftParagraphSpacing });
  }

  // Execute all updates
  await Promise.all(
    updates.map(({ key, value }) => setConfigValue(key, value))
  );
}

/**
 * Get model download status for all models
 */
export async function getModelDownloadStatus(): Promise<ModelDownloadInfo[]> {
  const downloads = await prisma.modelDownload.findMany();
  
  return downloads.map(d => ({
    modelName: d.modelName,
    provider: d.provider,
    status: d.status as any,
    downloadProgress: d.downloadProgress,
    sizeBytes: d.sizeBytes || undefined,
    downloadedAt: d.downloadedAt || undefined,
    errorMessage: d.errorMessage || undefined,
  }));
}

/**
 * Update model download status
 */
export async function updateModelDownloadStatus(
  modelName: string,
  provider: string,
  status: 'not_downloaded' | 'downloading' | 'downloaded' | 'error',
  progress: number = 0,
  sizeBytes?: bigint,
  errorMessage?: string
): Promise<void> {
  await prisma.modelDownload.upsert({
    where: { modelName },
    update: {
      status,
      downloadProgress: progress,
      sizeBytes: sizeBytes !== undefined ? sizeBytes : null,
      errorMessage: errorMessage !== undefined ? errorMessage : null,
      downloadedAt: status === 'downloaded' ? new Date() : null,
      updatedAt: new Date(),
    },
    create: {
      modelName,
      provider,
      status,
      downloadProgress: progress,
      sizeBytes: sizeBytes !== undefined ? sizeBytes : null,
      errorMessage: errorMessage !== undefined ? errorMessage : null,
      downloadedAt: status === 'downloaded' ? new Date() : null,
    },
  });
}

/**
 * Get download status for a specific model
 */
export async function getModelDownload(modelName: string): Promise<ModelDownloadInfo | null> {
  const download = await prisma.modelDownload.findUnique({
    where: { modelName },
  });
  
  if (!download) {
    return null;
  }
  
  return {
    modelName: download.modelName,
    provider: download.provider,
    status: download.status as any,
    downloadProgress: download.downloadProgress,
    sizeBytes: download.sizeBytes || undefined,
    downloadedAt: download.downloadedAt || undefined,
    errorMessage: download.errorMessage || undefined,
  };
}
