/**
 * PresetV2 schema, validation and v1 → v2 upgrade (REPORT-v2.1 Part C.1,
 * work item 7).
 *
 * `SearchPreset.settings` has been an opaque JSON blob written by the
 * dashboard (`src/components/search-interface.tsx`, `version: 1`). The MCP
 * `routed` profile needs a validated shape with a per-tier routing table, so:
 *
 * - `validatePresetShape()` — synchronous structural validation (tiers,
 *   providers, catalog models, effort levels, positive numbers).
 * - `validatePreset()`      — the above PLUS a configuration check: every
 *   provider the preset names must have an API key (config or env) or an
 *   Ollama host. This is what `preset_define` / `preset_apply` run, so an
 *   unconfigured provider fails there and never mid-report.
 * - `upgradePresetV1()`     — maps a v1 UI blob to `PresetV2`.
 * - `readPreset()`          — reads a DB row: v2 as-is (shape-validated), v1
 *   upgraded on the fly.
 *
 * The dashboard routes (`/api/search/presets`) are untouched and keep writing
 * v1 blobs; MCP writes v2. Readers upgrade transparently, so both shapes can
 * coexist in the table indefinitely.
 */

import { AI_PROVIDERS, AI_PROVIDER_KEYS, type AIProviderKey, type EffortLevel } from '../../ai/models';
import { getConfig, type AppConfig } from '../../db/config';
import { RESEARCH_TIERS, type PresetV2, type ResearchTier, type TierSettings } from '../research-types';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ValidatePresetResult =
  | { ok: true; preset: PresetV2; warnings: string[] }
  | { ok: false; errors: string[] };

const TIER_SETTING_KEYS: readonly (keyof TierSettings)[] = [
  'provider', 'model', 'effort', 'thinking', 'maxTokens', 'multiPass', 'useRlm', 'rlmMaxRounds',
];

const RETRIEVAL_KEYS = [
  'rerankPoolSize', 'limitPerSubQuery', 'rlmMaxRounds', 'maxEvidence', 'maxCharsPerChunk',
  // ms budgets for the two LLM phases (see RetrievalSettings).
  'decomposeTimeoutMs', 'outlineTimeoutMs',
] as const;

/** Top-level v1/v2 knobs that carry over verbatim when they have the right type. */
const TOP_LEVEL_BOOL = ['deep', 'rlm', 'multiPass', 'thinking', 'includeCaseScope'] as const;
const TOP_LEVEL_STRING = ['provider', 'model', 'caseId'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isProviderKey(v: unknown): v is AIProviderKey {
  return typeof v === 'string' && (AI_PROVIDER_KEYS as string[]).includes(v);
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Whether `model` is in the provider's catalog. Ollama models are free-form. */
export function isCatalogModel(provider: AIProviderKey, model: string): boolean {
  if (provider === 'ollama') return true;
  return AI_PROVIDERS[provider].models.some((m) => m.id === model);
}

// ---------------------------------------------------------------------------
// Provider configuration check (mirrors getAvailableProvider in ai-helper)
// ---------------------------------------------------------------------------

const ENV_KEYS: Record<AIProviderKey, string[]> = {
  ollama: ['OLLAMA_HOST'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  grok: ['GROK_API_KEY', 'XAI_API_KEY'],
};

/**
 * True when the provider can actually be called: an API key in config or the
 * environment, or (for Ollama) a completion / shared host.
 */
export function isProviderConfigured(provider: AIProviderKey, config: AppConfig): boolean {
  if (provider === 'ollama') {
    if (config.ollamaCompletionHost || config.ollamaHost) return true;
  } else {
    const configKey = AI_PROVIDERS[provider].configKey;
    if ((config as unknown as Record<string, unknown>)[configKey]) return true;
  }
  return ENV_KEYS[provider].some((k) => !!process.env[k]);
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function validateTierSettings(
  tier: string,
  raw: unknown,
  errors: string[],
  warnings: string[],
): TierSettings | null {
  if (!isRecord(raw)) {
    errors.push(`routing.${tier} must be an object`);
    return null;
  }
  const out: TierSettings = { provider: '' };
  let bad = false;

  if (!isProviderKey(raw.provider)) {
    errors.push(`routing.${tier}.provider must be one of ${AI_PROVIDER_KEYS.join(', ')} (got ${JSON.stringify(raw.provider)})`);
    bad = true;
  } else {
    out.provider = raw.provider;
    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || !raw.model.trim()) {
        errors.push(`routing.${tier}.model must be a non-empty string`);
        bad = true;
      } else if (!isCatalogModel(raw.provider, raw.model)) {
        errors.push(`routing.${tier}.model "${raw.model}" is not in the ${raw.provider} catalog`);
        bad = true;
      } else {
        out.model = raw.model;
      }
    }
  }

  if (raw.effort !== undefined && raw.effort !== null) {
    if (!isEffort(raw.effort)) {
      errors.push(`routing.${tier}.effort must be one of ${EFFORT_LEVELS.join(', ')}`);
      bad = true;
    } else {
      out.effort = raw.effort;
    }
  }
  for (const key of ['thinking', 'multiPass', 'useRlm'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') {
        errors.push(`routing.${tier}.${key} must be a boolean`);
        bad = true;
      } else {
        out[key] = raw[key] as boolean;
      }
    }
  }
  for (const key of ['maxTokens', 'rlmMaxRounds'] as const) {
    if (raw[key] !== undefined) {
      if (!isPositiveInt(raw[key])) {
        errors.push(`routing.${tier}.${key} must be a positive number`);
        bad = true;
      } else {
        out[key] = raw[key] as number;
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(TIER_SETTING_KEYS as string[]).includes(key)) {
      warnings.push(`routing.${tier}.${key} is not a tier setting and was dropped`);
    }
  }
  return bad ? null : out;
}

/**
 * Structural validation only — no I/O. Returns a normalised copy of the
 * preset (unknown top-level scalars preserved, unknown routing keys dropped
 * with a warning).
 */
export function validatePresetShape(input: unknown): ValidatePresetResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(input)) return { ok: false, errors: ['preset must be an object'] };
  if (input.version !== 2) errors.push(`preset.version must be 2 (got ${JSON.stringify(input.version)})`);
  if (typeof input.name !== 'string' || !input.name.trim()) errors.push('preset.name must be a non-empty string');

  const out: Record<string, unknown> = { version: 2, name: typeof input.name === 'string' ? input.name.trim() : '' };

  for (const key of TOP_LEVEL_BOOL) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') errors.push(`preset.${key} must be a boolean`);
      else out[key] = input[key];
    }
  }
  for (const key of TOP_LEVEL_STRING) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') errors.push(`preset.${key} must be a string`);
      else out[key] = input[key];
    }
  }
  if (input.provider !== undefined && typeof input.provider === 'string') {
    if (!isProviderKey(input.provider)) {
      errors.push(`preset.provider must be one of ${AI_PROVIDER_KEYS.join(', ')}`);
    } else if (typeof input.model === 'string' && input.model && !isCatalogModel(input.provider, input.model)) {
      errors.push(`preset.model "${input.model}" is not in the ${input.provider} catalog`);
    }
  }
  if (input.effort !== undefined && input.effort !== null) {
    if (!isEffort(input.effort)) errors.push(`preset.effort must be one of ${EFFORT_LEVELS.join(', ')}`);
    else out.effort = input.effort;
  }
  if (input.maxTokens !== undefined) {
    if (!isPositiveInt(input.maxTokens)) errors.push('preset.maxTokens must be a positive number');
    else out.maxTokens = input.maxTokens;
  }

  if (input.routing !== undefined) {
    if (!isRecord(input.routing)) {
      errors.push('preset.routing must be an object keyed by tier');
    } else {
      const routing: Partial<Record<ResearchTier, TierSettings>> = {};
      for (const [tier, raw] of Object.entries(input.routing)) {
        if (!(RESEARCH_TIERS as string[]).includes(tier)) {
          errors.push(`routing.${tier}: unknown tier (expected ${RESEARCH_TIERS.join(', ')})`);
          continue;
        }
        const settings = validateTierSettings(tier, raw, errors, warnings);
        if (settings) routing[tier as ResearchTier] = settings;
      }
      out.routing = routing;
    }
  }

  if (input.retrieval !== undefined) {
    if (!isRecord(input.retrieval)) {
      errors.push('preset.retrieval must be an object');
    } else {
      const retrieval: Record<string, number> = {};
      for (const [key, value] of Object.entries(input.retrieval)) {
        if (!(RETRIEVAL_KEYS as readonly string[]).includes(key)) {
          warnings.push(`retrieval.${key} is not a retrieval setting and was dropped`);
          continue;
        }
        if (!isPositiveInt(value)) errors.push(`retrieval.${key} must be a positive number`);
        else retrieval[key] = value;
      }
      out.retrieval = retrieval;
    }
  }

  // Preserve unknown scalar keys (e.g. the dashboard's `auto` / `compare`
  // flags) so a round-trip through MCP does not strip UI state.
  for (const [key, value] of Object.entries(input)) {
    if (key in out || key === 'version' || key === 'routing' || key === 'retrieval') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    else warnings.push(`preset.${key} is not a scalar and was dropped`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, preset: out as unknown as PresetV2, warnings };
}

/**
 * Full validation: shape + every named provider is configured. Async because
 * the configured-provider check reads app config.
 */
export async function validatePreset(input: unknown): Promise<ValidatePresetResult> {
  const shape = validatePresetShape(input);
  if (!shape.ok) return shape;

  const config = await getConfig();
  const errors: string[] = [];
  const check = (where: string, provider: string | undefined) => {
    if (!provider || !isProviderKey(provider)) return;
    if (!isProviderConfigured(provider, config)) {
      errors.push(
        provider === 'ollama'
          ? `${where}: provider "ollama" has no host configured (Admin → Embedding / AI Services)`
          : `${where}: provider "${provider}" is not configured — add its API key in Admin → AI Services`,
      );
    }
  };
  check('preset.provider', shape.preset.provider);
  for (const [tier, settings] of Object.entries(shape.preset.routing ?? {})) {
    check(`routing.${tier}.provider`, settings?.provider);
  }
  if (errors.length > 0) return { ok: false, errors };
  return shape;
}

// ---------------------------------------------------------------------------
// v1 → v2 upgrade
// ---------------------------------------------------------------------------

/**
 * Map a dashboard v1 blob (`search-interface.tsx` `SearchPreset.settings`) to
 * `PresetV2`. Field mapping is 1:1 for `provider`, `model`, `deep`, `rlm`,
 * `multiPass`, `thinking`, `effort`, `maxTokens`, `includeCaseScope`,
 * `caseId`. Other scalar keys (`auto`, `compare`) are preserved under the same
 * names; non-scalars (`compareSelections`) are dropped.
 *
 * A v1 preset has no routing table, so one is derived from its top-level
 * knobs for the cloud tiers (`deep`, `deep-report`, `deep-rlm`) when a
 * provider is set. `fast` is left to the default routing (Ollama). Without
 * this, a UI preset applied via MCP would contribute nothing to routing.
 */
export function upgradePresetV1(name: string, settings: unknown): PresetV2 {
  const src = isRecord(settings) ? settings : {};
  const out: Record<string, unknown> = { version: 2, name: name.trim() || 'untitled' };

  for (const key of TOP_LEVEL_BOOL) if (typeof src[key] === 'boolean') out[key] = src[key];
  for (const key of TOP_LEVEL_STRING) if (typeof src[key] === 'string' && src[key]) out[key] = src[key];
  if (isEffort(src.effort)) out.effort = src.effort;
  if (isPositiveInt(src.maxTokens)) out.maxTokens = src.maxTokens;

  for (const [key, value] of Object.entries(src)) {
    if (key in out || key === 'version') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }

  if (isProviderKey(src.provider)) {
    const base: TierSettings = { provider: src.provider };
    if (typeof src.model === 'string' && src.model && isCatalogModel(src.provider, src.model)) base.model = src.model;
    if (isEffort(src.effort)) base.effort = src.effort;
    if (typeof src.thinking === 'boolean') base.thinking = src.thinking;
    if (isPositiveInt(src.maxTokens)) base.maxTokens = src.maxTokens;
    const multiPass = typeof src.multiPass === 'boolean' ? src.multiPass : undefined;
    out.routing = {
      deep: { ...base },
      'deep-report': { ...base, multiPass: multiPass ?? true },
      'deep-rlm': { ...base, useRlm: true },
    } satisfies Partial<Record<ResearchTier, TierSettings>>;
  }

  return out as unknown as PresetV2;
}

// ---------------------------------------------------------------------------
// Row reader
// ---------------------------------------------------------------------------

export interface PresetRow {
  id: string;
  name: string;
  version?: number;
  settings: unknown;
}

/**
 * Read a `SearchPreset` row. `settings.version === 2` → shape-validated and
 * returned as-is; anything else is treated as a v1 dashboard blob and
 * upgraded. Throws on a malformed v2 blob.
 */
export function readPreset(row: PresetRow): PresetV2 {
  const settings = row.settings;
  if (isRecord(settings) && settings.version === 2) {
    const result = validatePresetShape({ ...settings, name: typeof settings.name === 'string' && settings.name ? settings.name : row.name });
    if (!result.ok) throw new Error(`preset ${row.id} is malformed: ${result.errors.join('; ')}`);
    return result.preset;
  }
  return upgradePresetV1(row.name, settings);
}
