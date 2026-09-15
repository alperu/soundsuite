/**
 * OpenRouter model catalogue — curated, because it cannot be discovered.
 *
 * `GET /api/v1/models` returns 445+ CHAT models and **zero** embedding or rerank
 * models; `?category=embedding` and `?category=rerank` both 400. So the
 * embedding and rerank entries below are hand-maintained.
 *
 * They are NOT guesswork: every entry was probed live on 2026-09-15 and carries
 * its MEASURED dimension. Availability was confirmed through
 * `GET /api/v1/models/{id}/endpoints`, which needs no API key and reports the
 * providers actually serving a model — see `validateModel()` in ./client.
 *
 * Models deliberately NOT listed, because they have zero providers and return
 * 404 "No endpoints found":
 *   - qwen/qwen3-embedding-0.6b
 *   - qwen/qwen3-reranker-4b
 *   - qwen/qwen3-reranker-0.6b
 * Do not add them back without re-probing; a listed-but-unserved model is a
 * runtime 404 on the data path.
 */

export interface OpenRouterEmbeddingModel {
  id: string;
  label: string;
  /** MEASURED output dimension. A wrong value here can destroy a LanceDB table
   *  — see assertDimensionCompatible() in ./client. */
  dims: number;
  contextTokens: number;
  /** USD per million tokens. */
  pricePerMTokens: number;
  /** The provider observed serving this model. Embedding calls PIN to it:
   *  two providers serving one model do not guarantee identical vectors, and a
   *  silent reroute would split one logical vector space in two. */
  pinProvider: string;
  /** Local counterpart, where one exists — same dims, so spaces line up. */
  localEquivalent?: string;
}

export interface OpenRouterRerankModel {
  id: string;
  label: string;
  contextTokens: number;
  pricePerMTokens: number;
  pinProvider: string;
  localEquivalent?: string;
}

export interface OpenRouterChatModel {
  id: string;
  label: string;
  contextTokens: number;
  priceInPerM: number;
  priceOutPerM: number;
  /** Suited to long-context search/synthesis work. */
  goodForSearch?: boolean;
  vision?: boolean;
}

/** Verified 2026-09-15: all return 200 with the stated dimension. */
export const OPENROUTER_EMBEDDING_MODELS: OpenRouterEmbeddingModel[] = [
  {
    id: 'qwen/qwen3-embedding-4b',
    label: 'Qwen3 Embedding 4B',
    dims: 2560,
    contextTokens: 32_768,
    pricePerMTokens: 0.02,
    pinProvider: 'DeepInfra',
    localEquivalent: 'qwen3-embedding:4b',
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    label: 'Qwen3 Embedding 8B',
    dims: 4096,
    contextTokens: 32_768,
    pricePerMTokens: 0.01,
    pinProvider: 'DeepInfra',
    localEquivalent: 'qwen3-embedding:8b',
  },
  {
    id: 'openai/text-embedding-3-small',
    label: 'OpenAI text-embedding-3-small',
    dims: 1536,
    contextTokens: 8_191,
    pricePerMTokens: 0.02,
    pinProvider: 'OpenAI',
  },
  {
    id: 'openai/text-embedding-3-large',
    label: 'OpenAI text-embedding-3-large',
    dims: 3072,
    contextTokens: 8_191,
    pricePerMTokens: 0.13,
    pinProvider: 'OpenAI',
  },
  {
    id: 'google/gemini-embedding-001',
    label: 'Google Gemini Embedding 001',
    dims: 3072,
    contextTokens: 2_048,
    pricePerMTokens: 0.15,
    pinProvider: 'Google',
  },
];

/**
 * 8B is the ONLY reranker size with a provider. The 4B and 0.6B variants are
 * listed on OpenRouter but served by nobody.
 *
 * Note the context budget: 40,960 tokens, far above the local vLLM reranker's
 * `--max-model-len 8192`. The per-provider budget matters — reusing the local
 * 8192 here truncates documents for no reason.
 */
export const OPENROUTER_RERANK_MODELS: OpenRouterRerankModel[] = [
  {
    id: 'qwen/qwen3-reranker-8b',
    label: 'Qwen3 Reranker 8B',
    contextTokens: 40_960,
    pricePerMTokens: 0.2,
    pinProvider: 'Fireworks',
    localEquivalent: 'Qwen/Qwen3-Reranker-8B',
  },
];

/**
 * Chat models for search / completion / RLM substitution. These ARE in the live
 * catalogue, so `/admin/openrouter` browses the full 445; this list is only the
 * curated shortlist surfaced as sensible defaults.
 */
export const OPENROUTER_CHAT_MODELS: OpenRouterChatModel[] = [
  // DeepSeek — v4-flash is the price/context standout: 1.3M context at $0.04/M.
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    contextTokens: 1_048_576,
    priceInPerM: 0.089,
    priceOutPerM: 0.177,
    goodForSearch: true,
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash (07-31)',
    contextTokens: 1_310_720,
    priceInPerM: 0.06,
    priceOutPerM: 0.12,
    goodForSearch: true,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    contextTokens: 1_048_576,
    priceInPerM: 0.3,
    priceOutPerM: 1.2,
    goodForSearch: true,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextTokens: 1_048_576,
    priceInPerM: 1.6,
    priceOutPerM: 3.2,
    goodForSearch: true,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    label: 'DeepSeek V3.2',
    contextTokens: 163_840,
    priceInPerM: 0.269,
    priceOutPerM: 0.4,
  },
  {
    id: 'deepseek/deepseek-r1-0528',
    label: 'DeepSeek R1 (05-28)',
    contextTokens: 163_840,
    priceInPerM: 0.5,
    priceOutPerM: 2.15,
  },
  // Kimi — the largest context available, for whole-record search.
  {
    id: 'moonshotai/kimi-k3',
    label: 'MoonshotAI Kimi K3',
    contextTokens: 1_048_576,
    priceInPerM: 2.648,
    priceOutPerM: 13.283,
    goodForSearch: true,
    vision: true,
  },
  // Qwen — matches the local completion role, so behaviour is comparable.
  {
    id: 'qwen/qwen3.5-9b',
    label: 'Qwen3.5 9B',
    contextTokens: 262_144,
    priceInPerM: 0.1,
    priceOutPerM: 0.15,
    vision: true,
  },
  {
    id: 'qwen/qwen3-vl-8b-instruct',
    label: 'Qwen3 VL 8B Instruct',
    contextTokens: 262_144,
    priceInPerM: 0.117,
    priceOutPerM: 0.455,
    vision: true,
  },
];

export function findEmbeddingModel(id: string): OpenRouterEmbeddingModel | undefined {
  return OPENROUTER_EMBEDDING_MODELS.find((m) => m.id === id);
}

export function findRerankModel(id: string): OpenRouterRerankModel | undefined {
  return OPENROUTER_RERANK_MODELS.find((m) => m.id === id);
}

export function findChatModel(id: string): OpenRouterChatModel | undefined {
  return OPENROUTER_CHAT_MODELS.find((m) => m.id === id);
}

/** Every curated id, for the CI availability probe. */
export function allCuratedModelIds(): string[] {
  return [
    ...OPENROUTER_EMBEDDING_MODELS.map((m) => m.id),
    ...OPENROUTER_RERANK_MODELS.map((m) => m.id),
    ...OPENROUTER_CHAT_MODELS.map((m) => m.id),
  ];
}
