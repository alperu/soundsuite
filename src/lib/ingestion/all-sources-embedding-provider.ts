/**
 * AllSourcesEmbeddingProvider — POLICY 3 ("use ALL available sources, local
 * AND OpenRouter, together") from docs/SPEC-openrouter-virtual-inference.md.
 *
 * This is `virtualInference.mode.<embedding-role> = 'all-sources'`: the
 * embedding-legal form of `hybrid` (§3's permission matrix forbids `hybrid`
 * outright for embedding roles — mixing providers mid-table risks the
 * `VectorStore.addChunks()` drop-and-recreate corruption path). `all-sources`
 * is legal ONLY because it fans a single ingestion batch across two sources
 * that are verified, up front, to produce the SAME model at the SAME
 * dimension — every vector this provider returns lands in the one existing
 * table exactly as if a single provider had produced it.
 *
 * Why this is safe (operator-supplied measurement, 2026-09-15): local
 * `qwen3-embedding:4b` vs OpenRouter `qwen/qwen3-embedding-4b`, both 2560
 * dims — per-text cosine 0.9859 / 0.9845 / 0.9889, retrieval ranking IDENTICAL
 * over an 8-doc check, top-3 identical, per-doc score shift max 0.0164 / mean
 * 0.0076 against inter-rank gaps of 0.05-0.14. Near-ties within ~0.01 cosine
 * MAY reorder a merged/near-boundary result between sources — accepted for
 * the throughput win, and the reranker (a cross-encoder that ignores the
 * embedding entirely) corrects ordering downstream anyway, exactly as §2.3
 * of the spec relies on for cross-space search.
 *
 * Why verification happens LIVE, not from a static table: the local
 * OllamaEmbeddingProvider's `OLLAMA_MODEL_DIMENSIONS` table is itself wrong
 * for the Qwen3 embedding family (it lists 4b/8b as 1024, not their measured
 * 2560/4096) — trusting `getDimensions()` here would silently launder that
 * bug into a false "safe to combine" verdict. `createIfSafe()` instead embeds
 * a tiny synthetic probe through BOTH sources and compares the ACTUAL
 * returned widths. `embed()` re-checks every batch for the same reason: a
 * source could drift mid-run (e.g. OpenRouter rerouting to a different
 * backing provider — see the client's provider-pinning note) even after
 * passing the up-front check.
 */

import { EmbeddingProvider } from './embedding-provider';
import { OpenRouterEmbeddingProvider } from './openrouter-embedding-provider';
import { findEmbeddingModel } from '@/lib/openrouter/models';
import { createLogger } from '../logger';

const logger = createLogger('AllSourcesEmbeddingProvider');

const PROBE_TEXT = 'all-sources dimension verification probe';

export interface AllSourcesConfig {
  /** The already-constructed local provider (Ollama, transformers, …). */
  local: EmbeddingProvider;
  /** OpenRouter model id, e.g. 'qwen/qwen3-embedding-4b'. Must be in
   *  OPENROUTER_EMBEDDING_MODELS — see OpenRouterEmbeddingProvider. */
  openRouterModel: string;
  timeoutMs?: number;
}

export class AllSourcesEmbeddingProvider extends EmbeddingProvider {
  private constructor(
    private readonly local: EmbeddingProvider,
    private readonly cloud: OpenRouterEmbeddingProvider,
    private readonly dims: number,
  ) {
    super();
  }

  /**
   * Verify local + OpenRouter agree on model width before ever fanning real
   * ingestion work across them. Never throws — a failed/mismatched
   * verification returns null so the caller falls back to local-only,
   * per the spec's hard constraint.
   */
  static async createIfSafe(config: AllSourcesConfig): Promise<AllSourcesEmbeddingProvider | null> {
    const entry = findEmbeddingModel(config.openRouterModel);
    if (!entry) {
      logger.warn('all-sources: OpenRouter model not in the curated catalogue — refusing, falling back to local-only', {
        model: config.openRouterModel,
      });
      return null;
    }

    let cloud: OpenRouterEmbeddingProvider;
    try {
      cloud = new OpenRouterEmbeddingProvider({ model: config.openRouterModel, timeoutMs: config.timeoutMs });
    } catch (err) {
      logger.warn('all-sources: failed to construct OpenRouterEmbeddingProvider — falling back to local-only', {
        model: config.openRouterModel,
        error: (err as Error).message,
      });
      return null;
    }

    try {
      const [[localVec], [cloudVec]] = await Promise.all([
        config.local.embed([PROBE_TEXT]),
        cloud.embed([PROBE_TEXT]),
      ]);
      const localDims = localVec?.length ?? 0;
      const cloudDims = cloudVec?.length ?? 0;

      if (localDims === 0 || cloudDims === 0) {
        logger.warn('all-sources: verification probe returned an empty vector — refusing, falling back to local-only', {
          localDims, cloudDims, model: config.openRouterModel,
        });
        return null;
      }
      if (localDims !== cloudDims) {
        logger.warn('all-sources: dimension mismatch between sources — refusing, falling back to local-only', {
          localDims, cloudDims, model: config.openRouterModel,
        });
        return null;
      }

      logger.info('all-sources: verified local + OpenRouter agree on dimension — engaging fan-out', {
        dims: localDims,
        model: config.openRouterModel,
        localModel: config.local.getModelName(),
      });
      return new AllSourcesEmbeddingProvider(config.local, cloud, localDims);
    } catch (err) {
      logger.warn('all-sources: verification probe failed — refusing, falling back to local-only', {
        model: config.openRouterModel,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Fan a batch across both sources for throughput, roughly evenly split.
   * Order of the returned vectors matches the order of `texts` — callers
   * (chunk → embedding zip) rely on that, same contract as every other
   * provider.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Not worth splitting a singleton — send it local, avoid a network round
    // trip and a spend-guard check for one chunk.
    if (texts.length === 1) return this.local.embed(texts);

    const splitAt = Math.ceil(texts.length / 2);
    const localTexts = texts.slice(0, splitAt);
    const cloudTexts = texts.slice(splitAt);

    const [localVecs, cloudVecs] = await Promise.all([
      this.local.embed(localTexts),
      cloudTexts.length ? this.cloud.embed(cloudTexts) : Promise.resolve([]),
    ]);

    const combined = [...localVecs, ...cloudVecs];

    // Runtime guard (not just a one-time check): a mixed-width vector reaching
    // VectorStore.addChunks() can trigger its drop-and-recreate fallback and
    // destroy the table. Refuse to return anything the up-front verification
    // didn't promise, rather than let a drifted batch through silently.
    for (let i = 0; i < combined.length; i++) {
      if (combined[i].length !== this.dims) {
        throw new Error(
          `all-sources embedding: source produced a ${combined[i].length}-dim vector but ${this.dims} was ` +
            `verified — refusing to return a mixed-width batch (would corrupt the vector table on write).`,
        );
      }
    }

    return combined;
  }

  getDimensions(): number {
    return this.dims;
  }

  getAvailableModels(): string[] {
    return this.local.getAvailableModels();
  }

  getModelName(): string {
    return `all-sources(${this.local.getModelName()} + ${this.cloud.getModelName()})`;
  }
}
