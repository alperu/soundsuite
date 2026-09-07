/**
 * `guardApiRoute` — the route-agnostic guard that took over from
 * `guardMcpRoute` (v6 item 2), plus the admin-session escape hatch.
 *
 * The matrix that matters:
 *
 * | origin   | session | key presented | result |
 * |----------|---------|---------------|--------|
 * | loopback | –       | –             | allow (dashboard, bridge) |
 * | remote   | –       | –             | 401 — what v6 measured as 200 |
 * | remote   | valid   | –             | allow (admin routes only) |
 * | remote   | valid   | –             | 401 when the route opts out of sessions |
 * | remote   | revoked | –             | 401 |
 * | remote   | –       | valid         | allow |
 *
 * @jest-environment node
 */

const getSessionUser = jest.fn();
jest.mock('@/lib/admin/auth', () => ({ getSessionUser: (t: string) => getSessionUser(t) }));
jest.mock('@/lib/db/prisma', () => ({
  prisma: { config: { findUnique: jest.fn(async () => null) } },
}));

import { guardApiRoute, guardMcpRoute, resetMcpApiKeyCache } from '../execute-auth';

type Headers = Record<string, string>;

function req(opts: { headers?: Headers; cookie?: string; hostname?: string } = {}) {
  const headers = opts.headers ?? {};
  return {
    nextUrl: { hostname: opts.hostname ?? '127.0.0.1' },
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    cookies: {
      get: (n: string) =>
        n === 'ss_admin_session' && opts.cookie ? { value: opts.cookie } : undefined,
    },
  };
}

const REMOTE: Headers = { 'x-forwarded-for': '203.0.113.7' };

beforeEach(() => {
  resetMcpApiKeyCache();
  getSessionUser.mockReset();
  getSessionUser.mockResolvedValue(null);
  delete process.env.MCP_AUTH_MODE;
  delete process.env.MCP_API_KEYS;
  delete process.env.MCP_API_KEY;
  delete process.env.MCP_AUTH_STRICT_LOOPBACK;
  delete process.env.MCP_TRUST_PROXY;
});

describe('guardApiRoute — origin', () => {
  it('allows loopback with no credential', async () => {
    const r = await guardApiRoute(req(), { label: 'test' });
    expect(r).toMatchObject({ ok: true, origin: 'loopback', via: 'origin' });
  });

  it('refuses a forged non-loopback origin with no credential', async () => {
    const r = await guardApiRoute(req({ headers: REMOTE }), { label: 'test' });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 401, code: 'AUTH_REQUIRED', origin: 'remote' });
  });

  it('allows a remote caller presenting a configured key', async () => {
    process.env.MCP_API_KEYS = 'synthetic-key-aaaa';
    resetMcpApiKeyCache();
    const r = await guardApiRoute(
      req({ headers: { ...REMOTE, authorization: 'Bearer synthetic-key-aaaa' } }),
      { label: 'test' },
    );
    expect(r).toMatchObject({ ok: true, via: 'origin' });
  });

  it('refuses a remote caller presenting a wrong key', async () => {
    process.env.MCP_API_KEYS = 'synthetic-key-aaaa';
    resetMcpApiKeyCache();
    const r = await guardApiRoute(req({ headers: { ...REMOTE, 'x-api-key': 'nope' } }), {
      label: 'test',
    });
    expect(r).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
  });
});

describe('guardApiRoute — admin session', () => {
  it('accepts a live dashboard session from a remote origin', async () => {
    getSessionUser.mockResolvedValue({ username: 'op', role: 'admin' });
    const r = await guardApiRoute(req({ headers: REMOTE, cookie: 'a'.repeat(64) }), {
      label: 'test',
      allowAdminSession: true,
    });
    expect(r).toMatchObject({ ok: true, via: 'admin-session', username: 'op' });
  });

  it('ignores the session when the route did not opt in', async () => {
    getSessionUser.mockResolvedValue({ username: 'op', role: 'admin' });
    const r = await guardApiRoute(req({ headers: REMOTE, cookie: 'a'.repeat(64) }), {
      label: 'test',
    });
    expect(r.ok).toBe(false);
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it('refuses a revoked / unknown session token', async () => {
    getSessionUser.mockResolvedValue(null);
    const r = await guardApiRoute(req({ headers: REMOTE, cookie: 'a'.repeat(64) }), {
      label: 'test',
      allowAdminSession: true,
    });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a viewer when the route requires the admin role', async () => {
    getSessionUser.mockResolvedValue({ username: 'watcher', role: 'viewer' });
    const r = await guardApiRoute(req({ headers: REMOTE, cookie: 'a'.repeat(64) }), {
      label: 'test',
      allowAdminSession: true,
      requireAdminRole: true,
    });
    expect(r.ok).toBe(false);
  });

  it('never consults the session on loopback — no DB hit on the happy path', async () => {
    await guardApiRoute(req({ cookie: 'a'.repeat(64) }), {
      label: 'test',
      allowAdminSession: true,
    });
    expect(getSessionUser).not.toHaveBeenCalled();
  });
});

describe('guardMcpRoute still speaks the MCP error shape', () => {
  it('wraps the refusal as { error: { code, message } }', async () => {
    const r = await guardMcpRoute(req({ headers: REMOTE }), { label: 'tools' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('AUTH_REQUIRED');
      expect(typeof r.body.error.message).toBe('string');
    }
  });

  it('does not accept an admin session (MCP routes never opted in)', async () => {
    getSessionUser.mockResolvedValue({ username: 'op', role: 'admin' });
    const r = await guardMcpRoute(req({ headers: REMOTE, cookie: 'a'.repeat(64) }), {
      label: 'tools',
    });
    expect(r.ok).toBe(false);
  });
});
