/** @jest-environment node */
/**
 * The load/unload endpoint choice hangs off this predicate. An embedding-only
 * GGUF rejects `/api/generate` with a 400, which on the unload path meant
 * `keep_alive: 0` never landed and the model stayed in VRAM while the idle
 * timer reported success (Mac mini holding three models, 2026-09-15).
 */
import { isEmbeddingRole } from '@/lib/ollama-api';
import { state } from '@/lib/state';

describe('isEmbeddingRole', () => {
  it('matches the registry roles that serve embeddings', () => {
    expect(isEmbeddingRole('embedding')).toBe(true);
    expect(isEmbeddingRole('code-embedding')).toBe(true);
  });

  it('does not match completion-style roles', () => {
    expect(isEmbeddingRole('completion')).toBe(false);
    expect(isEmbeddingRole('ocr')).toBe(false);
    expect(isEmbeddingRole('reranker')).toBe(false);
    expect(isEmbeddingRole('rlm')).toBe(false);
    expect(isEmbeddingRole('cuda')).toBe(false);
  });

  it('treats a missing role as non-embedding', () => {
    expect(isEmbeddingRole(undefined)).toBe(false);
    expect(isEmbeddingRole('')).toBe(false);
  });

  it('classifies every ollama role in the shipped registry', () => {
    // Guards against a future role whose name does not carry "embedding" but
    // whose model only embeds — it would silently get the generate-first order.
    const ollamaRoles = Object.entries(state.registry)
      .filter(([, def]) => def.type === 'ollama')
      .map(([role]) => role);
    expect(ollamaRoles).toContain('embedding');
    expect(ollamaRoles).toContain('code-embedding');
    expect(ollamaRoles.filter(isEmbeddingRole).sort()).toEqual(['code-embedding', 'embedding']);
  });
});
