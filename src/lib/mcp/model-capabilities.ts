/**
 * Which Ollama tags can serve the local profile's constrained-JSON steps
 * (decompose, evidence outline).
 *
 * Lives in its own leaf module rather than in `routing-defaults.ts` because the
 * admin UI is a client component: `routing-defaults` imports `getConfig`, which
 * imports prisma, and pulling that into the browser bundle is not acceptable.
 * `routing-defaults` re-exports these so there is still one place to look.
 *
 * The classifier FAILS OPEN. A tag we cannot confidently identify as an
 * embedding or a vision/OCR build is allowed through — hiding a usable model is
 * worse than listing a doubtful one.
 */

/** Shape we need from Ollama's `/api/tags`; everything but `id` is optional. */
export interface OllamaTagInfo {
  id: string;
  family?: string;
  families?: string[];
}

/**
 * `details.family` / `details.families` values that mean the tag carries a
 * vision or OCR tower. Ollama tags every multimodal build with a projector
 * family alongside the text family — `minicpm-v` reports `["qwen2","clip"]`,
 * `olmocr2` reports `["qwen2vl","clip"]` — so this catches them even when the
 * name gives nothing away.
 */
const VISION_FAMILIES = new Set([
  'clip',
  'gemma3vl',
  'llava',
  'mllama',
  'paddleocr',
  'qwen2vl',
  'qwen2.5vl',
  'qwen3vl',
  'siglip',
]);

/**
 * Fallback for hosts that report a generic family. Deliberately narrow: only
 * unambiguous OCR/vision markers, so a normal instruct tag is never caught.
 */
const VISION_NAME = /(^|[^a-z0-9])(ocr|vision|llava|moondream|bakllava)([^a-z0-9]|$)/i;

/** Embedding-only tags, which cannot generate at all. */
const EMBEDDING_NAME = /embed/i;

/** A vision/OCR build — real generation, but not constrained JSON over text. */
export function isVisionTag(tag: OllamaTagInfo): boolean {
  const families = [tag.family, ...(tag.families ?? [])];
  if (families.some((f) => f && VISION_FAMILIES.has(f.toLowerCase()))) return true;
  return VISION_NAME.test(tag.id);
}

/** An embedding-only tag. */
export function isEmbeddingTag(tag: OllamaTagInfo): boolean {
  return EMBEDDING_NAME.test(tag.id);
}

/**
 * Can this tag plausibly run decompose / the evidence outline? Excludes
 * embedding-only and vision/OCR builds; everything else passes.
 */
export function isTextGenerationTag(tag: OllamaTagInfo): boolean {
  return !isEmbeddingTag(tag) && !isVisionTag(tag);
}
