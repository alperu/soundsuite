/**
 * One wall-clock estimate for both callers (report v4, N-8).
 *
 * `routing_explain` and `research_evidence` used to disagree — or rather,
 * only `routing_explain` estimated at all, so the `local` profile never
 * promoted anything but `deep-rlm` to a job. Measured warm `local` `deep` is
 * 177.5 s against a 180 s proxy call timeout: it clears by 2.5 seconds and
 * times out on any slower day.
 *
 * The cloud numbers are unchanged — they delegate to `routed/routing.ts` so
 * `routing_explain` keeps reporting exactly what it reported before. What is
 * new is the local dimension: Ollama-served tiers get their own, measured,
 * much larger table, and `deep` crosses the 45 s promotion threshold.
 */

import { estimateSeconds, PROMOTE_THRESHOLD_SECONDS } from '../routed/routing';
import { LOCAL_PROVIDER } from '../llm-policy';
import type { ResearchMode, ResearchTier, TierSettings } from '../research-types';

export interface EstimateOptions {
  /**
   * Resolved provider for the tier; `ollama` selects the local table. When
   * neither `provider` nor `localOnly` is given the local table is used — the
   * conservative side, since over-promoting to a job costs a poll and
   * under-promoting costs a timed-out MCP call.
   */
  provider?: string;
  /** Local profile / `localOnly` run — forces the local table. */
  localOnly?: boolean;
  /**
   * Pipeline flags that promote a tier to the slower row they imply. Accepted
   * flat or nested under `settings` — callers use both shapes.
   */
  multiPass?: boolean;
  useRlm?: boolean;
  settings?: Pick<TierSettings, 'multiPass' | 'useRlm'>;
}

export interface ResearchEstimate {
  estimatedSeconds: number;
  wouldPromoteToJob: boolean;
}

/**
 * Measured local (Ollama) wall clock, warm host. `deep` is the v4 measurement
 * (177.5 s = decompose 14 + retrieve 91 + pattern 1 + fuse 10 + outline 60);
 * the report tiers add synthesis passes on top of that same retrieval.
 */
export const LOCAL_TIER_SECONDS: Record<ResearchTier, number> = {
  fast: 15,
  deep: 180,
  'deep-report': 300,
  'deep-rlm': 300,
};

/**
 * `auto` has not been routed yet at the point the promotion decision is made,
 * so it is costed as `deep` — the tier `auto` most often lands on, and the one
 * whose latency the caller must not be surprised by.
 */
export const AUTO_TIER: ResearchTier = 'deep';

export function resolveEstimateTier(mode: ResearchMode | undefined): ResearchTier {
  return !mode || mode === 'auto' ? AUTO_TIER : mode;
}

function flags(opts: EstimateOptions): { multiPass?: boolean; useRlm?: boolean } {
  return {
    multiPass: opts.multiPass ?? opts.settings?.multiPass,
    useRlm: opts.useRlm ?? opts.settings?.useRlm,
  };
}

function localSeconds(tier: ResearchTier, opts: EstimateOptions): number {
  const f = flags(opts);
  let s = LOCAL_TIER_SECONDS[tier];
  if (f.multiPass) s = Math.max(s, LOCAL_TIER_SECONDS['deep-report']);
  if (f.useRlm) s = Math.max(s, LOCAL_TIER_SECONDS['deep-rlm']);
  return s;
}

/**
 * Expected wall-clock seconds for a research call and whether it should run as
 * a background job rather than inline. The single source of truth — do not
 * write a second estimate anywhere.
 */
export function estimateResearchSeconds(
  mode: ResearchMode | undefined,
  opts: EstimateOptions = {},
): ResearchEstimate {
  const tier = resolveEstimateTier(mode);
  const isLocal = opts.localOnly === true || (opts.provider ?? LOCAL_PROVIDER) === LOCAL_PROVIDER;
  const f = flags(opts);
  const settings = {
    provider: opts.provider ?? LOCAL_PROVIDER,
    ...(f.multiPass !== undefined ? { multiPass: f.multiPass } : {}),
    ...(f.useRlm !== undefined ? { useRlm: f.useRlm } : {}),
  } as TierSettings;

  const estimatedSeconds = isLocal ? localSeconds(tier, opts) : estimateSeconds(tier, settings);

  return {
    estimatedSeconds,
    wouldPromoteToJob: estimatedSeconds > PROMOTE_THRESHOLD_SECONDS,
  };
}
