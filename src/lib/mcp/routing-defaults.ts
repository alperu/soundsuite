/**
 * Default routing tables (REPORT-v2.1 Part B.2).
 *
 * `getDefaultRouting()` is what the `routed` profile uses when no preset is
 * active: `fast` → Ollama, every other tier → the provider marked primary in
 * Admin → AI Services (`ai.primaryProvider` / `ai.primaryModel`), `effort:
 * medium`, `thinking: true` where the model supports it. Operators override
 * it by saving a preset named `default`.
 *
 * `LOCAL_ROUTING` is the fixed table for the `local` profile: Ollama on every
 * tier, a shorter RLM budget.
 */

import { getConfig } from '../db/config';
import { getModelCaps, AI_PROVIDER_KEYS, type AIProviderKey } from '../ai/models';
import { getAvailableProvider, DEFAULT_MODELS } from './tools/ai-helper';
import { LOCAL_PROVIDER } from './llm-policy';
import type { ResearchTier, TierSettings } from './research-types';

export const LOCAL_ROUTING: Record<ResearchTier, TierSettings> = {
  fast:          { provider: LOCAL_PROVIDER },
  deep:          { provider: LOCAL_PROVIDER },
  'deep-report': { provider: LOCAL_PROVIDER, multiPass: true },
  'deep-rlm':    { provider: LOCAL_PROVIDER, useRlm: true, rlmMaxRounds: 2 },
};

function isProviderKey(v: unknown): v is AIProviderKey {
  return typeof v === 'string' && (AI_PROVIDER_KEYS as string[]).includes(v);
}

/**
 * Resolve the provider/model the cloud tiers default to: the primary provider
 * from Admin → AI Services when set, else ai-helper's auto-detect.
 */
async function resolvePrimary(config: Awaited<ReturnType<typeof getConfig>>): Promise<{ provider: string; model?: string }> {
  if (isProviderKey(config.aiPrimaryProvider)) {
    const provider = config.aiPrimaryProvider;
    const model =
      config.aiPrimaryModel ||
      (provider === 'ollama' ? config.ollamaCompletionModel : undefined) ||
      DEFAULT_MODELS[provider];
    return { provider, model };
  }
  try {
    return await getAvailableProvider();
  } catch {
    // Nothing configured at all — still return a table; preset_apply /
    // routing resolution will fail loudly on the missing provider later.
    return { provider: LOCAL_PROVIDER, model: config.ollamaCompletionModel };
  }
}

export async function getDefaultRouting(): Promise<Record<ResearchTier, TierSettings>> {
  const config = await getConfig();
  const primary = await resolvePrimary(config);

  const thinking = isProviderKey(primary.provider)
    ? getModelCaps(primary.provider, primary.model).thinking
    : false;

  const cloud = (): TierSettings => ({
    provider: primary.provider,
    ...(primary.model ? { model: primary.model } : {}),
    effort: 'medium',
    ...(thinking ? { thinking: true } : {}),
  });

  return {
    fast: {
      provider: LOCAL_PROVIDER,
      ...(config.ollamaCompletionModel ? { model: config.ollamaCompletionModel } : {}),
    },
    deep: cloud(),
    'deep-report': { ...cloud(), multiPass: true },
    'deep-rlm': { ...cloud(), useRlm: true, rlmMaxRounds: 4 },
  };
}
