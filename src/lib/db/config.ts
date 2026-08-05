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
  // Code-aware embedding model (ss-code-embedding mode). Separate from the
  // text embedding model (ollamaModel) — used for agent/code search. Set on
  // /admin/embedding; does not affect how text embedding works.
  codeOllamaModel?: string;
  ollamaCompletionHost?: string;
  ollamaCompletionModel?: string;
  // RLM (Recursive Language Model) — long-context recursive reasoning role
  // served by vLLM. Picked on /admin/rlm and exposed as the ss-rlm mode.
  rlmModel?: string;
  rlmQuant?: 'fp16' | 'awq-int8' | 'awq-int4';
  rlmMaxContext?: number;
  // AI Services — primary/fallback selection used by MCP tools, AI search,
  // document summarization, analysis, and the tag-fill feature.
  aiPrimaryProvider?: string;
  aiPrimaryModel?: string;
  aiFallbackEnabled?: boolean;
  aiFallbackProvider?: string;
  aiFallbackModel?: string;
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
  /** Per-attempt Ollama OCR request timeout in ms. Default 90000.
   *  Cold model loads take 30-60s; median inference 30-40s (docs/TODO-ocr-speedups.md). */
  ocrTimeoutMs: number;
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
  /** Fetch timeout for vLLM /v1/rerank in ms. Default 90000.
   *  Cold-start of large rerankers (Qwen3-Reranker-8B) can take 30-60s. */
  rerankTimeoutMs: number;
  /** Shorter timeout (ms) for INTERACTIVE (user-facing) rerank calls. A live
   *  search should not block for the full cold-start budget — on timeout it
   *  falls back to first-stage order. Batch/background callers keep
   *  rerankTimeoutMs. Default 15000. */
  rerankInteractiveTimeoutMs: number;
  /** Whether the reranker vLLM runs with --enforce-eager. Default true (safe:
   *  flat VRAM, fast cold-start). Set false to enable CUDA graphs + torch.compile
   *  for higher prefill throughput at the cost of longer warm-up and more VRAM
   *  for graph capture — only safe with gpu-memory-utilization headroom (≤0.85).
   *  Pushed to the sidecar; toggles --enforce-eager in the reranker's vllmArgs. */
  rerankEnforceEager: boolean;
  /** Max candidates the reranker SCORES per call. vLLM scores every document
   *  sent (top_n only caps what's returned), so prefill cost scales with this.
   *  Trimmed by first-stage (hybrid) score before scoring. Master-side — no
   *  container restart. Default 150. Lower it to cut rerank latency on slow
   *  hosts at a small relevance cost. */
  rerankPoolSize: number;
  /** Per-document character cap before sending to /v1/rerank. Trims the tail
   *  to fit the model's context window. Default 30000 (~7500 tokens) for
   *  8K-context models like Qwen3-Reranker-8B. */
  rerankMaxDocChars: number;
  /** Hybrid-fusion RRF constant. Reciprocal Rank Fusion score is
   *  Σ 1/(k + rank). Default 60 (Cormack et al. 2009 / the production norm).
   *  Externalized so it can be tuned without a deploy; weighted/query-typed
   *  fusion is a separate opt-in. */
  fusionRrfK: number;
  /** Soft-boost multiplier applied to results whose metadata matches the
   *  caller's softBoostRefs (deep-search framing path). Default 1.2. A hint,
   *  not a hard filter — externalized for tuning. */
  fusionSoftBoost: number;
  // Per-model GPU idle timeouts (minutes, 0 = never stop)
  gpuIdleEmbeddingMin: number;
  gpuIdleCodeEmbeddingMin: number;
  gpuIdleCompletionMin: number;
  gpuIdleOcrMin: number;
  gpuIdleRerankerMin: number;
  gpuIdleRlmMin: number;
  // Per-model minimum online instances (0 = no minimum)
  gpuMinEmbedding: number;
  gpuMinCodeEmbedding: number;
  gpuMinCompletion: number;
  gpuMinOcr: number;
  gpuMinReranker: number;
  gpuMinRlm: number;
  // Per-model vLLM --gpu-memory-utilization (fraction 0-1). Only meaningful for
  // vLLM-served roles (reranker, rlm). Lower frees VRAM headroom; the value is
  // pushed to sidecars and flows into the container's vllmArgs. UNSET (undefined)
  // means "operator never chose" — the sidecar template default stands (reranker
  // 0.85, rlm 0.9). Only an explicitly-set value is pushed, so a reranker change
  // never silently re-tunes rlm.
  gpuMemUtilReranker?: number;
  gpuMemUtilRlm?: number;
  // Registered GPU sidecars (JSON string)
  gpuSidecars: string;
  /** URL each sidecar uses to connect back to this master. Pushed via /config
   *  on every register so the sidecar persists it for warm-boot without env. */
  masterUrl: string;
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
    codeOllamaModel: configMap.get('embedding.codeOllamaModel'),
    ollamaCompletionHost: configMap.get('ai.ollamaCompletionHost'),
    ollamaCompletionModel: configMap.get('ai.ollamaCompletionModel'),
    rlmModel: configMap.get('rlm.model'),
    rlmQuant: (configMap.get('rlm.quant') as AppConfig['rlmQuant']) || undefined,
    rlmMaxContext: configMap.has('rlm.maxContext')
      ? parseInt(configMap.get('rlm.maxContext') || '32768', 10)
      : undefined,
    // AI Services selection
    aiPrimaryProvider: configMap.get('ai.primaryProvider'),
    aiPrimaryModel: configMap.get('ai.primaryModel'),
    aiFallbackEnabled: configMap.get('ai.fallbackEnabled') === 'true',
    aiFallbackProvider: configMap.get('ai.fallbackProvider'),
    aiFallbackModel: configMap.get('ai.fallbackModel'),
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
    ocrTimeoutMs: parseInt(configMap.get('pipeline.ocrTimeoutMs') || '90000', 10),
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
    draftDefaultFontSize: configMap.get('draft.defaultFontSize') || '12pt',
    draftH1Size: configMap.get('draft.h1Size') || '24pt',
    draftH2Size: configMap.get('draft.h2Size') || '20pt',
    draftH3Size: configMap.get('draft.h3Size') || '16pt',
    draftH4Size: configMap.get('draft.h4Size') || '14pt',
    draftH5Size: configMap.get('draft.h5Size') || '12pt',
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
    rerankTimeoutMs: parseInt(configMap.get('rerank.timeoutMs') || '90000', 10),
    rerankInteractiveTimeoutMs: parseInt(configMap.get('rerank.interactiveTimeoutMs') || '30000', 10),
    rerankEnforceEager: configMap.get('rerank.enforceEager') !== 'false', // default true
    rerankMaxDocChars: parseInt(configMap.get('rerank.maxDocChars') || '18000', 10),
    rerankPoolSize: parseInt(configMap.get('rerank.poolSize') || '150', 10),
    fusionRrfK: parseInt(configMap.get('fusion.rrfK') || '60', 10),
    fusionSoftBoost: parseFloat(configMap.get('fusion.softBoost') || '1.2'),
    // Per-model GPU idle timeouts
    gpuIdleEmbeddingMin: parseInt(configMap.get('gpu.idle.embedding') || '0', 10),
    gpuIdleCodeEmbeddingMin: parseInt(configMap.get('gpu.idle.code-embedding') || '5', 10),
    gpuIdleCompletionMin: parseInt(configMap.get('gpu.idle.completion') || '10', 10),
    gpuIdleOcrMin: parseInt(configMap.get('gpu.idle.ocr') || '5', 10),
    gpuIdleRerankerMin: parseInt(configMap.get('gpu.idle.reranker') || '5', 10),
    gpuIdleRlmMin: parseInt(configMap.get('gpu.idle.rlm') || '10', 10),
    // Per-model minimum online instances
    gpuMinEmbedding: parseInt(configMap.get('gpu.min.embedding') || '0', 10),
    gpuMinCodeEmbedding: parseInt(configMap.get('gpu.min.code-embedding') || '0', 10),
    gpuMinCompletion: parseInt(configMap.get('gpu.min.completion') || '0', 10),
    gpuMinOcr: parseInt(configMap.get('gpu.min.ocr') || '0', 10),
    gpuMinReranker: parseInt(configMap.get('gpu.min.reranker') || '0', 10),
    gpuMinRlm: parseInt(configMap.get('gpu.min.rlm') || '0', 10),
    // Per-model vLLM gpu-memory-utilization (undefined when unset → template default)
    gpuMemUtilReranker: configMap.has('gpu.memUtil.reranker') ? parseFloat(configMap.get('gpu.memUtil.reranker')!) : undefined,
    gpuMemUtilRlm: configMap.has('gpu.memUtil.rlm') ? parseFloat(configMap.get('gpu.memUtil.rlm')!) : undefined,
    // Registered sidecars
    gpuSidecars: configMap.get('gpu.sidecars') || '[]',
    masterUrl: configMap.get('master.url') || process.env.SOUND_SUITE_MASTER_URL || '',
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

  if (config.codeOllamaModel !== undefined) {
    updates.push({ key: 'embedding.codeOllamaModel', value: config.codeOllamaModel });
  }

  if (config.ollamaCompletionHost !== undefined) {
    updates.push({ key: 'ai.ollamaCompletionHost', value: config.ollamaCompletionHost });
  }

  if (config.ollamaCompletionModel !== undefined) {
    updates.push({ key: 'ai.ollamaCompletionModel', value: config.ollamaCompletionModel });
  }

  if (config.rlmModel !== undefined) {
    updates.push({ key: 'rlm.model', value: config.rlmModel });
  }
  if (config.rlmQuant !== undefined) {
    updates.push({ key: 'rlm.quant', value: config.rlmQuant });
  }
  if (config.rlmMaxContext !== undefined) {
    updates.push({ key: 'rlm.maxContext', value: String(config.rlmMaxContext) });
  }

  // AI Services — primary/fallback selection
  if (config.aiPrimaryProvider !== undefined) {
    updates.push({ key: 'ai.primaryProvider', value: config.aiPrimaryProvider });
  }
  if (config.aiPrimaryModel !== undefined) {
    updates.push({ key: 'ai.primaryModel', value: config.aiPrimaryModel });
  }
  if (config.aiFallbackEnabled !== undefined) {
    updates.push({ key: 'ai.fallbackEnabled', value: String(config.aiFallbackEnabled) });
  }
  if (config.aiFallbackProvider !== undefined) {
    updates.push({ key: 'ai.fallbackProvider', value: config.aiFallbackProvider });
  }
  if (config.aiFallbackModel !== undefined) {
    updates.push({ key: 'ai.fallbackModel', value: config.aiFallbackModel });
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
  if (config.rerankTimeoutMs !== undefined) {
    updates.push({ key: 'rerank.timeoutMs', value: String(config.rerankTimeoutMs) });
  }
  if (config.rerankInteractiveTimeoutMs !== undefined) {
    updates.push({ key: 'rerank.interactiveTimeoutMs', value: String(config.rerankInteractiveTimeoutMs) });
  }
  if (config.rerankEnforceEager !== undefined) {
    updates.push({ key: 'rerank.enforceEager', value: String(config.rerankEnforceEager) });
  }
  if (config.rerankMaxDocChars !== undefined) {
    updates.push({ key: 'rerank.maxDocChars', value: String(config.rerankMaxDocChars) });
  }
  if (config.rerankPoolSize !== undefined) {
    updates.push({ key: 'rerank.poolSize', value: String(config.rerankPoolSize) });
  }
  if (config.fusionRrfK !== undefined) {
    updates.push({ key: 'fusion.rrfK', value: String(config.fusionRrfK) });
  }
  if (config.fusionSoftBoost !== undefined) {
    updates.push({ key: 'fusion.softBoost', value: String(config.fusionSoftBoost) });
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
  if (config.gpuIdleRlmMin !== undefined) {
    updates.push({ key: 'gpu.idle.rlm', value: String(config.gpuIdleRlmMin) });
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
  if (config.gpuMinRlm !== undefined) {
    updates.push({ key: 'gpu.min.rlm', value: String(config.gpuMinRlm) });
  }
  // Per-model vLLM gpu-memory-utilization
  if (config.gpuMemUtilReranker !== undefined) {
    updates.push({ key: 'gpu.memUtil.reranker', value: String(config.gpuMemUtilReranker) });
  }
  if (config.gpuMemUtilRlm !== undefined) {
    updates.push({ key: 'gpu.memUtil.rlm', value: String(config.gpuMemUtilRlm) });
  }
  if (config.gpuSidecars !== undefined) {
    updates.push({ key: 'gpu.sidecars', value: config.gpuSidecars });
  }
  if (config.masterUrl !== undefined) {
    updates.push({ key: 'master.url', value: config.masterUrl });
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
