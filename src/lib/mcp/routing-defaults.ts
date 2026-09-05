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
import { getModelCaps, clampEffort, AI_PROVIDER_KEYS, type AIProviderKey } from '../ai/models';
import { isProviderConfigured } from './presets/preset-schema';
import { getAvailableProvider, DEFAULT_MODELS } from './tools/ai-helper';
import { LOCAL_PROVIDER } from './llm-policy';
import type { ResearchTier, TierSettings } from './research-types';

/**
 * Preferred tag for the local evidence outline. Smaller than the decompose
 * model on purpose: this is JSON extraction over ≤40 already-retrieved
 * excerpts. Override with `SS_LOCAL_OUTLINE_MODEL`. Resolution falls back to
 * whatever the host actually has — see `localOutlineModel()`.
 */
export const LOCAL_OUTLINE_MODEL = process.env.SS_LOCAL_OUTLINE_MODEL || 'qwen3:1.7b';

/**
 * Budget for the local evidence outline (report v4, N-3). The outline is
 * constrained JSON extraction over text that has already been retrieved — it
 * does not need the 9B completion model, all 150 items, or a minute of wall
 * clock. Caps the input, the model size, and the ceiling.
 */
export interface OutlineRouting {
  /** Preferred Ollama tag; resolve at call time with `localOutlineModel()`. */
  model: string;
  timeoutMs: number;
  maxItems: number;
  maxCharsPerItem: number;
}

export const LOCAL_ROUTING: Record<ResearchTier, TierSettings> & { outline: OutlineRouting } = {
  fast:          { provider: LOCAL_PROVIDER },
  deep:          { provider: LOCAL_PROVIDER },
  'deep-report': { provider: LOCAL_PROVIDER, multiPass: true },
  'deep-rlm':    { provider: LOCAL_PROVIDER, useRlm: true, rlmMaxRounds: 2 },
  outline:       { model: LOCAL_OUTLINE_MODEL, timeoutMs: 25_000, maxItems: 40, maxCharsPerItem: 400 },
};

// ---------------------------------------------------------------------------
// Dedicated small decompose model (report M-1)
// ---------------------------------------------------------------------------

/**
 * Preferred tag for the local decompose / outline calls. These are short
 * JSON-structured prompts; a ~1.5–4B instruct model answers them in seconds
 * where the 9B completion model (thinking on by default) burns its whole
 * token budget. Override with `SS_LOCAL_DECOMPOSE_MODEL`.
 */
export const LOCAL_DECOMPOSE_MODEL = process.env.SS_LOCAL_DECOMPOSE_MODEL || 'qwen3:4b';

/** Small-instruct tags we will pick from `/api/tags` when nothing is configured. */
const SMALL_DECOMPOSE_TAG = /(qwen3(\.5)?:(1\.7|4)b|llama3\.2:3b|gemma3:4b|phi4-mini)/;

const TAGS_PROBE_TIMEOUT_MS = 3_000;
const TAGS_CACHE_MS = 60_000;
let _tagsCache: { at: number; host: string; tags: string[] } | null = null;

function ollamaBase(config: { ollamaCompletionHost?: string; ollamaHost?: string }): string {
  const host = (config.ollamaCompletionHost || config.ollamaHost || process.env.OLLAMA_HOST || '').trim();
  if (!host) return '';
  return (host.startsWith('http') ? host : `http://${host}`).replace(/\/+$/, '');
}

/** Model tags on the completion host, cached 60 s. Never throws; empty when unreachable. */
export async function listOllamaTags(config: { ollamaCompletionHost?: string; ollamaHost?: string }): Promise<string[]> {
  const base = ollamaBase(config);
  if (!base) return [];
  const now = Date.now();
  if (_tagsCache && _tagsCache.host === base && now - _tagsCache.at < TAGS_CACHE_MS) return _tagsCache.tags;
  let tags: string[] = [];
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(TAGS_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      tags = (body.models ?? []).map((m) => m.name || m.model || '').filter(Boolean);
    }
  } catch {
    tags = [];
  }
  _tagsCache = { at: Date.now(), host: base, tags };
  return tags;
}

/** Test hook — drop the cached tag list. */
export function resetOllamaTagsCache(): void {
  _tagsCache = null;
}

/**
 * Resolve the Ollama model the local profile uses for decompose and the
 * evidence outline. Preference order:
 *   1. `config.ollamaDecomposeModel` (Admin → AI Services, `ai.ollamaDecomposeModel`)
 *   2. `SS_LOCAL_DECOMPOSE_MODEL` (env)
 *   3. `LOCAL_DECOMPOSE_MODEL` when that tag is present on the host
 *   4. any small instruct tag on the host (`SMALL_DECOMPOSE_TAG`)
 *   5. the configured completion model / `DEFAULT_MODELS.ollama`
 *
 * Async because steps 3–4 read `/api/tags` (cached 60 s). The chosen tag is
 * only used when it exists on the host or was explicitly configured.
 */
export async function localDecomposeModel(config: {
  ollamaDecomposeModel?: string;
  ollamaCompletionModel?: string;
  ollamaCompletionHost?: string;
  ollamaHost?: string;
}): Promise<string> {
  if (config.ollamaDecomposeModel?.trim()) return config.ollamaDecomposeModel.trim();
  if (process.env.SS_LOCAL_DECOMPOSE_MODEL?.trim()) return process.env.SS_LOCAL_DECOMPOSE_MODEL.trim();
  const tags = await listOllamaTags(config);
  if (tags.includes(LOCAL_DECOMPOSE_MODEL)) return LOCAL_DECOMPOSE_MODEL;
  const small = tags.find((t) => SMALL_DECOMPOSE_TAG.test(t));
  if (small) return small;
  return config.ollamaCompletionModel || DEFAULT_MODELS.ollama;
}

/**
 * Resolve the Ollama model for the evidence outline. Preference order:
 *   1. `SS_LOCAL_OUTLINE_MODEL` (env, explicit operator choice)
 *   2. `LOCAL_ROUTING.outline.model` when that tag is present on the host
 *   3. any small instruct tag on the host (`SMALL_DECOMPOSE_TAG`)
 *   4. `localDecomposeModel(config)` — never worse than today's behaviour
 *
 * Step 2 matters only if the operator has pulled the small tag; without it we
 * land on the same model decompose uses, and the win is the input cap and the
 * 25 s ceiling rather than the model swap.
 */
export async function localOutlineModel(config: {
  ollamaDecomposeModel?: string;
  ollamaCompletionModel?: string;
  ollamaCompletionHost?: string;
  ollamaHost?: string;
}): Promise<string> {
  if (process.env.SS_LOCAL_OUTLINE_MODEL?.trim()) return process.env.SS_LOCAL_OUTLINE_MODEL.trim();
  const tags = await listOllamaTags(config);
  if (tags.includes(LOCAL_ROUTING.outline.model)) return LOCAL_ROUTING.outline.model;
  const small = tags.find((t) => SMALL_DECOMPOSE_TAG.test(t));
  if (small) return small;
  return localDecomposeModel(config);
}

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
  return (await getDefaultRoutingInfo()).routing;
}

// ---------------------------------------------------------------------------
// Cloud-first defaults for the routed profile (report item M-3)
// ---------------------------------------------------------------------------

/** Where the base routing table for the routed profile came from. */
export type DefaultsSource = 'preset:default' | 'code:cloud' | 'code:ollama-only';

export interface DefaultRoutingInfo {
  routing: Record<ResearchTier, TierSettings>;
  source: Exclude<DefaultsSource, 'preset:default'>;
  /** Human-readable caveats for `routing_explain` (empty when a cloud provider serves the report tiers). */
  notes: string[];
}

export type CloudProviderKey = Exclude<AIProviderKey, 'ollama'>;

/** Order in which a configured cloud provider is picked when the primary is not one. */
export const CLOUD_PROVIDER_ORDER: readonly CloudProviderKey[] = ['anthropic', 'openai', 'gemini', 'groq', 'grok'];

export const OLLAMA_ONLY_NOTE =
  'no cloud provider configured; report tiers fall back to Ollama with multiPass disabled';

function isCloudProviderKey(v: unknown): v is CloudProviderKey {
  return isProviderKey(v) && v !== LOCAL_PROVIDER;
}

/**
 * The cloud provider/model the `deep*` tiers default to: the primary from
 * Admin → AI Services when it is a configured cloud provider, else the first
 * configured provider in `CLOUD_PROVIDER_ORDER`, else null (Ollama-only host).
 */
async function resolveCloudProvider(
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<{ provider: CloudProviderKey; model: string } | null> {
  const primary = await resolvePrimary(config);
  if (isCloudProviderKey(primary.provider) && isProviderConfigured(primary.provider, config)) {
    return { provider: primary.provider, model: primary.model || DEFAULT_MODELS[primary.provider] };
  }
  for (const provider of CLOUD_PROVIDER_ORDER) {
    if (isProviderConfigured(provider, config)) return { provider, model: DEFAULT_MODELS[provider] };
  }
  return null;
}

/**
 * Same table as `getDefaultRouting()` plus its provenance. `fast` is always
 * Ollama. The `deep*` tiers go to a configured cloud provider whenever one
 * exists; only an Ollama-only host routes them locally, and then
 * `deep-report` runs single-pass so a local model never does nine passes.
 */
export async function getDefaultRoutingInfo(): Promise<DefaultRoutingInfo> {
  const config = await getConfig();
  const localModel = config.ollamaCompletionModel ? { model: config.ollamaCompletionModel } : {};
  const fast: TierSettings = { provider: LOCAL_PROVIDER, ...localModel };

  const cloud = await resolveCloudProvider(config);
  if (!cloud) {
    const local: TierSettings = { provider: LOCAL_PROVIDER, ...localModel };
    const notes = [OLLAMA_ONLY_NOTE];
    if (!isProviderConfigured(LOCAL_PROVIDER, config)) {
      notes.push('no Ollama host configured either; routed research will fail until a provider is set up in Admin → AI Services');
    }
    return {
      routing: {
        fast,
        deep: { ...local },
        'deep-report': { ...local, multiPass: false },
        'deep-rlm': { ...local, useRlm: true, rlmMaxRounds: 2 },
      },
      source: 'code:ollama-only',
      notes,
    };
  }

  const caps = getModelCaps(cloud.provider, cloud.model);
  const effort = caps.effort ? clampEffort('medium', caps.effort) : 'medium';
  const tier = (): TierSettings => ({
    provider: cloud.provider,
    model: cloud.model,
    effort,
    ...(caps.thinking ? { thinking: true } : {}),
  });

  return {
    routing: {
      fast,
      deep: tier(),
      'deep-report': { ...tier(), multiPass: true },
      'deep-rlm': { ...tier(), useRlm: true, rlmMaxRounds: 4 },
    },
    source: 'code:cloud',
    notes: [],
  };
}
