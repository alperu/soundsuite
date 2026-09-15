/**
 * OpenRouterEmbeddingProvider - cloud embedding generation via OpenRouter.
 *
 * Wraps `src/lib/openrouter/client.ts#embed()`, which is the single place this
 * codebase talks to OpenRouter (spend guard, circuit breaker, key hygiene all
 * live there). This provider's job is just to plug that client into the
 * `EmbeddingProvider` interface safely:
 *
 * - **Provider pinning.** Every call passes `pinProvider` from the curated
 *   catalogue entry (`OPENROUTER_EMBEDDING_MODELS`). Two providers serving the
 *   same model do not guarantee identical vectors — an unpinned call could
 *   silently reroute mid-corpus and split one logical vector space in two,
 *   degrading recall with no error anywhere.
 * - **Dimension safety.** `expectedDims` is passed straight through to
 *   `embed()`, which throws before returning if the response width doesn't
 *   match. `VectorStore.addChunks()` reacts to a schema mismatch by dropping
 *   and recreating the table, so a wrong-width vector reaching a write path
 *   can destroy an existing corpus — this must fail closed, before any write.
 *
 * Only the models in `OPENROUTER_EMBEDDING_MODELS` are supported (currently
 * qwen3-embedding 4b/8b, plus the OpenAI/Google embedding models OpenRouter
 * proxies). Model selection, spend caps, and circuit breaking are NOT this
 * provider's concern — they belong to the shared OpenRouter client.
 */

import { EmbeddingProvider } from './embedding-provider';
import { embed as openRouterEmbed, OpenRouterError } from '@/lib/openrouter/client';
import { OPENROUTER_EMBEDDING_MODELS, findEmbeddingModel, type OpenRouterEmbeddingModel } from '@/lib/openrouter/models';
import { createLogger } from '../logger';

const logger = createLogger('OpenRouterEmbeddingProvider');

export interface OpenRouterEmbeddingConfig {
  /** API key is read from Config by the shared client — not required here,
   *  but accepted for parity with other providers' constructors and for
   *  callers that want to fail fast on a missing key before first use. */
  apiKey?: string;
  /** OpenRouter model id, e.g. 'qwen/qwen3-embedding-4b'. Must be one of
   *  OPENROUTER_EMBEDDING_MODELS — anything else throws in the constructor. */
  model: string;
  /** Optional override. Normally left unset — dims are resolved from the
   *  curated catalogue entry, which is the source of truth (MEASURED, not
   *  guessed). Only useful for tests. */
  dims?: number;
  timeoutMs?: number;
}

export class OpenRouterEmbeddingProvider extends EmbeddingProvider {
  private readonly modelEntry: OpenRouterEmbeddingModel;
  private readonly model: string;
  private readonly dims: number;
  private readonly timeoutMs?: number;

  constructor(config: OpenRouterEmbeddingConfig) {
    super();

    const entry = findEmbeddingModel(config.model);
    if (!entry) {
      throw new Error(
        `Unsupported OpenRouter embedding model: ${config.model}. Available models: ` +
          `${OPENROUTER_EMBEDDING_MODELS.map((m) => m.id).join(', ')}`,
      );
    }

    this.modelEntry = entry;
    this.model = entry.id;
    this.dims = config.dims ?? entry.dims;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Generate embeddings via OpenRouter.
   *
   * `pinProvider` and `expectedDims` are always passed — see the module
   * header. A wrong-width response throws inside `embed()` before this
   * method returns anything, so a caller can never write bad vectors.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      const result = await openRouterEmbed(texts, this.model, {
        pinProvider: this.modelEntry.pinProvider,
        expectedDims: this.dims,
        timeoutMs: this.timeoutMs,
        role: 'embedding',
      });

      logger.info(
        `Embedding ${texts.length} chunks via OpenRouter ${this.model} (${result.dims}d)`,
        {
          model: this.model,
          provider: this.modelEntry.pinProvider,
          dims: result.dims,
          batchSize: texts.length,
          totalTokens: result.totalTokens,
        },
      );

      return result.vectors;
    } catch (error) {
      if (error instanceof OpenRouterError) {
        logger.error('OpenRouter embed FAILED', error, {
          model: this.model,
          provider: this.modelEntry.pinProvider,
          kind: error.kind,
          batchSize: texts.length,
        });
        throw error;
      }
      throw error;
    }
  }

  getDimensions(): number {
    return this.dims;
  }

  getAvailableModels(): string[] {
    return OPENROUTER_EMBEDDING_MODELS.map((m) => m.id);
  }

  getModelName(): string {
    return `openrouter/${this.model}`;
  }
}
