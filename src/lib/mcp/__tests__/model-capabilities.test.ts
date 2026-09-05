/** @jest-environment node */

/**
 * Tag eligibility for the local profile's constrained-JSON steps. The fixtures
 * mirror the `details` shape Ollama's `/api/tags` actually returns (families
 * carry a projector entry for multimodal builds).
 */

import { isEmbeddingTag, isTextGenerationTag, isVisionTag } from '../model-capabilities';

describe('isTextGenerationTag', () => {
  it('keeps plain instruct models', () => {
    for (const tag of [
      { id: 'qwen3.5:9b', family: 'qwen35', families: ['qwen35'] },
      { id: 'qwen3:1.7b', family: 'qwen3', families: ['qwen3'] },
      { id: 'llama3.2:3b', family: 'llama', families: ['llama'] },
      { id: 'phi4-mini:latest', family: 'phi3', families: ['phi3'] },
    ]) {
      expect(isTextGenerationTag(tag)).toBe(true);
    }
  });

  it('drops embedding-only tags', () => {
    const tag = { id: 'qwen3-embedding:0.6b', family: 'qwen3', families: ['qwen3'] };
    expect(isEmbeddingTag(tag)).toBe(true);
    expect(isTextGenerationTag(tag)).toBe(false);
  });

  it('drops multimodal builds via the projector family, even when the name is innocent', () => {
    // Name says nothing; `clip` alongside the text family is the giveaway.
    const tag = { id: 'minicpm-v:latest', family: 'qwen2', families: ['qwen2', 'clip'] };
    expect(isVisionTag(tag)).toBe(true);
    expect(isTextGenerationTag(tag)).toBe(false);
  });

  it('drops OCR builds by family', () => {
    for (const tag of [
      { id: 'vendor/PaddleOCR-VL-1.6-0.9B:latest', family: 'paddleocr', families: ['paddleocr'] },
      { id: 'vendor/olmocr2:7b-q8', family: 'qwen2vl', families: ['qwen2vl', 'clip'] },
    ]) {
      expect(isTextGenerationTag(tag)).toBe(false);
    }
  });

  it('falls back to a narrow name check when the host reports no families', () => {
    expect(isTextGenerationTag({ id: 'vendor/some-ocr-model:7b' })).toBe(false);
    expect(isTextGenerationTag({ id: 'llava:13b' })).toBe(false);
    expect(isTextGenerationTag({ id: 'moondream:latest' })).toBe(false);
  });

  it('fails open: an unclassifiable tag stays eligible', () => {
    // No families, no known marker — better to offer it than to hide a
    // perfectly usable model.
    expect(isTextGenerationTag({ id: 'some-vendor/private-instruct:3b' })).toBe(true);
    expect(isTextGenerationTag({ id: 'mystery:latest' })).toBe(true);
    expect(isTextGenerationTag({ id: 'gemma3:4b' })).toBe(true);
  });

  it('does not mistake ordinary names for vision markers', () => {
    // Substrings that contain a marker but are not one.
    for (const id of ['vocro:7b', 'envisioned:3b', 'doctor-llm:8b']) {
      expect(isTextGenerationTag({ id })).toBe(true);
    }
  });
});
