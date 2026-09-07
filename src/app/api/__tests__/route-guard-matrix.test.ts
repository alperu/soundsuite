/**
 * End-to-end guard matrix for the routes v6 measured as open from a forged
 * non-loopback origin: an `/api/admin/*` route, and `POST /api/search/deep`
 * (which reads case documents and calls an LLM).
 *
 * Loopback must stay permissive — the dashboard has no credential — while a
 * remote caller needs either an MCP API key or, on admin routes, a live
 * dashboard session.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

const getSessionUser = jest.fn(async () => null as unknown as { username: string; role: string } | null);
jest.mock('@/lib/admin/auth', () => ({ getSessionUser: (t: string) => getSessionUser() }));

const caseFindMany = jest.fn(async () => [] as unknown[]);
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    config: { findUnique: jest.fn(async () => null) },
    case: { count: jest.fn(async () => 0), findMany: (...a: unknown[]) => caseFindMany() },
    document: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
    jobLog: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
    actionLog: { count: jest.fn(async () => 0) },
  },
}));
jest.mock('@/lib/services-manager', () => ({
  getServicesManager: () => ({ getHealth: async () => ({}), getStatus: async () => ({}) }),
}));
jest.mock('@/lib/redis', () => ({ isRedisAvailable: async () => false, getRedis: () => null }));
jest.mock('@/lib/gpu/fleet-router', () => ({
  getFleetStatus: jest.fn(async () => ({ sidecars: [] })),
  addSidecar: jest.fn(), removeSidecar: jest.fn(), updateSidecarNote: jest.fn(),
  testSidecar: jest.fn(), controlContainer: jest.fn(), pushIdleTimeouts: jest.fn(),
  pushModelRegistry: jest.fn(), getSidecarGpus: jest.fn(), switchSidecarMode: jest.fn(),
  restartRerankerOnAssignedSidecars: jest.fn(), sendToSidecar: jest.fn(),
}));
jest.mock('@/lib/gpu/status-cache', () => ({ getAggregatedPeakDemand: () => ({}) }));
jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn(async () => ({})),
  setConfigValue: jest.fn(),
  getAllSidecarIdleTimeouts: jest.fn(async () => ({})),
  setSidecarIdleTimeouts: jest.fn(),
  clearSidecarIdleTimeouts: jest.fn(),
}));

// deep-search dependencies — the guard must refuse before any of these run.
const deepSearch = jest.fn(async () => ({ answer: 'x', citations: [] }));
jest.mock('@/lib/search/deep-search', () => ({ deepSearch: (...a: unknown[]) => deepSearch() }));
jest.mock('@/lib/mcp/get-tool-registry', () => ({ getToolRegistry: jest.fn(async () => ({})) }));
jest.mock('@/lib/search/chunk-provenance', () => ({ pickProvenance: jest.fn(() => null) }));

import { GET as systemInfoGET } from '@/app/api/admin/system-info/route';
import { GET as casesGET, POST as casesPOST } from '@/app/api/cases/route';
import { GET as gpuFleetGET, POST as gpuFleetPOST } from '@/app/api/admin/gpu-fleet/route';
import { POST as deepPOST } from '@/app/api/search/deep/route';
import { resetMcpApiKeyCache } from '@/lib/mcp/execute-auth';

const REMOTE = { 'x-forwarded-for': '203.0.113.7' };

function request(url: string, init: RequestInit & { cookie?: string } = {}): NextRequest {
  const r = new NextRequest(new Request(url, init));
  if (init.cookie) r.cookies.set('ss_admin_session', init.cookie);
  return r;
}

beforeEach(() => {
  resetMcpApiKeyCache();
  getSessionUser.mockReset();
  getSessionUser.mockResolvedValue(null);
  deepSearch.mockClear();
  delete process.env.MCP_AUTH_MODE;
  delete process.env.MCP_API_KEYS;
  delete process.env.MCP_API_KEY;
  delete process.env.MCP_AUTH_STRICT_LOOPBACK;
});

describe('GET /api/admin/system-info', () => {
  const URL_ = 'http://127.0.0.1:3000/api/admin/system-info';

  it('answers on loopback with no session', async () => {
    const res = await systemInfoGET(request(URL_));
    expect(res.status).not.toBe(401);
  });

  it('refuses a forged remote origin with no session and no key', async () => {
    const res = await systemInfoGET(request(URL_, { headers: REMOTE }));
    expect(res.status).toBe(401);
    // String `error`, so the admin panels' `body.error` rendering still works.
    expect(typeof (await res.json()).error).toBe('string');
  });

  it('accepts a remote caller holding a live dashboard session', async () => {
    getSessionUser.mockResolvedValue({ username: 'op', role: 'admin' });
    const res = await systemInfoGET(request(URL_, { headers: REMOTE, cookie: 'a'.repeat(64) }));
    expect(res.status).not.toBe(401);
  });

  it('accepts a remote caller holding a configured MCP API key', async () => {
    process.env.MCP_API_KEYS = 'synthetic-key-aaaa';
    resetMcpApiKeyCache();
    const res = await systemInfoGET(
      request(URL_, { headers: { ...REMOTE, 'x-api-key': 'synthetic-key-aaaa' } }),
    );
    expect(res.status).not.toBe(401);
  });
});

describe('GET /api/admin/gpu-fleet stays open — sidecar master discovery', () => {
  // Regression guard. `sideCar/src/lib/config.ts:386` probes this route with
  // NO credential (only a User-Agent). With the shipped `.env` a cross-host
  // sidecar classifies as `remote`, so gating this handler detaches every GPU
  // host. Do not "fix" this test by gating the route.
  it('answers a credential-less request from a remote peer', async () => {
    const res = await gpuFleetGET(
      request('http://127.0.0.1:3000/api/admin/gpu-fleet', {
        headers: { ...REMOTE, 'user-agent': 'sound-suite-sidecar-discovery/1' },
      }),
    );
    expect(res.status).not.toBe(401);
  });

  it('but the mutating half is gated — the sidecar never POSTs here', async () => {
    const res = await gpuFleetPOST(
      request('http://127.0.0.1:3000/api/admin/gpu-fleet', {
        method: 'POST',
        headers: REMOTE,
        body: JSON.stringify({ action: 'noop' }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cases — the case inventory', () => {
  const URL_ = 'http://127.0.0.1:3000/api/cases';

  it('answers on loopback (case-management / case-explorer pages)', async () => {
    const res = await casesGET(request(URL_));
    expect(res.status).not.toBe(401);
  });

  it('refuses a forged remote origin, without touching the Case table', async () => {
    caseFindMany.mockClear();
    const res = await casesGET(request(URL_, { headers: REMOTE }));
    expect(res.status).toBe(401);
    expect(caseFindMany).not.toHaveBeenCalled();
  });

  it('accepts a remote caller holding a configured MCP API key', async () => {
    process.env.MCP_API_KEYS = 'synthetic-key-aaaa';
    resetMcpApiKeyCache();
    const res = await casesGET(
      request(URL_, { headers: { ...REMOTE, 'x-api-key': 'synthetic-key-aaaa' } }),
    );
    expect(res.status).not.toBe(401);
  });

  it('gates the write too — POST refuses a forged remote origin', async () => {
    const res = await casesPOST(
      request(URL_, {
        method: 'POST',
        headers: REMOTE,
        body: JSON.stringify({ folderPath: '/tmp/synthetic-case' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('POST still works on loopback (the "add case" UX)', async () => {
    const res = await casesPOST(
      request(URL_, { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400); // "folderPath is required" — past the guard
  });
});

describe('POST /api/search/deep', () => {
  const URL_ = 'http://127.0.0.1:3000/api/search/deep';
  const body = JSON.stringify({ query: 'q', provider: 'ollama', model: 'x' });

  it('refuses a forged remote origin with a JSON 401, before opening the stream', async () => {
    const res = await deepPOST(request(URL_, { method: 'POST', headers: REMOTE, body }));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(deepSearch).not.toHaveBeenCalled();
  });

  it('accepts a remote caller holding a live dashboard session (tunnel deployments)', async () => {
    getSessionUser.mockResolvedValue({ username: 'op', role: 'admin' });
    const res = await deepPOST(
      request(URL_, { method: 'POST', headers: REMOTE, body, cookie: 'a'.repeat(64) }),
    );
    expect(res.status).not.toBe(401);
  });

  it('lets loopback through to validation (the dashboard path)', async () => {
    const res = await deepPOST(request(URL_, { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400); // "Query is required" — past the guard
  });

  it('refuses loopback for the routed profile under MCP_AUTH_STRICT_LOOPBACK=routed', async () => {
    process.env.MCP_AUTH_STRICT_LOOPBACK = 'routed';
    const res = await deepPOST(request(URL_, { method: 'POST', body }));
    expect(res.status).toBe(401);
  });
});
