/**
 * Configuration API Route
 * 
 * Handles reading and updating application configuration.
 * 
 * Requirements: 18.9, 18.10
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/db/config';
import { prisma } from '@/lib/db/prisma';
import { invalidateRerankCache } from '@/lib/search/reranker';

/**
 * GET /api/config
 * Get current configuration.
 *
 * When called with `?key=<dotted.key>` returns only that single Config-table
 * value as `{ key, value }` — useful for round-trip verification of writes
 * without pulling the full config blob.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const singleKey = url.searchParams.get('key');
    if (singleKey) {
      const row = await prisma.config.findUnique({ where: { key: singleKey } });
      return NextResponse.json({ key: singleKey, value: row?.value ?? null });
    }
    const config = await getConfig();
    return NextResponse.json(config);
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
    const body = await request.json();
    
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

    // Validate API key requirements
    if (body.embeddingProvider === 'openai' && !body.openaiApiKey) {
      return NextResponse.json(
        { error: 'OpenAI API key is required when using OpenAI provider' },
        { status: 400 }
      );
    }

    if (body.embeddingProvider === 'claude' && !body.claudeApiKey) {
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
    const currentConfig = await getConfig();
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
      openaiApiKey: body.openaiApiKey,
      claudeApiKey: body.claudeApiKey,
      ollamaHost: body.ollamaHost,
      ollamaModel,
      // Code embedding model (ss-code-embedding) — independent of text embedding.
      codeOllamaModel: body.codeOllamaModel,
      ollamaCompletionHost: body.ollamaCompletionHost,
      ollamaCompletionModel: body.ollamaCompletionModel,
      // AI Services — primary/fallback selection
      aiPrimaryProvider: body.aiPrimaryProvider,
      aiPrimaryModel: body.aiPrimaryModel,
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
    // gpu-memory-utilization changes must also propagate to the sidecar so the
    // container restarts with the new --gpu-memory-utilization in its vllmArgs.
    const gpuMemUtilChanged =
      (body.gpuMemUtilReranker !== undefined && body.gpuMemUtilReranker !== currentConfig.gpuMemUtilReranker) ||
      (body.gpuMemUtilRlm !== undefined && body.gpuMemUtilRlm !== currentConfig.gpuMemUtilRlm);
    const anyModelChanged = ollamaModelChanged || completionModelChanged || ocrModelChanged || rerankModelChanged;

    const anyOrchestrator = currentConfig.gpuAutoManage || currentConfig.embeddingUseOrchestrator || currentConfig.completionUseOrchestrator || currentConfig.ocrUseOrchestrator || currentConfig.rerankUseOrchestrator;
    if ((anyModelChanged || gpuMemUtilChanged) && anyOrchestrator) {
      try {
        const { getFleetStatus, pushModelRegistry } = await import('@/lib/gpu/fleet-router');
        const fleet = await getFleetStatus();
        for (const sidecar of fleet.sidecars) {
          pushModelRegistry(sidecar.url).catch(() => {}); // fire-and-forget
        }
      } catch {
        // Non-fatal — fleet router may not be initialized
      }
    }

    return NextResponse.json({ success: true, requeuedCount });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
