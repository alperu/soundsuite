/**
 * @jest-environment node
 *
 * Sidecar advertised-address resolution (task 41).
 *
 * The module under test lives in `sideCar/src/lib/`, which has NO test runner of
 * its own — the sidecar package ships only next/react/ws and no jest. Rather than
 * adding a second runner to a package whose version the release script owns, the
 * logic was extracted into a dependency-free module and is exercised from the
 * root suite by relative import. The import must stay relative: root jest maps
 * `@/` to the root `src/`, so an `@/`-specifier inside the sidecar tree would
 * silently resolve into the wrong project.
 *
 * Addresses here are RFC 5737 documentation ranges and invented hostnames — the
 * sidecar tree is published publicly.
 */

import {
  AddressStabilityTracker,
  DOCKER_BRIDGE_PREFIXES,
  advertisedHostLocality,
  detectAdvertisableAddress,
  isIpv4Literal,
  resolveAgentUrl,
  shouldReadvertise,
  type InterfaceMap,
} from '../../../../sideCar/src/lib/agent-address';

const PORT = 8098;

/** Build an `os.networkInterfaces()`-shaped map. */
function ifaces(spec: Record<string, Array<[string, boolean?]>>): InterfaceMap {
  const out: InterfaceMap = {};
  for (const [name, addrs] of Object.entries(spec)) {
    out[name] = addrs.map(([address, internal]) => ({
      family: 'IPv4',
      internal: internal ?? false,
      address,
    }));
  }
  return out;
}

const LAN = ifaces({
  lo0: [['127.0.0.1', true]],
  en0: [['192.0.2.10']],
});

describe('resolveAgentUrl precedence', () => {
  it('AGENT_URL wins over everything, including a live interface', () => {
    const r = resolveAgentUrl({
      env: { AGENT_URL: 'http://gateway.example:9000', EXTERNAL_IP: '198.51.100.7' },
      savedAgentUrl: 'http://192.0.2.242:8098',
      interfaces: LAN,
      port: PORT,
    });
    expect(r).toEqual({ url: 'http://gateway.example:9000', source: 'env:AGENT_URL' });
  });

  it('EXTERNAL_IP beats a persisted address — the pre-fix order had this backwards', () => {
    const r = resolveAgentUrl({
      env: { EXTERNAL_IP: '198.51.100.7' },
      savedAgentUrl: 'http://192.0.2.242:8098',
      interfaces: LAN,
      port: PORT,
    });
    // Pre-fix (ws-client.ts:53 above :54) this returned the saved .242 value,
    // overriding an address the operator set deliberately for NAT.
    expect(r).toEqual({ url: 'http://198.51.100.7:8098', source: 'env:EXTERNAL_IP' });
  });

  it('detection beats a persisted address — this is the drift bug', () => {
    const r = resolveAgentUrl({
      env: {},
      savedAgentUrl: 'http://192.0.2.242:8098', // pinned by a past self-update
      interfaces: ifaces({ en0: [['192.0.2.238']] }), // where DHCP moved the host
      port: PORT,
    });
    expect(r.url).toBe('http://192.0.2.238:8098');
    expect(r.source).toBe('detected');
  });

  it('falls back to the persisted address only when nothing routable exists', () => {
    const r = resolveAgentUrl({
      env: {},
      savedAgentUrl: 'http://192.0.2.242:8098',
      interfaces: ifaces({ lo0: [['127.0.0.1', true]] }),
      port: PORT,
    });
    expect(r).toEqual({ url: 'http://192.0.2.242:8098', source: 'saved' });
  });

  it('falls back to loopback with neither an interface nor a saved value', () => {
    const r = resolveAgentUrl({
      env: {},
      savedAgentUrl: null,
      interfaces: ifaces({ lo0: [['127.0.0.1', true]] }),
      port: PORT,
    });
    expect(r).toEqual({ url: 'http://127.0.0.1:8098', source: 'loopback' });
  });

  it('accepts the numeric IPv4 family some platforms report', () => {
    const numeric: InterfaceMap = {
      en0: [{ family: 4, internal: false, address: '192.0.2.10' }],
    };
    expect(resolveAgentUrl({ env: {}, savedAgentUrl: null, interfaces: numeric, port: PORT }).url)
      .toBe('http://192.0.2.10:8098');
  });
});

describe('Docker-internal addresses are never preferred', () => {
  it('prefers a LAN address over a docker0 bridge address regardless of listing order', () => {
    const bridgeFirst = ifaces({
      docker0: [['172.17.0.1']],
      br1: [['172.18.0.1']],
      eth0: [['192.0.2.10']],
    });
    expect(detectAdvertisableAddress(bridgeFirst)!.address).toBe('192.0.2.10');
  });

  it('uses a bridge address only when it is the only one', () => {
    const only = ifaces({ eth0: [['172.17.0.2']] });
    const picked = detectAdvertisableAddress(only)!;
    expect(picked.address).toBe('172.17.0.2');
    expect(picked.bridge).toBe(true);
  });

  it('does not demote the rest of 172.16/12 — a real LAN may live on 172.20.x', () => {
    expect(DOCKER_BRIDGE_PREFIXES).toEqual(['172.17.', '172.18.']);
    const lan = ifaces({ eth0: [['172.20.5.5']] });
    expect(detectAdvertisableAddress(lan)!.bridge).toBe(false);
  });
});

describe('multi-homed tie-break', () => {
  const multi = ifaces({
    en0: [['198.51.100.4']],   // first listed, wrong side of the house
    en1: [['192.0.2.11']],     // the one that can reach the master
  });

  it('prefers the interface on the master’s /24 over the first listed', () => {
    expect(detectAdvertisableAddress(multi, '192.0.2.1')!.address).toBe('192.0.2.11');
  });

  it('keeps OS order when the master host is a name, not a literal', () => {
    expect(detectAdvertisableAddress(multi, 'master.example')!.address).toBe('198.51.100.4');
  });

  it('never picks a bridge address even when it shares the master’s /24', () => {
    const withBridge = ifaces({ docker0: [['172.17.0.1']], eth0: [['192.0.2.11']] });
    expect(detectAdvertisableAddress(withBridge, '172.17.0.9')!.address).toBe('192.0.2.11');
  });
});

describe('advertisedHostLocality', () => {
  it('recognises an address the host still owns', () => {
    expect(advertisedHostLocality('http://192.0.2.10:8098', LAN)).toBe('local');
  });

  it('recognises an address the host has left', () => {
    expect(advertisedHostLocality('http://192.0.2.242:8098', LAN)).toBe('not-local');
  });

  it('reports unknown for a hostname — it cannot be checked without resolution', () => {
    expect(advertisedHostLocality('http://sidecar-alpha.example:8098', LAN)).toBe('unknown');
  });

  it('does not call loopback local — that would be an inescapable dead end', () => {
    // A sidecar whose network was not up at boot resolves to 127.0.0.1. If that
    // read as 'local', revalidation would stop at 'still-local' and it would
    // advertise loopback for the life of the process.
    expect(advertisedHostLocality('http://127.0.0.1:8098', LAN)).toBe('not-local');
  });

  it('rejects malformed dotted quads as non-literals', () => {
    expect(isIpv4Literal('192.0.2.999')).toBe(false);
    expect(isIpv4Literal('192.0.2')).toBe(false);
    expect(isIpv4Literal('192.0.2.10')).toBe(true);
  });
});

describe('AddressStabilityTracker', () => {
  it('adopts only after N consecutive agreeing observations', () => {
    const t = new AddressStabilityTracker(3);
    expect(t.observe('http://192.0.2.238:8098')).toBeNull();
    expect(t.observe('http://192.0.2.238:8098')).toBeNull();
    expect(t.observe('http://192.0.2.238:8098')).toBe('http://192.0.2.238:8098');
  });

  it('restarts the count when detection disagrees with itself', () => {
    const t = new AddressStabilityTracker(3);
    t.observe('http://192.0.2.238:8098');
    t.observe('http://198.51.100.9:8098'); // flap
    expect(t.observe('http://192.0.2.238:8098')).toBeNull();
    expect(t.observe('http://192.0.2.238:8098')).toBeNull();
    expect(t.observe('http://192.0.2.238:8098')).toBe('http://192.0.2.238:8098');
  });
});

describe('shouldReadvertise', () => {
  const moved = ifaces({ en0: [['192.0.2.238']] });
  const stale = 'http://192.0.2.242:8098';

  it('replaces a saved address that is no longer local, once it is stable', () => {
    const tracker = new AddressStabilityTracker(3);
    const tick = () => shouldReadvertise({ current: stale, env: {}, interfaces: moved, port: PORT, tracker });
    expect(tick().reason).toBe('awaiting-stability');
    expect(tick().reason).toBe('awaiting-stability');
    const third = tick();
    expect(third).toEqual({ act: true, next: 'http://192.0.2.238:8098', reason: 'readvertise' });
  });

  it('does not fire when AGENT_URL is set, even though the address is not local', () => {
    const tracker = new AddressStabilityTracker(1);
    const d = shouldReadvertise({
      current: 'http://gateway.example:9000',
      env: { AGENT_URL: 'http://gateway.example:9000' },
      interfaces: moved, port: PORT, tracker,
    });
    expect(d).toEqual({ act: false, reason: 'pinned-by-env' });
  });

  it('does not fire when EXTERNAL_IP is set — a NAT’d host is correctly non-local', () => {
    const tracker = new AddressStabilityTracker(1);
    const d = shouldReadvertise({
      current: 'http://198.51.100.7:8098',
      env: { EXTERNAL_IP: '198.51.100.7' },
      interfaces: moved, port: PORT, tracker,
    });
    expect(d).toEqual({ act: false, reason: 'pinned-by-env' });
  });

  it('leaves a still-local address alone', () => {
    const tracker = new AddressStabilityTracker(1);
    const d = shouldReadvertise({
      current: 'http://192.0.2.238:8098', env: {}, interfaces: moved, port: PORT, tracker,
    });
    expect(d).toEqual({ act: false, reason: 'still-local' });
  });

  it('leaves a hostname-advertising sidecar alone rather than flapping it', () => {
    const tracker = new AddressStabilityTracker(1);
    const d = shouldReadvertise({
      current: 'http://sidecar-alpha.example:8098', env: {}, interfaces: moved, port: PORT, tracker,
    });
    expect(d).toEqual({ act: false, reason: 'not-an-ip-literal' });
  });

  it('does nothing when the host has no routable address to offer', () => {
    const tracker = new AddressStabilityTracker(1);
    const d = shouldReadvertise({
      current: stale, env: {},
      interfaces: ifaces({ lo0: [['127.0.0.1', true]] }), port: PORT, tracker,
    });
    expect(d).toEqual({ act: false, reason: 'no-candidate' });
  });

  it('escapes the loopback dead end once a real interface comes up', () => {
    // Boot with no routable interface at all — the container process started
    // before its network did.
    const noNetwork = ifaces({ lo0: [['127.0.0.1', true]] });
    const atBoot = resolveAgentUrl({ env: {}, savedAgentUrl: null, interfaces: noNetwork, port: PORT });
    expect(atBoot).toEqual({ url: 'http://127.0.0.1:8098', source: 'loopback' });

    // Nothing to do while the network is still down.
    const tracker = new AddressStabilityTracker(3);
    expect(shouldReadvertise({
      current: atBoot.url, env: {}, interfaces: noNetwork, port: PORT, tracker,
    }).reason).toBe('no-candidate');

    // en0 comes up. Three agreeing ticks and the sidecar re-advertises.
    const up = ifaces({ lo0: [['127.0.0.1', true]], en0: [['192.0.2.10']] });
    const tick = () => shouldReadvertise({ current: atBoot.url, env: {}, interfaces: up, port: PORT, tracker });
    expect(tick().act).toBe(false);
    expect(tick().act).toBe(false);
    expect(tick()).toEqual({ act: true, next: 'http://192.0.2.10:8098', reason: 'readvertise' });
  });

  it('a flapping detection never reaches the act threshold', () => {
    const tracker = new AddressStabilityTracker(3);
    const a = ifaces({ en0: [['192.0.2.238']] });
    const b = ifaces({ en0: [['198.51.100.9']] });
    for (let i = 0; i < 10; i++) {
      const d = shouldReadvertise({
        current: stale, env: {}, interfaces: i % 2 === 0 ? a : b, port: PORT, tracker,
      });
      expect(d.act).toBe(false);
    }
  });
});
