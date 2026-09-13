/**
 * Advertised-address resolution and revalidation — pure, dependency-free.
 *
 * The sidecar tells each master the URL the master should *call back on*. Getting
 * that wrong is not cosmetic: the master hands the value straight to the data
 * path, so a wrong address means every acquire against this host fails or hangs.
 *
 * This module holds the decision logic and nothing else. It imports no `os`, no
 * config, no logger and no network — everything arrives as an argument — so the
 * precedence rules, the Docker-bridge demotion and the flap guard are all
 * testable without a host to run on.
 *
 * Precedence (see resolveAgentUrl):
 *
 *   1. AGENT_URL          — operator's explicit, final answer
 *   2. EXTERNAL_IP        — operator's explicit host, sidecar's own port
 *   3. savedAgentUrl      — persisted value; it once reached a master
 *   4. live detection     — os.networkInterfaces()
 *   5. 127.0.0.1
 *
 * EXTERNAL_IP moving above savedAgentUrl is a real bug fix: it used to sit BELOW
 * the persisted value, so a pin silently overrode an address the operator had set
 * deliberately for NAT.
 *
 * Detection stays BELOW savedAgentUrl — the opposite of what task 41 item 2 first
 * proposed — and the reason is the VPN case. This fleet's master is sometimes on a
 * VPN, so a host is reachable at a DIFFERENT address depending on the path: LAN,
 * Tailscale CGNAT (100.64.0.0/10), or a VPN DNS name. Detection can enumerate the
 * host's own interfaces but cannot know which network the master is on right now,
 * so it has no basis for choosing among them. The persisted value has at least
 * once reached a master; a detected address has been validated by nothing.
 * Overwriting the former with the latter takes hosts dark.
 *
 * Consequently the callback address is OBSERVED master-side from the socket's peer
 * address (`src/lib/gpu/ws-relay.ts`) — by construction the address the sidecar
 * reached the master from, and therefore correct for whichever path is in use.
 *
 * NOTHING HERE RE-ADVERTISES AUTOMATICALLY. `shouldReadvertise()` and
 * `AddressStabilityTracker` are tested building blocks for a future release; no
 * caller invokes them. See docs/tasks/41-sidecar-address-drift.md.
 */

/** The subset of `os.NetworkInterfaceInfo` this module needs. */
export interface IfaceInfo {
  family: string | number;
  internal: boolean;
  address: string;
}

/** Shape of `os.networkInterfaces()`. */
export type InterfaceMap = Record<string, IfaceInfo[] | undefined>;

/**
 * Docker's default bridge subnets. An address on one of these is reachable only
 * from inside the container that owns it, so it is demoted to last resort rather
 * than skipped — a sidecar with nothing else at least advertises something.
 *
 * Deliberately NOT widened to the whole 172.16/12 private block: a real LAN on
 * 172.20.x is legitimate and must not be demoted.
 */
export const DOCKER_BRIDGE_PREFIXES = ['172.17.', '172.18.'] as const;

/** How many consecutive agreeing detections are required before re-advertising. */
export const DEFAULT_STABILITY_SAMPLES = 3;

export function isDockerBridgeAddress(address: string): boolean {
  return DOCKER_BRIDGE_PREFIXES.some((p) => address.startsWith(p));
}

/** True for a dotted-quad IPv4 literal, e.g. `192.0.2.10`. */
export function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** The `/24` of an IPv4 literal (`192.0.2.10` → `192.0.2.`), else null. */
export function subnet24(host: string): string | null {
  if (!isIpv4Literal(host)) return null;
  return host.split('.').slice(0, 3).join('.') + '.';
}

/** Extract the host portion of an `http://host:port` URL without `new URL()`. */
export function hostOfUrl(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(url.trim());
  return m ? m[1] : null;
}

export interface Candidate {
  address: string;
  iface: string;
  /** On a Docker bridge subnet — usable, but only as a last resort. */
  bridge: boolean;
}

/**
 * Every externally-routable IPv4 the host owns, in the order the OS listed them,
 * bridge addresses included but flagged.
 */
export function listCandidates(interfaces: InterfaceMap): Candidate[] {
  const out: Candidate[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      // Node reports family as 'IPv4' (>=18) or 4 (older / some platforms).
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isV4 || iface.internal) continue;
      out.push({ address: iface.address, iface: name, bridge: isDockerBridgeAddress(iface.address) });
    }
  }
  return out;
}

/**
 * Pick the address to advertise.
 *
 * Ordering, strongest first:
 *   1. a non-bridge address on the same /24 as the master — on a multi-homed
 *      host this is the interface that can actually reach the master, which is
 *      strictly better than "whichever the OS listed first" (the old behaviour,
 *      and the reason re-detection could otherwise pick an arbitrary NIC);
 *   2. any other non-bridge address, OS order;
 *   3. a bridge address, OS order.
 *
 * `masterHost` is a hint only and may be a hostname or null; a non-literal
 * simply contributes no preference. No DNS, no probing — this stays pure.
 */
export function detectAdvertisableAddress(
  interfaces: InterfaceMap,
  masterHost?: string | null,
): Candidate | null {
  const candidates = listCandidates(interfaces);
  if (candidates.length === 0) return null;

  const wanted = masterHost ? subnet24(masterHost) : null;
  if (wanted) {
    const onMasterSubnet = candidates.find((c) => !c.bridge && c.address.startsWith(wanted));
    if (onMasterSubnet) return onMasterSubnet;
  }
  return candidates.find((c) => !c.bridge) ?? candidates[0];
}

export type AgentUrlSource =
  | 'env:AGENT_URL'
  | 'env:EXTERNAL_IP'
  | 'detected'
  | 'saved'
  | 'loopback';

export interface ResolveAgentUrlInput {
  /** Usually `process.env`. Only AGENT_URL / EXTERNAL_IP are read. */
  env: { AGENT_URL?: string; EXTERNAL_IP?: string };
  savedAgentUrl: string | null;
  interfaces: InterfaceMap;
  port: number;
  /** Host of a configured master, used to break multi-homed ties. */
  masterHost?: string | null;
}

export interface ResolvedAgentUrl {
  url: string;
  source: AgentUrlSource;
  /** Set when `source` is 'detected'. */
  iface?: string;
}

export function resolveAgentUrl(input: ResolveAgentUrlInput): ResolvedAgentUrl {
  const { env, savedAgentUrl, interfaces, port, masterHost } = input;

  if (env.AGENT_URL) return { url: env.AGENT_URL, source: 'env:AGENT_URL' };
  if (env.EXTERNAL_IP) return { url: `http://${env.EXTERNAL_IP}:${port}`, source: 'env:EXTERNAL_IP' };

  // A persisted address once reached a master, which is more than detection can
  // claim on a multi-path host. Keeping it ahead of detection means this release
  // changes NO host's advertised address except one where EXTERNAL_IP was being
  // wrongly overridden.
  if (savedAgentUrl) return { url: savedAgentUrl, source: 'saved' };

  const detected = detectAdvertisableAddress(interfaces, masterHost);
  if (detected) {
    return { url: `http://${detected.address}:${port}`, source: 'detected', iface: detected.iface };
  }
  return { url: `http://127.0.0.1:${port}`, source: 'loopback' };
}

/** Is the host in `url` still one of this machine's own IPv4 addresses? */
export type Locality = 'local' | 'not-local' | 'unknown';

/**
 * `unknown` covers a URL whose host is not an IPv4 literal. A sidecar
 * advertising a hostname cannot be checked against `os.networkInterfaces()`
 * without resolving it, and a name is a deliberate operator choice — so it is
 * left alone rather than flapped.
 */
export function advertisedHostLocality(url: string, interfaces: InterfaceMap): Locality {
  const host = hostOfUrl(url);
  if (!host || !isIpv4Literal(host)) return 'unknown';
  // Loopback is deliberately NOT treated as local. listCandidates() filters
  // `internal`, so 127.0.0.1 never matches a candidate and falls out as
  // 'not-local' — which is what we want: a sidecar that resolved to the loopback
  // dead end (its network was not up yet at boot) must be able to escape it once
  // a real interface appears. Short-circuiting it to 'local' pinned it there for
  // the life of the process, since revalidation stops at 'still-local'.
  return listCandidates(interfaces).some((c) => c.address === host) ? 'local' : 'not-local';
}

/**
 * Debounce for re-advertisement. A flapping address is worse than a stale one:
 * with the master-side re-key in place, each flip migrates registry state. So a
 * replacement must be observed `samples` times in a row before it is adopted,
 * and any disagreement restarts the count.
 */
export class AddressStabilityTracker {
  private last: string | null = null;
  private streak = 0;

  constructor(private readonly samples: number = DEFAULT_STABILITY_SAMPLES) {}

  /** Returns the candidate once it has been stable for `samples` observations. */
  observe(candidate: string | null): string | null {
    if (candidate === null) {
      this.reset();
      return null;
    }
    if (candidate === this.last) {
      this.streak++;
    } else {
      this.last = candidate;
      this.streak = 1;
    }
    return this.streak >= this.samples ? candidate : null;
  }

  reset(): void {
    this.last = null;
    this.streak = 0;
  }

  /** For logging: how close the current candidate is to being adopted. */
  get progress(): { candidate: string | null; streak: number; samples: number } {
    return { candidate: this.last, streak: this.streak, samples: this.samples };
  }
}

export interface ReadvertiseDecision {
  act: boolean;
  /** Present only when `act` is true. */
  next?: string;
  reason:
    | 'pinned-by-env'         // AGENT_URL / EXTERNAL_IP — operator's call, never touched
    | 'still-local'           // advertised address is one of ours
    | 'not-an-ip-literal'     // hostname advertised — cannot check, assume intent
    | 'no-candidate'          // nothing routable detected
    | 'same-address'          // detection agrees with what we advertise
    | 'awaiting-stability'    // change seen, not yet confirmed
    | 'readvertise';
}

/**
 * One revalidation tick. Pure: the caller supplies the current advertised URL,
 * the interface map and the tracker, and acts on the decision.
 */
export function shouldReadvertise(args: {
  current: string;
  env: { AGENT_URL?: string; EXTERNAL_IP?: string };
  interfaces: InterfaceMap;
  port: number;
  masterHost?: string | null;
  tracker: AddressStabilityTracker;
}): ReadvertiseDecision {
  const { current, env, interfaces, port, masterHost, tracker } = args;

  // Structural guard, not a conditional to remember: an operator-pinned address
  // is frequently and correctly NOT local (NAT, multi-homed, port-forwarded).
  if (env.AGENT_URL || env.EXTERNAL_IP) {
    tracker.reset();
    return { act: false, reason: 'pinned-by-env' };
  }

  const locality = advertisedHostLocality(current, interfaces);
  if (locality === 'local') {
    tracker.reset();
    return { act: false, reason: 'still-local' };
  }
  if (locality === 'unknown') {
    tracker.reset();
    return { act: false, reason: 'not-an-ip-literal' };
  }

  const detected = detectAdvertisableAddress(interfaces, masterHost);
  if (!detected) {
    tracker.reset();
    return { act: false, reason: 'no-candidate' };
  }

  const next = `http://${detected.address}:${port}`;
  if (next === current) {
    tracker.reset();
    return { act: false, reason: 'same-address' };
  }

  const confirmed = tracker.observe(next);
  if (!confirmed) return { act: false, reason: 'awaiting-stability' };

  tracker.reset();
  return { act: true, next: confirmed, reason: 'readvertise' };
}
