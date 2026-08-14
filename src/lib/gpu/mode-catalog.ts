/**
 * Mode catalog — derived view over the 4 fixed Sound Suite modes.
 *
 * Static metadata (name/label/availableOn/description) lives in
 * `MODE_METADATA`. The per-mode DEFAULT MODEL is NO LONGER a constant —
 * it is read from the Config DB at request time, populated by the existing
 * admin settings pages:
 *
 *   ss-embedding      ← embedding.ollamaModel       (/admin/embedding)
 *   ss-code-embedding ← embedding.codeOllamaModel   (/admin/embedding)
 *   ss-completion ← ai.ollamaCompletionModel    (/admin/localai)
 *   ss-ocr        ← pipeline.ocrOllamaModel     (/admin/ocr)
 *   ss-reranker   ← rerank.model                (/admin/reranking)
 *
 * The hardcoded values in `STATIC_FALLBACK_MODEL` below are LAST-RESORT
 * only — returned when neither the Config row nor the AppConfig fallback
 * has a value. They MUST stay roughly in sync with the sidecar's
 * resolveMode() (sideCar/src/lib/mode-templates.ts) so the boot-time path
 * agrees, but the master is now AUTHORITATIVE: whatever the admin settings
 * pages set is pushed to sidecars via `modelOverrides`.
 *
 * Server-only imports (Config / Prisma) are confined to `getModeCatalog()`
 * and `defaultModelForAsync()` via a lazy dynamic import, so client
 * components that only need the synchronous `MODE_CATALOG` constant still
 * work without pulling in Prisma.
 *
 * Availability map (where the mode can actually run):
 *   ss-reranker runs on linux and win32 (WSL2+NVIDIA). darwin is excluded
 *   because vllm-metal lacks cross-encoder support
 *   (see https://github.com/vllm-project/vllm-metal/issues/361). The other
 *   three modes work on linux/mac-docker-ollama/windows-docker-wsl2 via Ollama (host or container).
 */

export type ModeName =
  | 'ss-embedding'
  | 'ss-code-embedding'
  | 'ss-completion'
  | 'ss-ocr'
  | 'ss-reranker'
  | 'ss-rlm';
export type HostOs = 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2';

export const ALL_MODES: readonly ModeName[] = [
  'ss-embedding',
  'ss-code-embedding',
  'ss-completion',
  'ss-ocr',
  'ss-reranker',
  'ss-rlm',
];

export interface ModeCatalogEntry {
  name: ModeName;
  label: string;
  availableOn: HostOs[];
  defaultModel: Partial<Record<HostOs, string>>;
  description: string;
}

interface ModeMetadata {
  name: ModeName;
  label: string;
  availableOn: HostOs[];
  description: string;
}

export const MODE_METADATA: ModeMetadata[] = [
  {
    name: 'ss-embedding',
    label: 'Text embedding',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    description:
      'Document and query embedding via Ollama. Lightweight (~1.2 GB VRAM); used in both indexing and search.',
  },
  {
    name: 'ss-code-embedding',
    label: 'Code Embedding',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    description:
      'Code-aware embedding via Ollama for agent/code search. Separate from text embedding — used when searching with agents over source/code-like content. ~2 GB VRAM.',
  },
  {
    name: 'ss-completion',
    label: 'Completion',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    description: 'Chat completion via Ollama. ~10 GB VRAM; used at search time.',
  },
  {
    name: 'ss-ocr',
    label: 'OCR',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    description:
      'Visual OCR for low-density PDF pages and exhibit images. ~5 GB VRAM; used during indexing.',
  },
  {
    name: 'ss-reranker',
    label: 'Reranker (cross-encoder)',
    availableOn: ['linux', 'windows-docker-wsl2'],
    description:
      'vLLM cross-encoder reranker. Linux native or Windows Docker (WSL2) with NVIDIA GPU passthrough. Mac unsupported — vllm-metal lacks cross-encoder support (see vllm-metal#361).',
  },
  {
    name: 'ss-rlm',
    label: 'RLM (recursive reasoning)',
    // Mac excluded by default: Docker vLLM has no Metal passthrough on macOS,
    // and DMR's vllm-metal only loads MLX-format safetensors — but no MLX
    // conversion of mit-oasys/rlm-qwen3-8b-v0.1 exists on HuggingFace yet
    // (no mlx-community/rlm-* variant). An operator can unblock Mac by
    // converting the model with mlx-lm and pointing /admin/rlm's model
    // override at the local MLX path, then re-enabling Mac here.
    availableOn: ['linux', 'windows-docker-wsl2'],
    description:
      'Recursive Language Model (Qwen3-8B post-trained) for deep long-context reasoning across many documents. Served via Docker vLLM on Linux/Windows+NVIDIA. Mac is not supported out-of-the-box: vllm-metal needs an MLX conversion of the weights and none has been published. AWQ-INT4 @ 32K context fits in ~10 GB VRAM.',
  },
];

/**
 * Hardcoded LAST-RESORT defaults. Used only when Config DB is unreachable
 * (e.g. before first boot, or in pure-client fallback paths). Must stay
 * aligned with sideCar/src/lib/mode-templates.ts:resolveMode().
 */
const STATIC_FALLBACK_MODEL: Record<ModeName, string> = {
  'ss-embedding': 'qwen3-embedding:0.6b',
  // Ollama pulls GGUFs directly from HF via the hf.co/{repo}:{quant} ref.
  // The bare name "jina-code-embeddings-1.5B" is NOT a registry model and
  // 404s on pull ("file does not exist") — must be the hf.co reference.
  'ss-code-embedding': 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0',
  'ss-completion': 'qwen3.5:9b',
  'ss-ocr': 'minicpm-v:latest',
  'ss-reranker': 'Qwen/Qwen3-Reranker-8B',
  'ss-rlm': 'mit-oasys/rlm-qwen3-8b-v0.1',
};

function buildDefaultModelMap(
  m: ModeMetadata,
  model: string,
): Partial<Record<HostOs, string>> {
  const out: Partial<Record<HostOs, string>> = {};
  for (const os of m.availableOn) out[os] = model;
  return out;
}

/**
 * @deprecated For client/synchronous callers. This constant only knows the
 * STATIC_FALLBACK_MODEL — it does NOT reflect operator choices in /admin
 * settings pages. Client components should fetch `/api/admin/mode-catalog`
 * and only fall back to this on 404. Server code should use
 * `getModeCatalog()`.
 */
export const MODE_CATALOG: ModeCatalogEntry[] = MODE_METADATA.map((m) => ({
  ...m,
  defaultModel: buildDefaultModelMap(m, STATIC_FALLBACK_MODEL[m.name]),
}));

export function isModeName(s: string): s is ModeName {
  return (ALL_MODES as readonly string[]).includes(s);
}

/**
 * Maps each mode to the admin settings page that owns the default model
 * Config value. Used by /admin/roletypes and /admin/roleassign so operators
 * can click straight from a catalog row to the page where the model is set.
 *
 * Config key reference:
 *   ss-embedding  → embedding.ollamaModel           → /admin/embedding
 *   ss-completion → ai.ollamaCompletionModel        → /admin/localai
 *   ss-ocr        → pipeline.ocrOllamaModel         → /admin/ocr
 *   ss-reranker   → rerank.model                    → /admin/reranking
 */
export function settingsPageForMode(
  mode: string,
): { label: string; href: string; configKey: string } | null {
  switch (mode) {
    case 'ss-embedding':
      return { label: 'Embedding settings', href: '/admin/embedding', configKey: 'embedding.ollamaModel' };
    case 'ss-code-embedding':
      return { label: 'Embedding settings', href: '/admin/embedding', configKey: 'embedding.codeOllamaModel' };
    case 'ss-completion':
      return { label: 'AI settings', href: '/admin/localai', configKey: 'ai.ollamaCompletionModel' };
    case 'ss-ocr':
      return { label: 'OCR settings', href: '/admin/ocr', configKey: 'pipeline.ocrOllamaModel' };
    case 'ss-reranker':
      return { label: 'Reranking settings', href: '/admin/reranking', configKey: 'rerank.model' };
    case 'ss-rlm':
      return { label: 'RLM AI settings', href: '/admin/rlm', configKey: 'rlm.model' };
    default:
      return null;
  }
}

/**
 * Synchronous default-model resolver. Returns the STATIC_FALLBACK_MODEL
 * value — the hardcoded last-resort, NOT what the admin pages set. For
 * the authoritative value, use `defaultModelForAsync()`.
 *
 * Kept for client-side / synchronous callers.
 */
export function defaultModelFor(mode: ModeName, hostOs: HostOs): string | null {
  const entry = MODE_METADATA.find((m) => m.name === mode);
  if (!entry || !entry.availableOn.includes(hostOs)) return null;
  return STATIC_FALLBACK_MODEL[mode] ?? null;
}

/**
 * Pluck the operator-set model for one mode out of an already-loaded
 * AppConfig. Avoids a second DB round-trip when the caller has cfg in hand
 * (e.g. fleet-router's pushModelRegistry / pushFullConfig).
 *
 * Reads the same Config keys the admin settings pages write. Falls back
 * to STATIC_FALLBACK_MODEL when the key is unset/empty.
 */
export function resolveModelFromConfig(
  mode: ModeName,
   
  cfg: any,
): string {
  let v: string | undefined;
  switch (mode) {
    case 'ss-embedding':
      v = cfg?.ollamaModel;
      break;
    case 'ss-code-embedding':
      v = cfg?.codeOllamaModel;
      break;
    case 'ss-completion':
      v = cfg?.ollamaCompletionModel;
      break;
    case 'ss-ocr':
      v = cfg?.ocrOllamaModel;
      break;
    case 'ss-reranker':
      v = cfg?.rerankModel;
      break;
    case 'ss-rlm':
      v = cfg?.rlmModel;
      break;
  }
  if (v && typeof v === 'string' && v.trim()) return v.trim();
  return STATIC_FALLBACK_MODEL[mode];
}

// Server-only async resolvers (getModeCatalog / defaultModelForAsync) live
// in ./mode-catalog-server. They depend on Prisma and cannot be bundled
// into client components — webpack will fail with "Can't resolve 'fs'".
