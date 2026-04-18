/**
 * AI provider and model definitions.
 *
 * Static registry of supported LLM providers, their models, and
 * the corresponding AppConfig key that holds the API key.
 */

export type AIProviderKey = 'openai' | 'anthropic' | 'groq' | 'grok' | 'ollama';

export interface AIModelDef {
  id: string;
  label: string;
}

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
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'o3', label: 'o3 (Reasoning)' },
      { id: 'o4-mini', label: 'o4 Mini (Reasoning)' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    configKey: 'claudeApiKey',
    models: [
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    ],
  },
  groq: {
    name: 'Groq',
    configKey: 'groqApiKey',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B' },
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick 17B' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B' },
      { id: 'qwen/qwen-3-32b', label: 'Qwen 3 32B' },
    ],
  },
  grok: {
    name: 'Grok (xAI)',
    configKey: 'grokApiKey',
    models: [
      { id: 'grok-4-1-fast-reasoning', label: 'Grok 4.1 (Reasoning)' },
      { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast' },
      { id: 'grok-3', label: 'Grok 3' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini' },
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
