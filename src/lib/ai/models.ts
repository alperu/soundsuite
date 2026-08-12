/**
 * AI provider and model definitions.
 *
 * Static registry of supported LLM providers, their models, and
 * the corresponding AppConfig key that holds the API key.
 */

export type AIProviderKey = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'grok' | 'ollama';

/** UI effort levels, ascending. Not every model accepts every level. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Per-model request capabilities. Drives both the settings UI (which controls
 * to show, which values to offer) and server-side request shaping (which
 * parameter names to use, what to clamp/omit) so a stale persisted setting can
 * never 400 a request.
 */
export interface AIModelCaps {
  /** Which param carries the output budget. OpenAI reasoning models reject `max_tokens`. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Legal effort values, ascending. null = model has no effort knob. */
  effort: readonly EffortLevel[] | null;
  /** Where the effort value goes in the request body. */
  effortParam?: 'reasoning_effort' | 'output_config.effort';
  /** false = temperature must be omitted (or forced to default) or the API 400s. */
  temperature: boolean;
  /** Provider-documented max output tokens. */
  maxTokensCap: number;
  /** Whether the user-facing Thinking toggle means anything for this model. */
  thinking: boolean;
}

export interface AIModelDef {
  id: string;
  label: string;
  caps?: AIModelCaps;
}

const DEFAULT_CAPS: AIModelCaps = {
  tokenParam: 'max_tokens',
  effort: null,
  temperature: true,
  maxTokensCap: 32768,
  thinking: true,
};

/** GPT-5.6 family: reasoning models — no max_tokens, no temperature. */
const OPENAI_GPT56_CAPS: AIModelCaps = {
  tokenParam: 'max_completion_tokens',
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  effortParam: 'reasoning_effort',
  temperature: false,
  maxTokensCap: 128000,
  thinking: false,
};

/** GPT-5.5: as 5.6 but `max` effort is rejected. */
const OPENAI_GPT55_CAPS: AIModelCaps = {
  ...OPENAI_GPT56_CAPS,
  effort: ['low', 'medium', 'high', 'xhigh'],
};

/** Anthropic adaptive-thinking surface (Fable 5 / Opus 5 / Sonnet 5 / Opus 4.8):
 *  temperature removed (forced to 1 in the anthropic branch), adaptive thinking
 *  with output_config.effort. */
const ANTHROPIC_ADAPTIVE_CAPS: AIModelCaps = {
  tokenParam: 'max_tokens',
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  effortParam: 'output_config.effort',
  temperature: false,
  maxTokensCap: 64000,
  thinking: true,
};

const ANTHROPIC_CLASSIC_CAPS: AIModelCaps = {
  tokenParam: 'max_tokens',
  effort: null,
  temperature: true,
  maxTokensCap: 64000,
  thinking: true,
};

/** Gemini 3.x via the OpenAI-compat endpoint: Google documents temperature/
 *  top_p/top_k as "remove from all requests" for 3.x — they don't 400, they
 *  silently degrade reasoning. reasoning_effort is accepted natively on the
 *  compat surface; thinking_level's `minimal` has no UI EffortLevel member. */
const GEMINI_3X_CAPS: AIModelCaps = {
  tokenParam: 'max_tokens',
  effort: ['low', 'medium', 'high'],
  effortParam: 'reasoning_effort',
  temperature: false,
  maxTokensCap: 65536,
  thinking: false,
};

export interface AIProviderDef {
  name: string;
  /** Key in AppConfig that stores the API key for this provider */
  configKey: string;
  models: AIModelDef[];
}

export const AI_PROVIDERS: Record<AIProviderKey, AIProviderDef> = {
  openai: {
    name: 'OpenAI',
    configKey: 'openaiApiKey',
    // Catalog policy: latest two generations. GPT-5.6 replaced flagship/mini/
    // nano naming with Sol/Terra/Luna; GPT-5.5 has no mini variant. The
    // previous entries (gpt-5, gpt-5-mini, o3, o4-mini) shut down in late 2026.
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', caps: OPENAI_GPT56_CAPS },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', caps: OPENAI_GPT56_CAPS },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', caps: OPENAI_GPT56_CAPS },
      { id: 'gpt-5.5', label: 'GPT-5.5', caps: OPENAI_GPT55_CAPS },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    configKey: 'claudeApiKey',
    // Catalog policy: latest two generations per family only.
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', caps: ANTHROPIC_ADAPTIVE_CAPS },
      { id: 'claude-opus-5', label: 'Claude Opus 5', caps: ANTHROPIC_ADAPTIVE_CAPS },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', caps: ANTHROPIC_ADAPTIVE_CAPS },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', caps: ANTHROPIC_ADAPTIVE_CAPS },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', caps: ANTHROPIC_CLASSIC_CAPS },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', caps: ANTHROPIC_CLASSIC_CAPS },
    ],
  },
  gemini: {
    name: 'Google Gemini',
    configKey: 'geminiApiKey',
    // Latest two generations per family. Pro: gemini-3-pro-preview was shut
    // down and there is no stable Gemini 3 Pro, so the second Pro is 2.5.
    // Preview ids can retire without a deprecation window — hence the label.
    models: [
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', caps: GEMINI_3X_CAPS },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', caps: GEMINI_3X_CAPS },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', caps: GEMINI_3X_CAPS },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', caps: { ...GEMINI_3X_CAPS, temperature: true } },
    ],
  },
  groq: {
    name: 'Groq',
    configKey: 'groqApiKey',
    // Current production text models; the previous DeepSeek/Llama-4/Qwen
    // entries are on Groq's deprecations page.
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', caps: { ...DEFAULT_CAPS, thinking: false, maxTokensCap: 32768 } },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', caps: { ...DEFAULT_CAPS, thinking: false, maxTokensCap: 131072 } },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', caps: { ...DEFAULT_CAPS, thinking: false, maxTokensCap: 65536 } },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', caps: { ...DEFAULT_CAPS, thinking: false, maxTokensCap: 65536 } },
    ],
  },
  grok: {
    name: 'Grok (xAI)',
    configKey: 'grokApiKey',
    // xAI switched to dotted ids (grok-4.5); the previous 4-1/3 entries are
    // gone from the pricing table entirely.
    models: [
      {
        id: 'grok-4.5',
        label: 'Grok 4.5',
        caps: {
          tokenParam: 'max_tokens',
          // Documented: low | medium | high only (default high) — xhigh/max 400.
          effort: ['low', 'medium', 'high'],
          effortParam: 'reasoning_effort',
          temperature: true,
          maxTokensCap: 32768,
          thinking: false,
        },
      },
      // Effort support undocumented for 4.3 — treat as no effort knob.
      { id: 'grok-4.3', label: 'Grok 4.3', caps: { ...DEFAULT_CAPS, thinking: false } },
    ],
  },
  ollama: {
    name: 'Ollama (Local)',
    configKey: 'ollamaHost', // Uses host URL instead of API key
    models: [
      { id: 'llama3.3:70b', label: 'Llama 3.3 70B (48GB VRAM)' },
      { id: 'llama3.1:70b', label: 'Llama 3.1 70B (48GB VRAM)' },
      { id: 'qwen2.5:72b', label: 'Qwen 2.5 72B (48GB VRAM)' },
      { id: 'qwen3.5:14b', label: 'Qwen 3.5 14B (12GB VRAM)' },
      { id: 'qwen3.5:9b', label: 'Qwen 3.5 9B (8GB VRAM)' },
      { id: 'qwen2.5:14b', label: 'Qwen 2.5 14B (12GB VRAM)' },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B (8GB VRAM)' },
      { id: 'deepseek-r1:70b', label: 'DeepSeek R1 70B (48GB VRAM)' },
      { id: 'mistral:7b', label: 'Mistral 7B (8GB VRAM)' },
    ],
  },
};

/** All provider keys as array. */
export const AI_PROVIDER_KEYS = Object.keys(AI_PROVIDERS) as AIProviderKey[];

/** Capabilities for a model, falling back to permissive defaults for models
 *  outside the catalog (e.g. user-typed Ollama models). */
export function getModelCaps(provider: AIProviderKey, model: string | undefined): AIModelCaps {
  if (!model) return DEFAULT_CAPS;
  const def = AI_PROVIDERS[provider]?.models.find((m) => m.id === model);
  return def?.caps ?? DEFAULT_CAPS;
}

/** Clamp an effort value to a model's supported list: nearest supported level
 *  at or below the request (a user who asked for `max` on a model that tops
 *  out at `xhigh` gets `xhigh`, not the default), else the lowest above. */
export function clampEffort(effort: EffortLevel, allowed: readonly EffortLevel[]): EffortLevel {
  if (allowed.includes(effort)) return effort;
  const idx = EFFORT_ORDER.indexOf(effort);
  for (let i = idx - 1; i >= 0; i--) {
    if (allowed.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  for (let i = idx + 1; i < EFFORT_ORDER.length; i++) {
    if (allowed.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  return effort;
}

/**
 * Request-body params for the OpenAI-compatible providers (openai/groq/grok),
 * shaped to what the model actually accepts. Single choke point used by both
 * the streaming and buffered builders, so a stale persisted setting can never
 * 400 a request:
 * - budget goes under caps.tokenParam, clamped to caps.maxTokensCap
 * - temperature omitted when the model rejects it (OpenAI reasoning models)
 * - effort clamped to the supported list, sent only as top-level
 *   reasoning_effort (the Anthropic branch does its own shaping)
 */
export function shapeOpenAICompatParams(
  provider: AIProviderKey,
  model: string,
  opts: { maxTokens: number; temperature: number; effort?: EffortLevel },
): Record<string, unknown> {
  const caps = getModelCaps(provider, model);
  return {
    [caps.tokenParam]: Math.min(opts.maxTokens, caps.maxTokensCap),
    ...(caps.temperature ? { temperature: opts.temperature } : {}),
    ...(caps.effort && caps.effortParam === 'reasoning_effort' && opts.effort
      ? { reasoning_effort: clampEffort(opts.effort, caps.effort) }
      : {}),
  };
}

/**
 * Anthropic models on the adaptive-thinking request surface: `temperature`
 * removed (any value 400s — callers force 1), `thinking: {type:'adaptive'}`
 * only, and `output_config.effort` supported. Single source of truth for the
 * Effort selector visibility (search toolbar + draft panel) and the request
 * shaping in ai-provider.ts / deep-search.ts.
 */
export function supportsAdaptiveEffort(model: string | undefined): boolean {
  if (!model) return false;
  return model.startsWith('claude-fable-5')
    || model.startsWith('claude-opus-5')
    || model.startsWith('claude-sonnet-5')
    || model.startsWith('claude-opus-4-7')
    || model.startsWith('claude-opus-4-8');
}
