/**
 * Router for the `routed` profile (REPORT-v2.1 Part B.2, work item 9b).
 *
 * 1. `classifyTier`        — query → tier (explicit non-auto mode wins).
 * 2. `resolveTierSettings` — tier → `TierSettings` by layering
 *    `overrides > inlinePreset.routing[tier] > activePreset.routing[tier] >
 *    defaults[tier]`, then clamping against the capability registry
 *    (`src/lib/ai/models.ts`). Every clamp is reported so nothing is silent.
 * 3. `estimateCostClass` / `estimateSeconds` — coarse cost hints; the seconds
 *    estimate drives `research_report`'s 45 s self-promotion rule.
 */

import {
  AI_PROVIDER_KEYS,
  clampEffort,
  getModelCaps,
  type AIProviderKey,
  type EffortLevel,
} from '../../ai/models';
import { classifyQueryComplexity, routeToResearchMode } from '../../search/query-router';
import { DEFAULT_MODELS } from '../tools/ai-helper';
import { enforceProvider, McpError } from '../llm-policy';
import { RESEARCH_TIERS, type PresetV2, type ResearchMode, type ResearchTier, type TierSettings } from '../research-types';
import { isCatalogModel } from '../presets/preset-schema';

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

export interface TierDecision {
  tier: ResearchTier;
  reason: string;
  confidence: number;
}

export function classifyTier(query: string, explicitMode?: ResearchMode): TierDecision {
  if (explicitMode && explicitMode !== 'auto') {
    if (!(RESEARCH_TIERS as string[]).includes(explicitMode)) {
      throw new McpError('INVALID_PARAMS', `mode must be one of auto, ${RESEARCH_TIERS.join(', ')}`);
    }
    return { tier: explicitMode, reason: 'explicit', confidence: 1 };
  }
  const decision = classifyQueryComplexity(query);
  return {
    tier: routeToResearchMode(decision.route),
    reason: decision.reason,
    confidence: decision.confidence,
  };
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

export interface ResolveTierInput {
  activePreset?: PresetV2 | null;
  inlinePreset?: PresetV2 | null;
  overrides?: Partial<TierSettings> | null;
  defaults: Record<ResearchTier, TierSettings>;
}

export interface ResolvedTier {
  resolved: TierSettings;
  /** Name of the preset that contributed the highest preset layer, if any. */
  presetUsed?: string;
  clamps: string[];
}

const TIER_KEYS: readonly (keyof TierSettings)[] = [
  'provider', 'model', 'effort', 'thinking', 'maxTokens', 'multiPass', 'useRlm', 'rlmMaxRounds',
];

/**
 * Field-wise overlay: only fields the layer actually defines replace the
 * accumulated value. A layer that changes `provider` without naming a
 * `model` also discards the inherited model — it belonged to the old
 * provider and would be rejected by the new one.
 */
function overlay(base: Partial<TierSettings>, layer?: Partial<TierSettings> | null): Partial<TierSettings> {
  if (!layer) return base;
  const out: Partial<TierSettings> = { ...base };
  if (layer.provider !== undefined && layer.provider !== base.provider && layer.model === undefined) {
    delete out.model;
  }
  for (const key of TIER_KEYS) {
    const v = layer[key];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

function isProviderKey(v: unknown): v is AIProviderKey {
  return typeof v === 'string' && (AI_PROVIDER_KEYS as string[]).includes(v);
}

export function resolveTierSettings(tier: ResearchTier, input: ResolveTierInput): ResolvedTier {
  const clamps: string[] = [];
  let presetUsed: string | undefined;

  let acc: Partial<TierSettings> = { ...(input.defaults[tier] ?? {}) };
  const activeLayer = input.activePreset?.routing?.[tier];
  if (activeLayer) { acc = overlay(acc, activeLayer); presetUsed = input.activePreset!.name; }
  const inlineLayer = input.inlinePreset?.routing?.[tier];
  if (inlineLayer) { acc = overlay(acc, inlineLayer); presetUsed = input.inlinePreset!.name; }
  acc = overlay(acc, input.overrides);

  // --- provider -----------------------------------------------------------
  const provider = enforceProvider('routed', acc.provider);
  if (!provider) {
    throw new McpError('NO_PROVIDER', `no provider resolved for tier "${tier}" — apply a preset or configure a primary provider in Admin → AI Services`);
  }
  if (!isProviderKey(provider)) {
    throw new McpError('INVALID_PROVIDER', `unknown provider "${provider}" (expected ${AI_PROVIDER_KEYS.join(', ')})`);
  }

  // --- model --------------------------------------------------------------
  let model = acc.model;
  if (model && !isCatalogModel(provider, model)) {
    clamps.push(`model "${model}" is not in the ${provider} catalog → ${DEFAULT_MODELS[provider]}`);
    model = undefined;
  }
  if (!model) model = DEFAULT_MODELS[provider];

  const caps = getModelCaps(provider, model);
  const resolved: TierSettings = { provider, model };

  // --- effort -------------------------------------------------------------
  if (acc.effort !== undefined) {
    if (caps.effort) {
      const clamped = clampEffort(acc.effort as EffortLevel, caps.effort);
      if (clamped !== acc.effort) clamps.push(`effort ${acc.effort} → ${clamped} (${model} supports ${caps.effort.join('/')})`);
      resolved.effort = clamped;
    } else {
      clamps.push(`effort ${acc.effort} dropped (${model} has no effort control)`);
    }
  }

  // --- thinking -----------------------------------------------------------
  if (acc.thinking !== undefined) {
    if (acc.thinking && !caps.thinking) clamps.push(`thinking dropped (${model} does not support it)`);
    else resolved.thinking = acc.thinking;
  }

  // --- maxTokens ----------------------------------------------------------
  if (acc.maxTokens !== undefined) {
    if (acc.maxTokens > caps.maxTokensCap) {
      clamps.push(`maxTokens ${acc.maxTokens} → ${caps.maxTokensCap} (${model} cap)`);
      resolved.maxTokens = caps.maxTokensCap;
    } else {
      resolved.maxTokens = acc.maxTokens;
    }
  }

  // --- pipeline flags -----------------------------------------------------
  if (acc.multiPass !== undefined) resolved.multiPass = acc.multiPass;
  if (acc.useRlm !== undefined) resolved.useRlm = acc.useRlm;
  if (acc.rlmMaxRounds !== undefined) resolved.rlmMaxRounds = acc.rlmMaxRounds;

  return { resolved, ...(presetUsed ? { presetUsed } : {}), clamps };
}

// ---------------------------------------------------------------------------
// Cost hints
// ---------------------------------------------------------------------------

export type CostClass = 'gpu-only' | 'low' | 'medium' | 'high';

export function estimateCostClass(tier: ResearchTier, settings: TierSettings): CostClass {
  if (settings.provider === 'ollama') return 'gpu-only';
  const heavyEffort = settings.effort === 'xhigh' || settings.effort === 'max';
  if (tier === 'deep-report' || tier === 'deep-rlm' || settings.multiPass || settings.useRlm) return 'high';
  if (tier === 'deep') return heavyEffort ? 'high' : 'medium';
  return heavyEffort ? 'medium' : 'low';
}

const TIER_SECONDS: Record<ResearchTier, number> = {
  fast: 10,
  deep: 40,
  'deep-report': 90,
  'deep-rlm': 75,
};

/** Expected wall-clock seconds. Simple table; pipeline flags promote a tier
 *  to the slower row they imply. Drives the 45 s self-promotion rule. */
export function estimateSeconds(tier: ResearchTier, settings: TierSettings): number {
  let s = TIER_SECONDS[tier];
  if (settings.multiPass) s = Math.max(s, TIER_SECONDS['deep-report']);
  if (settings.useRlm) s = Math.max(s, TIER_SECONDS['deep-rlm']);
  return s;
}

export const PROMOTE_THRESHOLD_SECONDS = 45;

export function wouldPromoteToJob(tier: ResearchTier, settings: TierSettings): boolean {
  return estimateSeconds(tier, settings) > PROMOTE_THRESHOLD_SECONDS;
}
