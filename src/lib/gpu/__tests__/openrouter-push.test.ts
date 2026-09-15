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
    // Mode now comes from config, not a hardcoded value. cfg() leaves the mode
    // fields unset, so this is the AppConfig default.
    expect(out.modeByRole['embedding']).toBe('local-only');
    // An unlisted role must not appear at all — the sidecar defaults an unknown
    // role to local-only, which is the safe state.
    expect(out.allowedModels['reranker']).toBeUndefined();
  });

  it('passes the key through unchanged when enabled', () => {
    expect(buildOpenRouterPush(cfg())!.apiKey).toBe(KEY);
  });
});

describe('buildOpenRouterPush — ss-rlm-sandbox two-master contract', () => {
  it('always declares this master (Sound Suite) as the legal domain', () => {
    // Fantom's own master declares 'code' from its own codebase — this repo
    // cannot and must not speak for it. See docs/SPEC-ss-rlm-sandbox.md.
    expect(buildOpenRouterPush(cfg())!.domain).toBe('legal');
    // Even when nothing else is configured, as long as the feature is on.
    expect(
      buildOpenRouterPush(
        cfg({ openRouterEmbeddingModel: undefined, openRouterCodeEmbeddingModel: undefined, openRouterRerankModel: undefined }),
      )!.domain,
    ).toBe('legal');
  });

  it('maps rlm.sandboxModel to the rlm-sandbox role, separately from every other role', () => {
    const out = buildOpenRouterPush(cfg({ rlmSandboxModel: 'deepseek/deepseek-v4-flash' } as Partial<AppConfig>))!;
    expect(out.allowedModels['rlm-sandbox']).toEqual({ model: 'deepseek/deepseek-v4-flash' });
  });

  it('rlm-sandbox does not appear at all when no sandbox model is configured', () => {
    const out = buildOpenRouterPush(cfg())!;
    expect(out.allowedModels['rlm-sandbox']).toBeUndefined();
    expect(out.modeByRole['rlm-sandbox']).toBeUndefined();
  });

  it("rlm-sandbox's mode comes from virtualInference.mode.rlm, not a hardcoded value (unlike reranker)", () => {
    const out = buildOpenRouterPush(
      cfg({
        rlmSandboxModel: 'deepseek/deepseek-v4-flash',
        virtualInferenceModeRlm: 'local-first',
      } as Partial<AppConfig>),
    )!;
    expect(out.modeByRole['rlm-sandbox']).toBe('local-first');
  });

  it('rlm-sandbox mode defaults to local-only when virtualInferenceModeRlm is unset', () => {
    const out = buildOpenRouterPush(cfg({ rlmSandboxModel: 'deepseek/deepseek-v4-flash' } as Partial<AppConfig>))!;
    expect(out.modeByRole['rlm-sandbox']).toBe('local-only');
  });

  it('the sandbox model rides the same per-master channel as embedding/reranker, not a separate one', () => {
    // This is the architectural point: rlm-sandbox is just another entry in
    // allowedModels/modeByRole, the SAME per-serverUrl map that already keeps
    // Sound Suite and Fantom from clobbering each other's embedding/rerank
    // config. No new field shape, no new push path.
    const out = buildOpenRouterPush(
      cfg({
        openRouterEmbeddingModel: 'qwen/qwen3-embedding-4b',
        openRouterCodeEmbeddingModel: undefined,
        openRouterRerankModel: undefined,
        rlmSandboxModel: 'deepseek/deepseek-v4-flash',
      } as Partial<AppConfig>),
    )!;
    expect(Object.keys(out.allowedModels).sort()).toEqual(['embedding', 'rlm-sandbox']);
  });
});

describe('buildOpenRouterPush — modes come from config', () => {
  it('passes the configured mode through per role', () => {
    const out = buildOpenRouterPush(
      cfg({
        virtualInferenceModeEmbedding: 'cloud-only',
        virtualInferenceModeCodeEmbedding: 'local-first',
      } as Partial<AppConfig>),
    )!;
    expect(out.modeByRole['embedding']).toBe('cloud-only');
    expect(out.modeByRole['code-embedding']).toBe('local-first');
  });

  it('maps all-sources to local-first for the sidecar', () => {
    // all-sources is a MASTER-side fan-out; the sidecar's RoutingMode union has
    // no such member, and its observable behaviour is local-first. Pushing the
    // raw string would be an unparseable mode.
    const out = buildOpenRouterPush(
      cfg({ virtualInferenceModeEmbedding: 'all-sources' } as Partial<AppConfig>),
    )!;
    expect(out.modeByRole['embedding']).toBe('local-first');
  });

  it('always marks reranker local-first — it has no mode key of its own', () => {
    const out = buildOpenRouterPush(cfg({ virtualInferenceModeEmbedding: 'cloud-only' } as Partial<AppConfig>))!;
    expect(out.modeByRole['reranker']).toBe('local-first');
  });
});
