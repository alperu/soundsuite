/** @jest-environment node */

/**
 * Auth matrix for `POST /api/mcp/execute` (report N-9 / M-5).
 *
 * All keys here are synthetic placeholders — never a real key.
 */

import {
  classifyOrigin,
  decideExecuteAuth,
  extractCredential,
  isLoopbackHost,
  normalizeAuthMode,
  parseStrictLoopback,
  parseTrustProxy,
  guardMcpRoute,
  resetMcpApiKeyCache,
  type ExecuteAuthInput,
} from '../execute-auth';

const KEY = 'synthetic-key-aaaa';
const OTHER_KEY = 'synthetic-key-bbbb';

function decide(over: Partial<ExecuteAuthInput> = {}) {
  return decideExecuteAuth({
    origin: 'loopback',
    modeRaw: 'none',
    keys: [],
    credential: null,
    strictLoopback: 'off',
    profile: 'local',
    ...over,
  });
}

describe('normalizeAuthMode', () => {
  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['none', 'none'],
    [' APIKEY ', 'apikey'],
    ['"oauth"', 'oauth'],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeAuthMode(raw as string | undefined)).toBe(expected);
  });

  it('returns null for an unrecognised mode', () => {
    expect(normalizeAuthMode('api-key')).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000', '::1', '[::1]:3000', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['192.168.1.20', '192.168.1.20:3000', 'mcp.example.test', '10.0.0.4', '', null])(
    'treats %s as remote',
    (h) => expect(isLoopbackHost(h as string | null)).toBe(false),
  );
});

describe('classifyOrigin', () => {
  it('is loopback for a same-machine dashboard/bridge request', () => {
    expect(classifyOrigin({ urlHostname: 'localhost', hostHeader: 'localhost:3000' })).toBe('loopback');
  });

  it('is loopback when only the request URL carries the host (unit-test shape)', () => {
    expect(classifyOrigin({ urlHostname: 'localhost' })).toBe('loopback');
  });

  it('is remote when a proxy forwards a non-loopback client IP', () => {
    expect(
      classifyOrigin({ urlHostname: 'localhost', hostHeader: 'localhost:3000', forwardedFor: '203.0.113.9, 127.0.0.1' }),
    ).toBe('remote');
  });

  it('is remote for a tunnelled request (public Host, loopback socket)', () => {
    expect(classifyOrigin({ urlHostname: 'mcp.example.test', hostHeader: 'mcp.example.test' })).toBe('remote');
  });

  it('is remote for a LAN-IP dashboard URL', () => {
    expect(classifyOrigin({ urlHostname: '192.168.1.20', hostHeader: '192.168.1.20:3000' })).toBe('remote');
  });

  it('is remote when nothing identifies the peer', () => {
    expect(classifyOrigin({})).toBe('remote');
  });

  // --- M-5 / v5 §R-2 -----------------------------------------------------
  // Next.js sets `x-forwarded-for` from the socket peer when the client did
  // not (base-server.js:576, `??=`), so a single loopback entry is the normal
  // shape of a direct request and must stay allowed.
  it('is loopback for the single Next-injected IPv4 peer entry', () => {
    expect(
      classifyOrigin({ urlHostname: 'localhost', hostHeader: 'localhost:3000', forwardedFor: '127.0.0.1' }),
    ).toBe('loopback');
  });

  it('is loopback for the single Next-injected IPv6 peer entry', () => {
    expect(classifyOrigin({ urlHostname: 'localhost', hostHeader: 'localhost:3000', forwardedFor: '::1' })).toBe(
      'loopback',
    );
  });

  // New beyond v5: v5 only probed `<public>, 127.0.0.1`. The reversed chain
  // used to pass, because the leftmost entry won and `??=` cannot produce a
  // second entry.
  it('is remote for a loopback-first multi-hop chain (trustProxy off)', () => {
    expect(
      classifyOrigin({
        urlHostname: 'localhost',
        hostHeader: 'localhost:3000',
        forwardedFor: '127.0.0.1, 203.0.113.9',
      }),
    ).toBe('remote');
  });

  it('is remote for a loopback X-Real-IP — Next never injects that header', () => {
    expect(classifyOrigin({ urlHostname: 'localhost', realIp: '127.0.0.1' })).toBe('remote');
  });

  it('is remote for a Forwarded header — same reason', () => {
    expect(classifyOrigin({ urlHostname: 'localhost', forwarded: 'for=127.0.0.1' })).toBe('remote');
  });

  it('accepts a declared proxy chain and reads the leftmost entry under MCP_TRUST_PROXY', () => {
    expect(
      classifyOrigin({ urlHostname: 'localhost', forwardedFor: '127.0.0.1, 10.0.0.5', trustProxy: true }),
    ).toBe('loopback');
    expect(
      classifyOrigin({ urlHostname: 'localhost', forwardedFor: '203.0.113.9, 10.0.0.5', trustProxy: true }),
    ).toBe('remote');
  });

  // Documented, deliberately: a forged single-value header is indistinguishable
  // from the injected one inside a route handler.
  it('KNOWN GAP: a forged single-value loopback XFF still classifies as loopback', () => {
    expect(
      classifyOrigin({ urlHostname: 'localhost', hostHeader: 'localhost:3000', forwardedFor: '127.0.0.1' }),
    ).toBe('loopback');
  });
});

describe('parseTrustProxy', () => {
  it.each(['1', 'true', 'yes', 'on', 'TRUE', '"1"'])('accepts %s', (v) => {
    expect(parseTrustProxy(v)).toBe(true);
  });
  it.each([undefined, '', '0', 'false', 'no', 'maybe'])('rejects %s', (v) => {
    expect(parseTrustProxy(v)).toBe(false);
  });
});

describe('extractCredential', () => {
  it('reads a bearer token', () => {
    expect(extractCredential({ authorization: `Bearer ${KEY}` })).toBe(KEY);
  });
  it('reads X-API-Key and prefers it', () => {
    expect(extractCredential({ authorization: `Bearer ${OTHER_KEY}`, apiKey: KEY })).toBe(KEY);
  });
  it('is null when neither header is present', () => {
    expect(extractCredential({})).toBeNull();
    expect(extractCredential({ authorization: 'Bearer   ' })).toBeNull();
  });
});

describe('parseStrictLoopback', () => {
  it.each([
    [undefined, 'off'],
    ['0', 'off'],
    ['1', 'all'],
    ['true', 'all'],
    ['routed', 'routed'],
  ])('parses %p as %p', (raw, expected) => {
    expect(parseStrictLoopback(raw as string | undefined)).toBe(expected);
  });
});

describe('decideExecuteAuth — loopback (development must keep working)', () => {
  it.each(['local', 'routed'] as const)('allows %s with no keys and no credential in mode none', (profile) => {
    expect(decide({ profile }).ok).toBe(true);
  });

  it.each(['none', 'apikey', 'oauth'])('allows an uncredentialled loopback call in mode %s', (modeRaw) => {
    expect(decide({ modeRaw }).ok).toBe(true);
  });

  it('ignores a credential when no keys are configured (the bridge always sends MCP_API_KEY)', () => {
    expect(decide({ credential: 'whatever-the-bridge-sent' }).ok).toBe(true);
  });

  it('allows a call with no credential even when keys are configured', () => {
    expect(decide({ keys: [KEY] }).ok).toBe(true);
  });

  it('refuses a wrong credential when keys are configured', () => {
    const d = decide({ keys: [KEY], credential: OTHER_KEY });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
    expect(d.code).toBe('AUTH_FAILED');
  });

  it('accepts a correct credential', () => {
    expect(decide({ keys: [KEY], credential: KEY }).ok).toBe(true);
  });
});

describe('decideExecuteAuth — remote (must authenticate, whatever the profile)', () => {
  it.each(['local', 'routed'] as const)('refuses %s when no keys are configured', (profile) => {
    const d = decide({ origin: 'remote', profile });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
    expect(d.code).toBe('AUTH_REQUIRED');
    expect(d.message).toContain('MCP_API_KEYS');
    expect(d.message).toContain('MCP_AUTH_MODE=none');
  });

  it('names oauth as unverified on this route', () => {
    const d = decide({ origin: 'remote', modeRaw: 'oauth' });
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/not verified on this route/);
  });

  it('refuses a missing credential when keys are configured', () => {
    const d = decide({ origin: 'remote', keys: [KEY] });
    expect(d.code).toBe('AUTH_REQUIRED');
    expect(d.message).toMatch(/missing credential/);
  });

  it('refuses a wrong credential', () => {
    expect(decide({ origin: 'remote', keys: [KEY], credential: OTHER_KEY }).code).toBe('AUTH_FAILED');
  });

  it.each(['local', 'routed'] as const)('accepts a valid key for %s', (profile) => {
    expect(decide({ origin: 'remote', keys: [KEY], credential: KEY, profile }).ok).toBe(true);
  });

  it.each(['none', 'apikey', 'oauth'])('accepts a valid key in mode %s', (modeRaw) => {
    expect(decide({ origin: 'remote', modeRaw, keys: [KEY], credential: KEY }).ok).toBe(true);
  });
});

describe('decideExecuteAuth — MCP_AUTH_STRICT_LOOPBACK', () => {
  it('=all requires a credential on loopback too', () => {
    const d = decide({ strictLoopback: 'all', keys: [KEY] });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('AUTH_REQUIRED');
    expect(d.message).toMatch(/MCP_AUTH_STRICT_LOOPBACK/);
    expect(decide({ strictLoopback: 'all', keys: [KEY], credential: KEY }).ok).toBe(true);
  });

  it('=routed gates only the profile that spends money', () => {
    expect(decide({ strictLoopback: 'routed', keys: [KEY], profile: 'local' }).ok).toBe(true);
    expect(decide({ strictLoopback: 'routed', keys: [KEY], profile: 'routed' }).ok).toBe(false);
  });
});

// R-1: the guard every /api/mcp/* handler calls.
describe('guardMcpRoute', () => {
  function fakeRequest(hostname: string, headers: Record<string, string> = {}) {
    return {
      nextUrl: { hostname },
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    };
  }

  beforeEach(() => {
    delete process.env.MCP_API_KEYS;
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_AUTH_STRICT_LOOPBACK;
    delete process.env.MCP_TRUST_PROXY;
    process.env.MCP_AUTH_MODE = 'none';
    resetMcpApiKeyCache();
  });

  it('allows a loopback request with no credential', async () => {
    const r = await guardMcpRoute(fakeRequest('localhost', { host: 'localhost:3000' }), { label: 'T' });
    expect(r.ok).toBe(true);
  });

  it('refuses a remote request with a 401 body the route can return verbatim', async () => {
    const r = await guardMcpRoute(fakeRequest('localhost', { 'x-forwarded-for': '203.0.113.9' }), { label: 'T' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('accepts a configured key from a remote caller', async () => {
    process.env.MCP_API_KEYS = KEY;
    resetMcpApiKeyCache();
    const r = await guardMcpRoute(
      fakeRequest('localhost', { 'x-forwarded-for': '203.0.113.9', 'x-api-key': KEY }),
      { label: 'T' },
    );
    expect(r.ok).toBe(true);
  });

  it('treats an in-process call with no request object as loopback', async () => {
    const r = await guardMcpRoute(undefined, { label: 'T' });
    expect(r.ok).toBe(true);
  });

  it('defaults the profile to local so a listing call is not caught by =routed', async () => {
    process.env.MCP_API_KEYS = KEY;
    process.env.MCP_AUTH_STRICT_LOOPBACK = 'routed';
    resetMcpApiKeyCache();
    const listing = await guardMcpRoute(fakeRequest('localhost'), { label: 'T' });
    expect(listing.ok).toBe(true);
    const routedJob = await guardMcpRoute(fakeRequest('localhost'), { label: 'T', profile: 'routed' });
    expect(routedJob.ok).toBe(false);
  });
});

describe('decideExecuteAuth — misconfiguration', () => {
  it('refuses every request when MCP_AUTH_MODE is unparseable, and says so', () => {
    for (const origin of ['loopback', 'remote'] as const) {
      const d = decide({ origin, modeRaw: 'api_key' });
      expect(d.ok).toBe(false);
      expect(d.status).toBe(401);
      expect(d.code).toBe('AUTH_MISCONFIGURED');
      expect(d.mode).toBeNull();
      expect(d.message).toContain('api_key');
      expect(d.message).toContain('none | apikey | oauth');
    }
  });
});
