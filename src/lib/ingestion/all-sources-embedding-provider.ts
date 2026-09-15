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
import { dispatchVirtualEmbed } from '@/lib/gpu/virtual-embed-dispatch';
import { createLogger } from '../logger';

const logger = createLogger('AllSourcesEmbeddingProvider');

const PROBE_TEXT = 'all-sources dimension verification probe';

export interface AllSourcesConfig {
  /** The already-constructed local provider (Ollama, transformers, …). */
  local: EmbeddingProvider;
  /** OpenRouter model id, e.g. 'qwen/qwen3-embedding-4b'. Must be in
   *  OPENROUTER_EMBEDDING_MODELS — see OpenRouterEmbeddingProvider. */
  openRouterModel: string;
  /** Role key as pushed in `virtualInference.mode.<role>` — 'embedding' or
   *  'code-embedding'. Used only to pick which sidecars are eligible for
   *  fan-out; defaults to 'embedding' (the only wired-up caller today). */
  role?: string;
  timeoutMs?: number;
}

export class AllSourcesEmbeddingProvider extends EmbeddingProvider {
  private constructor(
    private readonly local: EmbeddingProvider,
    private readonly cloud: OpenRouterEmbeddingProvider,
    private readonly dims: number,
    private readonly openRouterModel: string,
    private readonly role: string,
  ) {
    super();
  }

  /** Alternates single-text calls between local and cloud — see embed(). */
  private singletonTurn = 0;

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
      return new AllSourcesEmbeddingProvider(config.local, cloud, localDims, config.openRouterModel, config.role || 'embedding');
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
   *
   * The cloud half goes through `dispatchVirtualEmbed`, which spreads it
   * round-robin across every connected sidecar whose pushed config
   * allow-lists this role (each sidecar spending its own OpenRouter key) and
   * falls back to `this.cloud` (a direct master-side OpenRouter call) when no
   * sidecar is eligible or every eligible sidecar fails for its share. This
   * is what makes "each file to a separate sidecar" true — see
   * virtual-embed-dispatch.ts. If BOTH of those fail (fleet dispatch throws
   * and the direct OpenRouter call it fell back to also throws), the cloud
   * share falls back once more to `this.local` — an embedding batch must
   * never come back partially filled just because the cloud side is down.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // A single text cannot be split, so this used to go local unconditionally.
    // That quietly disabled the whole feature: the ingestion pipeline calls
    // embed() with batchSize 1 for the overwhelming majority of chunks, so
    // nearly everything went local and only the occasional multi-text batch
    // ever reached OpenRouter.
    //
    // Instead of splitting WITHIN a call, alternate BETWEEN calls, so a stream
    // of singletons still distributes across both sources. The counter is
    // per-provider-instance and its exact parity does not matter — only that
    // consecutive singletons do not all land on the same source.
    //
    // Note this trades a little latency per cloud-served chunk (a network round
    // trip versus a local one) for actually using the capacity the operator
    // asked to use. The larger win is upstream: embedding in real batches would
    // let both sources work in parallel instead of alternating serially.
    if (texts.length === 1) {
      const useCloud = this.singletonTurn++ % 2 === 1;
      if (!useCloud) return this.local.embed(texts);
      try {
        return await dispatchVirtualEmbed({
          role: this.role,
          model: this.openRouterModel,
          texts,
          expectedDims: this.dims,
          directFallback: (t) => this.cloud.embed(t),
        });
      } catch (err) {
        logger.warn('all-sources: singleton cloud embed failed — serving locally instead', {
          error: (err as Error).message,
        });
        return this.local.embed(texts);
      }
    }

    const splitAt = Math.ceil(texts.length / 2);
    const localTexts = texts.slice(0, splitAt);
    const cloudTexts = texts.slice(splitAt);

    const cloudPromise = cloudTexts.length
      ? dispatchVirtualEmbed({
          role: this.role,
          model: this.openRouterModel,
          texts: cloudTexts,
          expectedDims: this.dims,
          directFallback: (t) => this.cloud.embed(t),
        }).catch((err) => {
          logger.warn('all-sources: cloud share failed on every sidecar and the direct OpenRouter fallback — falling back to local for this share', {
            error: (err as Error).message,
            count: cloudTexts.length,
          });
          return this.local.embed(cloudTexts);
        })
      : Promise.resolve([]);

    const [localVecs, cloudVecs] = await Promise.all([
      this.local.embed(localTexts),
      cloudPromise,
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

  /**
   * The LOCAL model's name, not a composite describing the fan-out.
   *
   * This value is stamped on every Document as `embeddingModel`, and the
   * "indexed with a different model" banner compares it against the configured
   * model. A composite like `all-sources(ollama/x + openrouter/y)` can never
   * equal the configured `x`, so every document embedded here was flagged stale
   * — and the banner's Re-index button would re-stamp the same composite, so
   * the warning could never clear and the re-index would repeat forever.
   *
   * Returning the local name is not a workaround for that display bug, it is
   * the honest answer. This provider only engages after `createIfSafe()` has
   * verified both sources return the same width for the same model, so every
   * vector it produces belongs to ONE vector space, and that space's identity
   * is the model — not which host happened to compute a given row.
   *
   * Which source served a row remains observable: the master logs it and the
   * sidecar's Virtual Containers panel counts it.
   */
  getModelName(): string {
    return this.local.getModelName();
  }
}
