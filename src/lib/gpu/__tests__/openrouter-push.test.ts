/** @jest-environment node */
/**
 * `buildOpenRouterPush()` decides whether a live API key leaves this master and
 * travels to a fleet host, so its default matters more than its happy path.
 *
 * Two failure modes this guards:
 *   1. Pushing a key when the operator has not enabled the feature — the key
 *      would land in memory on every sidecar for nothing, and sidecar
 *      /api/status is unauthenticated on the LAN.
 *   2. Dropping `provider`/`dims` from an embedding entry — the sidecar uses
 *      them to pin the provider (so one vector space cannot silently split
 *      across two) and to enforce the response width (so a wrong-width vector
 *      never reaches addChunks(), which drops and recreates the table).
 */
// fleet-router transitively imports mode-catalog-server, which imports
// 'server-only' — a Next.js build-time marker with no Jest resolution. Stubbing
// it is what lets this pure function be tested without the whole server graph.
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn(), setConfigValue: jest.fn() }));
jest.mock('@/lib/gpu/ws-relay', () => ({
  hasSidecarConnection: () => false, getConnectedSidecars: () => [], sendCommand: jest.fn(),
}));
jest.mock('@/lib/gpu/command-queue', () => ({ queueSidecarCommand: jest.fn() }));

import { buildOpenRouterPush } from '../fleet-router';
import type { AppConfig } from '@/lib/db/config';

const KEY = 'sk-or-v1-synthetic-not-a-real-key';

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    openRouterEnabled: true,
    openRouterApiKey: KEY,
    openRouterEmbeddingModel: 'qwen/qwen3-embedding-4b',
    openRouterCodeEmbeddingModel: 'qwen/qwen3-embedding-4b',
    openRouterRerankModel: 'qwen/qwen3-reranker-8b',
    ...over,
  } as unknown as AppConfig;
}

describe('buildOpenRouterPush', () => {
  it('returns null when the feature is disabled — no key leaves the master', () => {
    expect(buildOpenRouterPush(cfg({ openRouterEnabled: false }))).toBeNull();
  });

  it('returns null when no key is set, even if enabled', () => {
    expect(buildOpenRouterPush(cfg({ openRouterApiKey: undefined }))).toBeNull();
    expect(buildOpenRouterPush(cfg({ openRouterApiKey: '' }))).toBeNull();
  });

  it('maps the two embedding roles separately', () => {
    // ss-embedding and ss-code-embedding are distinct roles; a push that
    // collapsed them would silently serve code search from the text model.
    const out = buildOpenRouterPush(
      cfg({
        openRouterEmbeddingModel: 'openai/text-embedding-3-small',
        openRouterCodeEmbeddingModel: 'qwen/qwen3-embedding-4b',
      }),
    )!;
    expect(out.allowedModels['embedding'].model).toBe('openai/text-embedding-3-small');
    expect(out.allowedModels['code-embedding'].model).toBe('qwen/qwen3-embedding-4b');
  });

  it('carries provider and measured dims on every embedding entry', () => {
    const out = buildOpenRouterPush(cfg())!;
    expect(out.allowedModels['code-embedding']).toEqual({
      model: 'qwen/qwen3-embedding-4b',
      provider: 'DeepInfra',
      dims: 2560,
    });
  });

  it('carries the provider pin for rerank but no dims', () => {
    const out = buildOpenRouterPush(cfg())!;
    expect(out.allowedModels['reranker'].provider).toBe('Fireworks');
    expect(out.allowedModels['reranker'].dims).toBeUndefined();
  });

  it('marks only roles that have a model, leaving the rest local-only', () => {
    const out = buildOpenRouterPush(
      cfg({ openRouterCodeEmbeddingModel: undefined, openRouterRerankModel: undefined }),
    )!;
    expect(Object.keys(out.modeByRole).sort()).toEqual(['embedding']);
    expect(out.modeByRole['embedding']).toBe('local-first');
    // An unlisted role must not appear at all — the sidecar defaults an unknown
    // role to local-only, which is the safe state.
    expect(out.allowedModels['reranker']).toBeUndefined();
  });

  it('passes the key through unchanged when enabled', () => {
    expect(buildOpenRouterPush(cfg())!.apiKey).toBe(KEY);
  });
});
