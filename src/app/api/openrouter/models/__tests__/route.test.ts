/**
 * @jest-environment node
 *
 * GET /api/openrouter/models — covers the `supportsTools`/`supportsReasoning`
 * derivation added for the ss-rlm-sandbox model picker (admin-openrouter.tsx
 * filters the catalogue on these two fields: a model that cannot call tools
 * cannot drive the RLM tool-use loop at all). Redis is forced unavailable so
 * the test exercises the live-fetch + trim() path, not the cache branch.
 */

const mockRequireAdminApiAccess = jest.fn();

jest.mock('@/lib/api/route-guard', () => ({
  requireAdminApiAccess: (...args: unknown[]) => mockRequireAdminApiAccess(...args),
}));
jest.mock('@/lib/redis', () => ({
  isRedisAvailable: jest.fn().mockResolvedValue(false),
  getRedis: jest.fn(),
}));

import { GET } from '../route';

function fakeRequest(): any {
  return { headers: new Headers(), nextUrl: { pathname: '/api/openrouter/models' } };
}

describe('GET /api/openrouter/models', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminApiAccess.mockResolvedValue(null);
  });

  afterEach(() => {
    (global.fetch as jest.Mock | undefined)?.mockRestore?.();
  });

  it('derives supportsTools/supportsReasoning from upstream supported_parameters', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            context_length: 1_050_000,
            pricing: { prompt: '0.000000087', completion: '0.000000174' },
            architecture: { modality: 'text', input_modalities: ['text'] },
            supported_parameters: ['tools', 'reasoning', 'temperature'],
          },
          {
            id: 'poolside/laguna-s-2.1',
            name: 'Laguna S 2.1',
            context_length: 200_000,
            pricing: { prompt: '0.000000087', completion: '0.000000174' },
            architecture: { modality: 'text', input_modalities: ['text'] },
            supported_parameters: ['temperature'], // no tools, no reasoning
          },
          {
            id: 'some/tools-only-model',
            name: 'Tools Only',
            context_length: 100_000,
            pricing: { prompt: '0.0000001', completion: '0.0000002' },
            architecture: { modality: 'text', input_modalities: ['text'] },
            supported_parameters: ['tools'], // tools but no reasoning
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await GET(fakeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));

    expect(byId['deepseek/deepseek-v4-flash']).toMatchObject({
      supportsTools: true,
      supportsReasoning: true,
    });
    expect(byId['poolside/laguna-s-2.1']).toMatchObject({
      supportsTools: false,
      supportsReasoning: false,
    });
    expect(byId['some/tools-only-model']).toMatchObject({
      supportsTools: true,
      supportsReasoning: false,
    });

    // The exact filter admin-openrouter.tsx applies for the RLM Sandbox
    // picker: BOTH tools and reasoning are required.
    const rlmCandidates = body.models.filter((m: any) => m.supportsTools && m.supportsReasoning);
    expect(rlmCandidates.map((m: any) => m.id)).toEqual(['deepseek/deepseek-v4-flash']);
  });

  it('treats a missing supported_parameters array as supporting neither', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'no/params-field',
            name: 'No Params',
            context_length: 8000,
            pricing: {},
            architecture: {},
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await GET(fakeRequest());
    const body = await res.json();

    expect(body.models[0]).toMatchObject({ supportsTools: false, supportsReasoning: false });
  });
});
