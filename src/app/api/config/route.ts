/**
 * Configuration API Route
 * 
 * Handles reading and updating application configuration.
 * 
 * Requirements: 18.9, 18.10
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getConfig,
  updateConfig,
  toPublicConfig,
  isSecretConfigKey,
  API_KEY_FIELDS,
  type ApiKeyField,
} from '@/lib/db/config';
import { prisma } from '@/lib/db/prisma';
import { invalidateRerankCache } from '@/lib/search/reranker';
import { logger } from '@/lib/logger';
import { requireApiAccess } from '@/lib/api/route-guard';

/**
 * Provider credentials are **write-only** over HTTP (v6 §4 — the plain GET
 * used to return four live keys in plaintext to any origin that could reach
 * the port).
 *
 * - `GET` returns `apiKeys: { <provider>: { configured, last4? } }` and no
 *   `*ApiKey` field at all (see `toPublicConfig`).
 * - `POST` writes a key only when the body carries a **non-empty string** for
 *   that field. Absent, empty, or a non-string (an admin panel round-tripping
 *   the masked GET body) all mean "leave the stored key unchanged" — never
 *   "clear it". Clearing a key is done deliberately via
 *   `POST /api/admin/ai-keys` with an empty `apiKey`.
 */
function pickWritableKey(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

/**
 * GET /api/config
 * Get current configuration, with provider credentials masked.
 *
 * When called with `?key=<dotted.key>` returns only that single Config-table
 * value as `{ key, value }` — useful for round-trip verification of writes
 * without pulling the full config blob. Secret-bearing rows are refused:
 * unfiltered, this read returned `embedding.openaiApiKey` — and `mcp.apiKeys`,
 * the credential that satisfies the guard on every other route.
 */
export async function GET(request: NextRequest) {
  try {
    const denied = await requireApiAccess(request, { label: 'config GET', allowAdminSession: true });
    if (denied) return denied;

    const url = new URL(request.url);
    const singleKey = url.searchParams.get('key');
    if (singleKey) {
      if (isSecretConfigKey(singleKey)) {
        return NextResponse.json(
          { error: `Config key "${singleKey}" holds a credential and is not readable over HTTP.` },
          { status: 403 },
        );
      }
      const row = await prisma.config.findUnique({ where: { key: singleKey } });
      return NextResponse.json({ key: singleKey, value: row?.value ?? null });
    }
    // `?resolve=localModels` returns what the MCP local profile would actually
    // use for decompose and the evidence outline right now — the full chain
    // (admin config → env → host tags), not just the stored keys. Opt-in
    // because it probes the Ollama host; the plain GET stays DB-only.
    if (url.searchParams.get('resolve') === 'localModels') {
      const config = await getConfig();
      const { localDecomposeModel, localOutlineModel } = await import('@/lib/mcp/routing-defaults');
      const [decompose, outline] = await Promise.all([
        localDecomposeModel(config).catch(() => null),
        localOutlineModel(config).catch(() => null),
      ]);
      return NextResponse.json({ decompose, outline });
    }

    const config = await getConfig();
    return NextResponse.json(toPublicConfig(config));
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get configuration' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/config
 * Update configuration
 */
export async function POST(request: NextRequest) {
  try {
    const denied = await requireApiAccess(request, { label: 'config POST', allowAdminSession: true });
    if (denied) return denied;

    const body = await request.json();

    // Write-only credentials. Anything that is not a non-empty string is
    // dropped here, so a panel that POSTs the masked GET body back verbatim
    // neither clears the stored key nor writes `[object Object]` into it.
    const keyWrites: Partial<Record<ApiKeyField, string>> = {};
    for (const field of API_KEY_FIELDS) {
      const value = pickWritableKey(body[field]);
      if (value !== undefined) keyWrites[field] = value;
    }

    // Validate required fields
    if (!body.embeddingProvider) {
      return NextResponse.json(
        { error: 'embeddingProvider is required' },
        { status: 400 }
      );
    }
    
    if (!body.embeddingModel) {
      return NextResponse.json(
        { error: 'embeddingModel is required' },
        { status: 400 }
      );
    }
    
    // Validate provider
    if (!['transformers', 'openai', 'claude', 'ollama'].includes(body.embeddingProvider)) {
      return NextResponse.json(
        { error: 'Invalid embedding provider' },
        { status: 400 }
      );
    }

    const currentConfig = await getConfig();

    // Validate API key requirements against the EFFECTIVE key — what will be
    // stored after this write. Under write-only semantics the body normally
    // carries no key at all (the toolbar's re-index save and the reranking
    // panel both round-trip the masked GET), so checking `body.openaiApiKey`
    // alone would reject every save while the provider is openai/claude.
    if (body.embeddingProvider === 'openai' && !(keyWrites.openaiApiKey ?? currentConfig.openaiApiKey)) {
      return NextResponse.json(
        { error: 'OpenAI API key is required when using OpenAI provider' },
        { status: 400 }
      );
    }

    if (body.embeddingProvider === 'claude' && !(keyWrites.claudeApiKey ?? currentConfig.claudeApiKey)) {
      return NextResponse.json(
        { error: 'Claude API key is required when using Claude provider' },
        { status: 400 }
      );
    }

    if (body.embeddingProvider === 'ollama' && !body.ollamaHost && !body.embeddingUseOrchestrator) {
      return NextResponse.json(
        { error: 'Ollama host URL is required when using Ollama provider (unless Orchestrator is enabled)' },
        { status: 400 }
      );
    }

    // Check what actually changed
    const modelChanged = body.embeddingModel !== currentConfig.embeddingModel;
    const providerChanged = body.embeddingProvider !== currentConfig.embeddingProvider;
    const hostChanged = body.ollamaHost !== currentConfig.ollamaHost;
    const ollamaModelChanged = body.ollamaModel !== currentConfig.ollamaModel;

    // For Ollama, ensure ollamaModel stays in sync with embeddingModel
    const ollamaModel = body.embeddingProvider === 'ollama'
      ? (body.ollamaModel || body.embeddingModel)
      : body.ollamaModel;

    // Check if OCR config changed
    const ocrProviderChanged = body.ocrProvider !== undefined && body.ocrProvider !== currentConfig.ocrProvider;
    const ocrHostChanged = body.ocrOllamaHost !== undefined && body.ocrOllamaHost !== currentConfig.ocrOllamaHost;
    const ocrModelChanged = body.ocrOllamaModel !== undefined && body.ocrOllamaModel !== currentConfig.ocrOllamaModel;

    // Update configuration
    await updateConfig({
      embeddingProvider: body.embeddingProvider,
      embeddingModel: body.embeddingModel,
      // Write-only: only a non-empty string reaches the store (see keyWrites).
      openaiApiKey: keyWrites.openaiApiKey,
      claudeApiKey: keyWrites.claudeApiKey,
      ollamaHost: body.ollamaHost,
      ollamaModel,
      // Code embedding model (ss-code-embedding) — independent of text embedding.
      codeOllamaModel: body.codeOllamaModel,
      ollamaCompletionHost: body.ollamaCompletionHost,
      ollamaCompletionModel: body.ollamaCompletionModel,
      ollamaDecomposeModel: body.ollamaDecomposeModel,
      ollamaOutlineModel: body.ollamaOutlineModel,
      // AI Services — primary/fallback selection
      aiPrimaryProvider: body.aiPrimaryProvider,
      aiPrimaryModel: body.aiPrimaryModel,
      cacheTtl: body.cacheTtl,
      aiFallbackEnabled: body.aiFallbackEnabled,
      aiFallbackProvider: body.aiFallbackProvider,
      aiFallbackModel: body.aiFallbackModel,
      ocrProvider: body.ocrProvider,
      ocrOllamaHost: body.ocrOllamaHost,
      ocrOllamaModel: body.ocrOllamaModel,
      // Reranking
      rerankEnabled: body.rerankEnabled,
      rerankProvider: body.rerankProvider,
      rerankModel: body.rerankModel,
      rerankHost: body.rerankHost,
      rerankTopN: body.rerankTopN,
      // Per-model vLLM gpu-memory-utilization (weight) — pushed to sidecars
      gpuMemUtilReranker: body.gpuMemUtilReranker,
      gpuMemUtilRlm: body.gpuMemUtilRlm,
      // Reranker throughput knobs
      rerankInteractiveTimeoutMs: body.rerankInteractiveTimeoutMs,
      rerankEnforceEager: body.rerankEnforceEager,
      rerankPoolSize: body.rerankPoolSize,
      // Per-role orchestrator toggles
      embeddingUseOrchestrator: body.embeddingUseOrchestrator,
      completionUseOrchestrator: body.completionUseOrchestrator,
      ocrUseOrchestrator: body.ocrUseOrchestrator,
      rerankUseOrchestrator: body.rerankUseOrchestrator,
    });

    // If the model or provider changed, re-queue all INDEXED documents that used the old model.
    // Build the stamped model name matching what the pipeline writes to Document.embeddingModel:
    // Ollama stamps "ollama/{model}", others stamp the raw model name.
    let requeuedCount = 0;
    if (modelChanged || providerChanged || ollamaModelChanged) {
      const stampedModel =
        body.embeddingProvider === 'ollama'
          ? `ollama/${body.ollamaModel || body.embeddingModel}`
          : body.embeddingModel;
      const result = await prisma.document.updateMany({
        where: {
          status: 'INDEXED',
          embeddingModel: { not: stampedModel },
        },
        data: { status: 'QUEUED' },
      });
      requeuedCount = result.count;
    }

    // Always reinitialize the pipeline when any config is saved.
    // This ensures OCR/embedding changes take effect immediately even if
    // the DB already had the new value (e.g. saved before manager was ready).
    try {
      const { reinitializePipeline } = await import('@/services/worker-init');
      await reinitializePipeline();
    } catch (err) {
      // Non-fatal — workers will use old config until next restart
      console.error('Failed to reinitialize pipeline after config change:', err);
    }

    // Bust reranker config cache so new settings take effect immediately
    invalidateRerankCache();

    // If GPU auto-manage is enabled and model-related fields changed, push to all sidecars
    const completionModelChanged = body.ollamaCompletionModel !== undefined && body.ollamaCompletionModel !== currentConfig.ollamaCompletionModel;
    const rerankModelChanged = body.rerankModel !== undefined && body.rerankModel !== currentConfig.rerankModel;
    const gpuMemUtilRerankerChanged =
      body.gpuMemUtilReranker !== undefined && body.gpuMemUtilReranker !== currentConfig.gpuMemUtilReranker;
    const gpuMemUtilRlmChanged =
      body.gpuMemUtilRlm !== undefined && body.gpuMemUtilRlm !== currentConfig.gpuMemUtilRlm;
    const enforceEagerChanged =
      body.rerankEnforceEager !== undefined && body.rerankEnforceEager !== currentConfig.rerankEnforceEager;
    // Reranker container start-args changed → recreate the reranker container
    // explicitly (stop+start) on its assigned sidecars so it takes effect now.
    // NOTE: rerankPoolSize and rerankInteractiveTimeoutMs are master-side only —
    // they apply on the next search with no container restart.
    const rerankerContainerChanged = gpuMemUtilRerankerChanged || enforceEagerChanged || rerankModelChanged;
    // Other roles: lazy push (drift recreates on next use).
    const plainPushNeeded = ollamaModelChanged || completionModelChanged || ocrModelChanged || gpuMemUtilRlmChanged;

    const anyOrchestrator = currentConfig.gpuAutoManage || currentConfig.embeddingUseOrchestrator || currentConfig.completionUseOrchestrator || currentConfig.ocrUseOrchestrator || currentConfig.rerankUseOrchestrator;
    let rerankerRestart = false;
    if (anyOrchestrator && (plainPushNeeded || rerankerContainerChanged)) {
      try {
        const { getFleetStatus, pushModelRegistry, restartRerankerOnAssignedSidecars } = await import('@/lib/gpu/fleet-router');
        if (plainPushNeeded) {
          const fleet = await getFleetStatus();
          for (const sidecar of fleet.sidecars) {
            pushModelRegistry(sidecar.url).catch(() => {}); // fire-and-forget
          }
        }
        if (rerankerContainerChanged) {
          // Log WHICH setting triggered the restart. A cold reranker restart
          // costs 30-60s; if these appear frequently in the logs, a caller is
          // re-pushing a changed reranker arg and starving live searches — the
          // "restart storm" failure mode for the interactive-timeout warnings.
          logger.warn('Reranker container restart triggered by config change', {
            gpuMemUtilRerankerChanged,
            enforceEagerChanged,
            rerankModelChanged,
            from: {
              gpuMemUtilReranker: currentConfig.gpuMemUtilReranker,
              rerankEnforceEager: currentConfig.rerankEnforceEager,
              rerankModel: currentConfig.rerankModel,
            },
            to: {
              gpuMemUtilReranker: body.gpuMemUtilReranker,
              rerankEnforceEager: body.rerankEnforceEager,
              rerankModel: body.rerankModel,
            },
          });
          // Fire-and-forget: a cold reranker restart can take 30-60s; don't
          // block the config save. Progress is logged.
          restartRerankerOnAssignedSidecars().catch(() => {});
          rerankerRestart = true;
        }
      } catch {
        // Non-fatal — fleet router may not be initialized
      }
    }

    return NextResponse.json({ success: true, requeuedCount, rerankerRestart });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
