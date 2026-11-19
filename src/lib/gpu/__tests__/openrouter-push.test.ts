/** @jest-environment node */
/**
 * `buildOpenRouterPush()` decides whether a live API key leaves this master and
 * travels to a fleet host, so its default matters more than its happy path.
 *
 * Since docs/tasks/59 the push is the ss-rlm-sandbox slot only: this master
 * calls OpenRouter itself for every other role, so no embedding, rerank or
 * chat model (and no routing mode) may reach a sidecar any more.
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

  it('pushes only the sandbox slot: key, rlm-sandbox model, domain', () => {
    const out = buildOpenRouterPush(cfg({
      rlmSandboxModel: 'deepseek/deepseek-v4.1-flash',
      openRouterChatModel: 'some/chat-model',
    } as Partial<AppConfig>))!;
    expect(out).toEqual({
      apiKey: KEY,
      allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4.1-flash' } },
      domain: 'legal',
    });
    expect(out).not.toHaveProperty('modeByRole');
  });

  it('omits the sandbox model when none is set (the sidecar then reports unset)', () => {
    const out = buildOpenRouterPush(cfg({ rlmSandboxModel: '' } as Partial<AppConfig>))!;
    expect(out.allowedModels).toEqual({});
    expect(out.apiKey).toBe(KEY);
    expect(out.domain).toBe('legal');
  });
});
