/**
 * Which address should the master actually call a sidecar on?
 *
 * Task 44. A containerised sidecar can only see the Docker bridge
 * (`ip: "172.17.0.2"`) — the host's LAN address is not visible from inside the
 * container, and `host.docker.internal` is the gateway, not the LAN interface. So
 * on-host detection cannot work there in principle, and `EXTERNAL_IP` existed to
 * paper over it: a hand-copied constant that goes stale when DHCP moves the host,
 * cannot be validated, and can only be corrected by recreating the container.
 *
 * The master already holds the answer. The sidecar connects **outbound**, so the
 * peer address on its socket is the address it reached us from — the host's, since
 * the container NATs out through it. `ws-relay.ts` records it as `observedFromIp`
 * and persists it as `lastSeenFromIp`; until now nothing routed on it.
 *
 * This module closes that gap under one rule: **a candidate is used only after it
 * has answered as this sidecar.** Substituting an unprobed address would trade a
 * stale-address bug for an unreachable-address bug, which is the failure mode this
 * repo keeps rediscovering — acting on a claim nothing verified.
 *
 * Ordering is deliberately conservative:
 *
 *   1. the **advertised** address (today's behaviour, and an operator's `AGENT_URL`
 *      / `EXTERNAL_IP` pin arrives as exactly this) — so a pin that works is never
 *      substituted;
 *   2. the **observed** peer address, only if the advertised one did not answer;
 *   3. on total failure, the advertised address again — never drop the host.
 *
 * Rule 3 matters more than it looks: `fleet-router` is the embedding / rerank / RLM
 * data path, so the worst outcome of a bug here is a fleet-wide outage. Failing
 * back to today's behaviour is always preferred over a clever substitution.
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('SidecarAddress');

/** How long a decision is trusted before it is re-probed. */
export const CHOICE_TTL_MS = 60_000;

/** Probe timeout. Short: this sits in front of the routing path. */
const PROBE_TIMEOUT_MS = 3_000;

export type AddressBasis =
  /** The address the sidecar advertised — includes an operator pin. */
  | 'advertised'
  /** The peer address the master observed on the sidecar's own socket. */
  | 'observed'
  /** Nothing answered; using the advertised address as today's behaviour. */
  | 'advertised-unverified';

export interface AddressChoice {
  /** Base URL to call the sidecar's admin API on, e.g. `http://192.0.2.10:8098`. */
  baseUrl: string;
  /** Hostname to use when building a role endpoint. */
  hostname: string;
  basis: AddressBasis;
  decidedAt: number;
  /** Set when the probe rejected something, for reporting. */
  note?: string;
}

interface CacheEntry extends AddressChoice {
  /** Advertised URL this decision was made for — the cache key. */
  key: string;
}

// Held on globalThis for the same reason ws-relay's maps are: Next.js re-evaluates
// this module per context, and a per-context cache would re-probe on every route.
const g = globalThis as any;
if (!g.__ss_addr_choice__) g.__ss_addr_choice__ = new Map<string, CacheEntry>();
const choices: Map<string, CacheEntry> = g.__ss_addr_choice__;

/** Drop a cached decision — call when a sidecar re-registers or its address moves. */
export function invalidateAddressChoice(advertisedUrl: string): void {
  if (choices.delete(normalize(advertisedUrl))) {
    logger.info('Address choice invalidated', { advertisedUrl });
  }
}

export function clearAllAddressChoices(): void {
  choices.clear();
}

/** Read a cached decision without probing. For reporting surfaces. */
export function peekAddressChoice(advertisedUrl: string): AddressChoice | null {
  return choices.get(normalize(advertisedUrl)) ?? null;
}

function normalize(u: string): string { return u.replace(/\/+$/, ''); }

/**
 * What the probe response must look like to count as "this sidecar".
 *
 * A bare 200 is NOT enough: the observed address can be a NAT device or a proxy
 * that answers on the sidecar's port as something else entirely. Note that
 * `/api/health` returns only `{ok, uptime}` and identifies nothing, so it is the
 * wrong endpoint for this — `/api/status` is used instead.
 */
export interface IdentityExpectation {
  /** `agent.version` as last reported over the heartbeat, when known. */
  version?: string;
}

export interface ProbeResult {
  ok: boolean;
  reason:
    | 'ok'
    | 'no-response'      // connect refused / timed out / non-2xx
    | 'not-json'
    | 'not-a-sidecar'    // answered, but not a sidecar status document
    | 'version-mismatch'; // a sidecar, but not the one we expected
}

/**
 * Probe one base URL and require that it answers *as a sidecar*.
 *
 * The path is `/api/status`, not `/status` — the sidecar is a Next app and its
 * routes live under `/api` (`sidecar-reconnect-watchdog.ts:121` has this right;
 * `fleet-router.ts`'s `testSidecar` fetches `/health` with no prefix and therefore
 * always fails, which is a separate pre-existing bug).
 */
export async function probeSidecarIdentity(
  baseUrl: string,
  expect: IdentityExpectation = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let body: any;
  try {
    const res = await fetchImpl(`${normalize(baseUrl)}/api/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'no-response' };
    body = await res.json();
  } catch {
    return { ok: false, reason: 'no-response' };
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'not-json' };

  // Shape check — a sidecar status document, not merely something that said 200.
  // `agent.version` + `mode` + `roles` together are not plausibly served by a NAT
  // device or a generic proxy.
  const version = body?.agent?.version;
  const looksLikeSidecar =
    typeof version === 'string' && typeof body.mode === 'string' && body.roles != null;
  if (!looksLikeSidecar) return { ok: false, reason: 'not-a-sidecar' };

  // Deliberately NOT compared: `hostname`. The route returns `os.hostname()` while
  // the status cache holds `getDisplayHostname()` (which honours SIDECAR_HOSTNAME,
  // the Docker host name, or a `gpu-<n>` fallback for a hex container id). Those
  // legitimately differ, so comparing them would reject a healthy sidecar.
  if (expect.version && version !== expect.version) {
    return { ok: false, reason: 'version-mismatch' };
  }
  return { ok: true, reason: 'ok' };
}

export interface ResolveAddressInput {
  /** The address the sidecar advertised — the current behaviour and the default. */
  advertisedUrl: string;
  /** `lastSeenFromIp` / `observedFromIp`: the peer address off the socket. */
  observedIp?: string;
  /** `agent.version` from the heartbeat, to bind the probe to this sidecar. */
  expectVersion?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  now?: number;
}

/**
 * Decide which address to call, probing at most once per TTL per sidecar.
 *
 * The port is never invented. The observed candidate reuses the **declared** port
 * from `advertisedUrl` — which the sidecar already sends — because the observed
 * *source* port is ephemeral and useless. Nothing here hardcodes 8098.
 */
export async function resolveSidecarAddress(input: ResolveAddressInput): Promise<AddressChoice> {
  const advertised = normalize(input.advertisedUrl);
  const now = input.now ?? Date.now();
  const key = advertised;

  const cached = choices.get(key);
  if (cached && now - cached.decidedAt < CHOICE_TTL_MS) return cached;

  const advertisedHost = hostOf(advertised);
  const fallback: AddressChoice = {
    baseUrl: advertised,
    hostname: advertisedHost ?? advertised,
    basis: 'advertised-unverified',
    decidedAt: now,
  };
  if (!advertisedHost) return remember(key, fallback);

  const candidates = buildCandidates(advertised, input.observedIp);
  const expect = { version: input.expectVersion };
  let note: string | undefined;

  for (const c of candidates) {
    const probe = await probeSidecarIdentity(c.baseUrl, expect, input.fetchImpl);
    if (probe.ok) {
      if (c.basis === 'observed') {
        logger.warn(
          `Sidecar reachable at observed address but NOT at the address it advertised — ` +
          `routing to ${c.baseUrl} instead of ${advertised}. ` +
          `EXTERNAL_IP is not needed for this host; if it is set, it is stale.`,
          { advertised, observed: c.baseUrl },
        );
      }
      return remember(key, { baseUrl: c.baseUrl, hostname: c.hostname, basis: c.basis, decidedAt: now, note });
    }
    if (c.basis === 'advertised') note = `advertised:${probe.reason}`;
    else note = `${note ?? ''} observed:${probe.reason}`.trim();
  }

  // Nothing answered. Keep today's behaviour rather than dropping the host: the
  // sidecar may be mid-restart, or reachable only over the WS tunnel the master
  // already holds, in which case the advertised address is still the right key.
  logger.warn('No sidecar address answered a probe — falling back to the advertised address', {
    advertised, observedIp: input.observedIp, note,
  });
  return remember(key, { ...fallback, note });
}

interface Candidate { baseUrl: string; hostname: string; basis: Exclude<AddressBasis, 'advertised-unverified'> }

/**
 * Advertised first, always. An operator's `AGENT_URL` / `EXTERNAL_IP` reaches the
 * master as the advertised address and is indistinguishable from a detected one —
 * so trying it first is the only way, without a wire change, to guarantee a
 * working pin is never substituted. (Item 4's `candidates` + a `source` field
 * would let the master honour a pin even when it does *not* answer; that is why
 * item 4 is more than an optimisation.)
 */
function buildCandidates(advertised: string, observedIp?: string): Candidate[] {
  const out: Candidate[] = [];
  const advertisedHost = hostOf(advertised);
  if (advertisedHost) out.push({ baseUrl: advertised, hostname: advertisedHost, basis: 'advertised' });

  if (observedIp && observedIp !== advertisedHost && isUsableObserved(observedIp)) {
    const port = portOf(advertised);
    const host = observedIp.includes(':') ? `[${observedIp}]` : observedIp;
    out.push({
      baseUrl: port ? `http://${host}:${port}` : `http://${host}`,
      hostname: observedIp,
      basis: 'observed',
    });
  }
  return out;
}

/**
 * Loopback and the Docker bridge are never useful as an observed callback target:
 * they describe the master's own side of the connection (a sidecar on the same
 * host, or one reaching a containerised master through its bridge), not an address
 * the rest of the fleet can reach.
 */
function isUsableObserved(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) return false;
  if (ip.startsWith('172.17.') || ip.startsWith('172.18.')) return false;
  return true;
}

function hostOf(u: string): string | undefined {
  try { return new URL(u).hostname; } catch { return undefined; }
}

function portOf(u: string): string | undefined {
  try { return new URL(u).port || undefined; } catch { return undefined; }
}

function remember(key: string, choice: AddressChoice): AddressChoice {
  choices.set(key, { ...choice, key });
  return choice;
}
