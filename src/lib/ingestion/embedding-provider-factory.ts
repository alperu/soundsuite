/**
 * The ONE place an embedding provider is chosen from admin config.
 *
 * This module exists because the choice was implemented three times and the
 * copies drifted. `worker-init.ts` grew the OpenRouter arms (POLICY 3
 * 'all-sources' and POLICY 4 'cloud-only'); `get-tool-registry.ts` grew its
 * own; and `api/documents/[id]/reindex-pages/route.ts` — which carried the
 * comment "same pattern as worker-init.ts" — grew neither. It kept a bare
 * four-case switch whose `ollama` arm went straight to `config.ollamaHost`.
 *
 * The consequence was a repair that could not succeed on an OpenRouter-only
 * install. With `virtualInferenceModeEmbedding: 'cloud-only'` and no local
 * embedding role loaded, every Fix Partial run died on:
 *
 *   Reindex request failed: Ollama embedding failed
 *   (http://<lan-host>:11434, model=qwen3-embedding:4b-fp16):
 *   model "qwen3-embedding:4b-fp16" not found, try pulling it first
 *
 * The operator had selected "OpenRouter Only" on /admin/openrouter. Search
 * honoured it (worker-init's POLICY 4 branch); repair did not, because repair
 * chose its provider here instead — and this copy had never heard of the
 * policy. The page was therefore unrepairable for a reason that had nothing
 * to do with the page.
 *
 * Same failure class as the `start.sh` heredoc in CLAUDE.md: a second,
 * hand-maintained transcription of logic that only one copy kept current.
 * Call this function; do not re-implement the switch.
 */

import { createLogger } from '@/lib/logger';
import type { EmbeddingProvider } from './embedding-provider';

const logger = createLogger('EmbeddingProviderFactory');

/** The config fields the choice actually reads. Structural, so both
 *  `getConfig()`'s return and test doubles satisfy it. */
export interface EmbeddingProviderConfig {
  embeddingProvider?: string;
  embeddingModel?: string;
  openaiApiKey?: string | null;
  claudeApiKey?: string | null;
  ollamaHost?: string | null;
  ollamaModel?: string | null;
  embeddingUseOrchestrator?: boolean;
  virtualInferenceModeEmbedding?: string;
  openRouterEnabled?: boolean;
  openRouterApiKey?: string | null;
  openRouterEmbeddingModel?: string | null;
}

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = 'qwen/qwen3-embedding-4b';

/**
 * Build the embedding provider the operator's config asks for.
 *
 * `context` names the caller in logs ('worker-init', 'reindex-pages', …) so a
 * provider surprise can be traced to the path that built it.
 */
export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  context: string,
): Promise<EmbeddingProvider> {
  let embeddingProvider: EmbeddingProvider;

  switch (config.embeddingProvider) {
    case 'openai': {
      const { OpenAIEmbeddingProvider } = await import('./openai-embedding-provider');
      embeddingProvider = new OpenAIEmbeddingProvider(config.openaiApiKey || '', config.embeddingModel);
      break;
    }
    case 'claude': {
      const { ClaudeEmbeddingProvider } = await import('./claude-embedding-provider');
      embeddingProvider = new ClaudeEmbeddingProvider(config.claudeApiKey || '', config.embeddingModel);
      break;
    }
    case 'ollama': {
      const { OllamaEmbeddingProvider } = await import('./ollama-embedding-provider');
      const embeddingHost = config.ollamaHost || 'http://localhost:11434';

      embeddingProvider = new OllamaEmbeddingProvider({
        host: embeddingHost,
        model: config.ollamaModel || config.embeddingModel || 'all-minilm',
        useOrchestrator: !!config.embeddingUseOrchestrator,
      });

      // POLICY 3 — 'all-sources': fan across local AND OpenRouter for
      // throughput. Opt-in, and re-verified live every time (see
      // AllSourcesEmbeddingProvider's header for why a static dims table is
      // not trusted). Verification failure falls back to local-only.
      if (config.virtualInferenceModeEmbedding === 'all-sources' && config.openRouterEnabled) {
        const { AllSourcesEmbeddingProvider } = await import('./all-sources-embedding-provider');
        const allSources = await AllSourcesEmbeddingProvider.createIfSafe({
          local: embeddingProvider,
          openRouterModel: config.openRouterEmbeddingModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL,
        });
        if (allSources) {
          embeddingProvider = allSources;
        } else {
          logger.warn('all-sources mode requested but verification failed — continuing local-only', {
            context,
            openRouterEmbeddingModel: config.openRouterEmbeddingModel,
          });
        }
      } else if (config.virtualInferenceModeEmbedding === 'cloud-only' && config.openRouterEnabled) {
        // POLICY 4 — 'cloud-only' ("OpenRouter Only" on /admin/openrouter).
        // The mode IS pushed to sidecars, which is why the setting looks like
        // it works; but the master's own provider is chosen here, and until
        // this branch existed it ignored the policy entirely.
        const { OpenRouterEmbeddingProvider } = await import('./openrouter-embedding-provider');
        const openRouterModel = config.openRouterEmbeddingModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL;
        embeddingProvider = new OpenRouterEmbeddingProvider({
          apiKey: config.openRouterApiKey ?? undefined,
          model: openRouterModel,
        });
        logger.info('Embedding routed to OpenRouter by policy (cloud-only)', { context, openRouterModel });
      }
      break;
    }
    case 'openrouter': {
      // Respect openRouterEnabled: an install that never turned OpenRouter on
      // must behave as before, even if the provider was left at 'openrouter'
      // by an earlier config edit.
      if (!config.openRouterEnabled) {
        logger.warn('embeddingProvider is "openrouter" but openRouterEnabled is false — falling back to local transformers', { context });
        const { TransformersEmbeddingProvider } = await import('./transformers-embedding-provider');
        embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel);
        break;
      }
      const { OpenRouterEmbeddingProvider } = await import('./openrouter-embedding-provider');
      const openRouterModel = config.openRouterEmbeddingModel || DEFAULT_OPENROUTER_EMBEDDING_MODEL;
      embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey: config.openRouterApiKey ?? undefined,
        model: openRouterModel,
      });
      break;
    }
    default: {
      const { TransformersEmbeddingProvider } = await import('./transformers-embedding-provider');
      embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel);
      break;
    }
  }

  logger.info('Embedding provider initialized', {
    context,
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    providerClass: embeddingProvider.constructor.name,
    dimensions: embeddingProvider.getDimensions(),
    modelName: embeddingProvider.getModelName(),
    mode: config.virtualInferenceModeEmbedding,
  });

  return embeddingProvider;
}
