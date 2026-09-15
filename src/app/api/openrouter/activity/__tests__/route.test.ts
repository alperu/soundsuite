/**
 * @jest-environment node
 *
 * `GET /api/openrouter/activity` just fans `getActivity()` out over the four
 * roles the admin panel shows — the interesting behavior (call attribution,
 * fleet-vs-direct split) is covered where it actually happens
 * (`src/lib/openrouter/__tests__/client.test.ts`,
 * `src/lib/gpu/__tests__/virtual-embed-dispatch.test.ts`). This test only
 * checks the route composes that correctly and gates access.
 *
 * `@/lib/openrouter/client` is mocked to avoid the real module's
 * `@/lib/db/config` → `@/lib/db/prisma` chain (eager PrismaClient
 * construction at import time — see the mock note in
 * virtual-embed-dispatch.test.ts for the same reason).
 */

const mockGetActivity = jest.fn();
const mockRequireAdminApiAccess = jest.fn();

jest.mock('@/lib/openrouter/client', () => ({
  getActivity: (role: string) => mockGetActivity(role),
}));
jest.mock('@/lib/api/route-guard', () => ({
  requireAdminApiAccess: (...args: unknown[]) => mockRequireAdminApiAccess(...args),
}));

import { GET } from '../route';

function fakeRequest(): any {
  return { headers: new Headers(), nextUrl: { pathname: '/api/openrouter/activity' } };
}

describe('GET /api/openrouter/activity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminApiAccess.mockResolvedValue(null);
    mockGetActivity.mockImplementation((role: string) => ({
      role,
      inFlight: 0,
      callsToday: 0,
      tokensToday: 0,
      spendTodayUsd: 0,
      lastCall: null,
      callsByServedBy: {},
    }));
  });

  it('returns activity for embedding, code-embedding, completion and reranker', async () => {
    const res = await GET(fakeRequest());
    const body = await res.json();

    expect(Object.keys(body.byRole).sort()).toEqual(['code-embedding', 'completion', 'embedding', 'reranker']);
    expect(mockGetActivity).toHaveBeenCalledWith('embedding');
    expect(mockGetActivity).toHaveBeenCalledWith('code-embedding');
    expect(mockGetActivity).toHaveBeenCalledWith('completion');
    expect(mockGetActivity).toHaveBeenCalledWith('reranker');
  });

  it('passes through the role-guard refusal without calling getActivity', async () => {
    const NextResponse = require('next/server').NextResponse;
    const denial = NextResponse.json({ error: 'nope', code: 'DENIED' }, { status: 401 });
    mockRequireAdminApiAccess.mockResolvedValue(denial);

    const res = await GET(fakeRequest());

    expect(res.status).toBe(401);
    expect(mockGetActivity).not.toHaveBeenCalled();
  });
});
