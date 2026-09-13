/**
 * @jest-environment node
 *
 * Task 44 item 8. The operator's ask is "don't make me set EXTERNAL_IP", so the
 * load-bearing case is the first one: a containerised sidecar that can only see the
 * Docker bridge, with no pin at all, still yields a working endpoint.
 *
 * Addresses are RFC 5737 documentation ranges.
 */

import {
  resolveSidecarAddress,
  probeSidecarIdentity,
  peekAddressChoice,
  invalidateAddressChoice,
  clearAllAddressChoices,
  CHOICE_TTL_MS,
} from '../sidecar-address-probe';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }),
}));

/** A believable sidecar /api/status document. */
const statusDoc = (version = '2.3.77') => ({
  hostname: 'a-container-id-hex',   // os.hostname(), NOT the display name
  ip: '172.17.0.2',
  agent: { uptime: 1234, version },
  mode: 'searching',
  roles: { embedding: {} },
  masters: [{ serverUrl: 'http://192.0.2.1:3000', wsPort: 3002 }],
});

/** fetch double: `answers` maps a base URL to a response spec. */
function fakeFetch(answers: Record<string, { status?: number; body?: unknown; throws?: boolean }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const base = String(url).replace(/\/api\/status$/, '');
    const spec = answers[base];
    if (!spec || spec.throws) throw new Error('ECONNREFUSED');
    return {
      ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
      status: spec.status ?? 200,
      json: async () => spec.body ?? statusDoc(),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => clearAllAddressChoices());

describe('the operator ask: no EXTERNAL_IP, containerised sidecar', () => {
  it('reaches a sidecar that advertises only its unreachable bridge address', async () => {
    // With no AGENT_URL and no EXTERNAL_IP, a containerised sidecar can only detect
    // 172.17.0.2 — which nothing outside its container can reach. The master saw
    // the connection arrive from the host's LAN address.
    const advertised = 'http://172.17.0.2:8098';
    const { impl } = fakeFetch({ 'http://192.0.2.238:8098': {} }); // only the host answers

    const choice = await resolveSidecarAddress({
      advertisedUrl: advertised,
      observedIp: '192.0.2.238',
      fetchImpl: impl,
    });

    expect(choice.basis).toBe('observed');
    expect(choice.hostname).toBe('192.0.2.238');
    expect(choice.baseUrl).toBe('http://192.0.2.238:8098');
  });

  it('keeps working after DHCP moves the host, with no operator action', async () => {
    // Same sidecar, new host address. Nothing is reconfigured; the master simply
    // observes the new peer address on the next connection.
    const advertised = 'http://172.17.0.2:8098';
    const moved = fakeFetch({ 'http://192.0.2.99:8098': {} });

    const choice = await resolveSidecarAddress({
      advertisedUrl: advertised, observedIp: '192.0.2.99', fetchImpl: moved.impl,
    });
    expect(choice.hostname).toBe('192.0.2.99');
    expect(choice.basis).toBe('observed');
  });

  it('reuses the declared port and never invents 8098', async () => {
    const { impl } = fakeFetch({ 'http://192.0.2.238:9099': {} });
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://172.17.0.2:9099', observedIp: '192.0.2.238', fetchImpl: impl,
    });
    expect(choice.baseUrl).toBe('http://192.0.2.238:9099');
  });
});

describe('a working advertised address is never substituted', () => {
  it('prefers the advertised address when it answers', async () => {
    const { impl, calls } = fakeFetch({
      'http://192.0.2.10:8098': {},
      'http://192.0.2.238:8098': {},   // observed also answers
    });
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://192.0.2.10:8098', observedIp: '192.0.2.238', fetchImpl: impl,
    });
    expect(choice.basis).toBe('advertised');
    expect(choice.hostname).toBe('192.0.2.10');
    // The observed candidate was never even probed.
    expect(calls).toEqual(['http://192.0.2.10:8098/api/status']);
  });

  it('honours a pinned AGENT_URL hostname that answers', async () => {
    // A pin arrives at the master as the advertised address and is indistinguishable
    // from a detected one — trying advertised first is what protects it.
    const { impl } = fakeFetch({ 'http://gateway.example:8098': {} });
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://gateway.example:8098', observedIp: '192.0.2.238', fetchImpl: impl,
    });
    expect(choice.basis).toBe('advertised');
    expect(choice.hostname).toBe('gateway.example');
  });
});

describe('probe rejects anything that is not this sidecar', () => {
  it('rejects a 200 that is not a sidecar status document', async () => {
    // A NAT device or proxy answering on port 8098. This is the case a bare
    // /api/health probe would have accepted — it returns only {ok, uptime}.
    const { impl } = fakeFetch({
      'http://192.0.2.238:8098': { body: { ok: true, uptime: 5 } },
    });
    expect((await probeSidecarIdentity('http://192.0.2.238:8098', {}, impl)))
      .toEqual({ ok: false, reason: 'not-a-sidecar' });
  });

  it('rejects a different sidecar by version', async () => {
    const { impl } = fakeFetch({
      'http://192.0.2.238:8098': { body: statusDoc('1.0.0') },
    });
    expect(await probeSidecarIdentity('http://192.0.2.238:8098', { version: '2.3.77' }, impl))
      .toEqual({ ok: false, reason: 'version-mismatch' });
  });

  it('does not compare hostname — os.hostname() and the display name differ legitimately', async () => {
    // The cache holds getDisplayHostname(); /api/status returns os.hostname().
    // Comparing them would reject a healthy sidecar.
    const { impl } = fakeFetch({ 'http://192.0.2.238:8098': { body: statusDoc() } });
    expect(await probeSidecarIdentity('http://192.0.2.238:8098', { version: '2.3.77' }, impl))
      .toEqual({ ok: true, reason: 'ok' });
  });

  it('treats a non-2xx and a refused connection alike', async () => {
    const { impl } = fakeFetch({ 'http://192.0.2.238:8098': { status: 502 } });
    expect((await probeSidecarIdentity('http://192.0.2.238:8098', {}, impl)).reason).toBe('no-response');
    const gone = fakeFetch({});
    expect((await probeSidecarIdentity('http://192.0.2.5:8098', {}, gone.impl)).reason).toBe('no-response');
  });

  it('probes /api/status, not /status — the sidecar routes live under /api', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.238:8098': {} });
    await probeSidecarIdentity('http://192.0.2.238:8098', {}, impl);
    expect(calls[0]).toBe('http://192.0.2.238:8098/api/status');
  });
});

describe('failing back beats guessing', () => {
  it('returns the advertised address when nothing answers', async () => {
    // fleet-router is the embedding/rerank/RLM data path; dropping a host or
    // inventing an address would be a fleet-wide outage.
    const { impl } = fakeFetch({});
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://192.0.2.10:8098', observedIp: '192.0.2.238', fetchImpl: impl,
    });
    expect(choice.basis).toBe('advertised-unverified');
    expect(choice.hostname).toBe('192.0.2.10');
    expect(choice.note).toContain('advertised:no-response');
  });

  it('an older sidecar that sends no observed address is unaffected', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.10:8098': {} });
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://192.0.2.10:8098', fetchImpl: impl,
    });
    expect(choice.basis).toBe('advertised');
    expect(calls).toHaveLength(1);
  });

  it('never prefers loopback or a Docker bridge as an observed address', async () => {
    // These describe the master's own side of the connection, not an address the
    // fleet can reach.
    for (const ip of ['127.0.0.1', '172.17.0.1', '172.18.0.3']) {
      clearAllAddressChoices();
      const { impl, calls } = fakeFetch({}); // nothing answers
      const choice = await resolveSidecarAddress({
        advertisedUrl: 'http://192.0.2.10:8098', observedIp: ip, fetchImpl: impl,
      });
      expect(choice.basis).toBe('advertised-unverified');
      // Only the advertised candidate was ever tried.
      expect(calls).toEqual(['http://192.0.2.10:8098/api/status']);
    }
  });
});

describe('caching keeps this off the per-request path', () => {
  it('probes once per TTL, not once per call', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.10:8098': {} });
    const input = { advertisedUrl: 'http://192.0.2.10:8098', fetchImpl: impl };
    await resolveSidecarAddress(input);
    await resolveSidecarAddress(input);
    await resolveSidecarAddress(input);
    expect(calls).toHaveLength(1);
  });

  it('re-probes once the TTL expires', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.10:8098': {} });
    const base = { advertisedUrl: 'http://192.0.2.10:8098', fetchImpl: impl };
    await resolveSidecarAddress({ ...base, now: 1_000 });
    await resolveSidecarAddress({ ...base, now: 1_000 + CHOICE_TTL_MS + 1 });
    expect(calls).toHaveLength(2);
  });

  it('invalidation forces a re-probe', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.10:8098': {} });
    const input = { advertisedUrl: 'http://192.0.2.10:8098', fetchImpl: impl };
    await resolveSidecarAddress(input);
    invalidateAddressChoice('http://192.0.2.10:8098');
    await resolveSidecarAddress(input);
    expect(calls).toHaveLength(2);
  });

  it('peek reports the basis without probing', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.238:8098': {} });
    expect(peekAddressChoice('http://172.17.0.2:8098')).toBeNull();
    await resolveSidecarAddress({
      advertisedUrl: 'http://172.17.0.2:8098', observedIp: '192.0.2.238', fetchImpl: impl,
    });
    const before = calls.length;
    expect(peekAddressChoice('http://172.17.0.2:8098')).toMatchObject({
      basis: 'observed', baseUrl: 'http://192.0.2.238:8098',
    });
    expect(calls).toHaveLength(before); // no extra probe
  });

  it('normalises a trailing slash so one host is not probed under two keys', async () => {
    const { impl, calls } = fakeFetch({ 'http://192.0.2.10:8098': {} });
    await resolveSidecarAddress({ advertisedUrl: 'http://192.0.2.10:8098', fetchImpl: impl });
    await resolveSidecarAddress({ advertisedUrl: 'http://192.0.2.10:8098/', fetchImpl: impl });
    expect(calls).toHaveLength(1);
  });
});

describe('IPv6-mapped peer addresses', () => {
  it('an IPv6 observed address is bracketed in the URL', async () => {
    const { impl } = fakeFetch({ 'http://[2001:db8::5]:8098': {} });
    const choice = await resolveSidecarAddress({
      advertisedUrl: 'http://172.17.0.2:8098', observedIp: '2001:db8::5', fetchImpl: impl,
    });
    expect(choice.baseUrl).toBe('http://[2001:db8::5]:8098');
    expect(choice.hostname).toBe('2001:db8::5');
  });
});
