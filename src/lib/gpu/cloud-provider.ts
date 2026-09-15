/**
 * Cloud provider abstraction for fleet-router's Phase 4 (§9.2,
 * docs/SPEC-openrouter-virtual-inference.md).
 *
 * `resolveEndpoint()` in ./fleet-router has three local phases (running
 * container → acquire on a reachable sidecar → acquire on any sidecar).
 * `docs/SPEC-runpod-overflow.md` separately claims a "Phase 4" in the same
 * function for RunPod overflow. Two specs hard-coding one phase number into
 * one function is a guaranteed merge conflict, so neither spec gets its own
 * phase: `resolveEndpoint()` has ONE Phase 4 that walks this ordered list.
 * OpenRouter implements it today; RunPod plugs into the same list later.
 * Operators reorder providers, not phases.
 */

import type { AppConfig } from '@/lib/db/config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CloudProvider');

export interface CloudResolveCtx {
  config: AppConfig;
}

export interface CloudEndpoint {
  /** Which provider actually resolved this, e.g. 'openrouter'. */
  providerId: string;
  /** Model id to use for the call. */
  model: string;
}

export interface CloudProvider {
  readonly id: string;
  /** Cheap, synchronous eligibility check — no network calls. */
  canServe(role: string, config: AppConfig): boolean;
  /**
   * Resolve an endpoint for `role`, or return null if unavailable right now
   * (not configured, daily cap reached, circuit breaker open, etc). Must
   * never throw for an ordinary "unavailable" condition — only for a
   * genuine bug. `resolveEndpoint()`'s Phase 4 treats a thrown error and a
   * null return the same way: try the next provider.
   */
  resolve(role: string, ctx: CloudResolveCtx): Promise<CloudEndpoint | null>;
}

/**
 * OpenRouter, serving the `completion` role (search/chat) today. Embedding
 * and reranker roles reach OpenRouter through their own dedicated paths
 * (OpenRouterEmbeddingProvider / rerankViaOpenRouter in ./search/reranker) —
 * they predate this abstraction and are stateful/table-routing concerns
 * this generic interface doesn't need to own.
 */
export const openRouterCloudProvider: CloudProvider = {
  id: 'openrouter',

  canServe(role, config) {
    if (!config.openRouterEnabled) return false;
    if (role === 'completion') return !!config.openRouterChatModel;
    return false;
  },

  async resolve(role, ctx) {
    if (!this.canServe(role, ctx.config)) return null;
    try {
      // Spend guard: daily cap + circuit breaker. A cap/circuit refusal here
      // means "not available right now", not a config error — fall through
      // to the next cloud provider (today: none, so the caller's existing
      // no-endpoint error surfaces, exactly as if OpenRouter didn't exist).
      const { assertSpendAllowed } = await import('@/lib/openrouter/client');
      await assertSpendAllowed(role);
    } catch (err) {
      logger.info(`OpenRouter cloud fallback unavailable for role "${role}"`, {
        error: (err as Error).message,
      });
      return null;
    }
    if (role === 'completion') {
      return { providerId: 'openrouter', model: ctx.config.openRouterChatModel! };
    }
    return null;
  },
};

/** Ordered list consulted by fleet-router's Phase 4. */
export function getCloudProviders(): CloudProvider[] {
  return [openRouterCloudProvider];
}
