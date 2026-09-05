/**
 * Authentication for `POST /api/mcp/execute` (report N-9 / M-5).
 *
 * The route used to accept every request. With `routed` defaulting to a cloud
 * model, an unauthenticated caller could spend API credit and send case text
 * to a third party.
 *
 * Design constraints (docs/tasks/07-mcp-evidence-quality-v4.md, stream C):
 *  1. Loopback development must keep working with no config change — the
 *     dashboard and the stdio bridge call this route constantly.
 *  2. Non-loopback callers must authenticate, whatever the profile.
 *  3. Fail closed on misconfiguration, legibly.
 *
 * It reuses the `MCP_AUTH_MODE` vocabulary the standalone MCP server already
 * defines (`none` | `apikey` | `oauth`, see `mcp-server.ts`) and the same two
 * credential headers (`Authorization: Bearer …`, which the bridge sends, and
 * `X-API-Key`).
 *
 * **Loopback detection is a heuristic.** There is no socket-level peer address
 * inside a Next.js route handler, so origin is derived from the request URL /
 * `Host` / `X-Forwarded-For`, all of which a client that can already reach the
 * port may forge. It stops browser-driven cross-origin and tunnelled traffic
 * (neither can set `Host`), not a determined direct attacker. The real
 * exposure controls remain binding the server to loopback and the Cloudflare
 * ingress interlock.
 */

import type { McpProfile } from './research-types';

export type McpAuthMode = 'none' | 'apikey' | 'oauth';

export const MCP_AUTH_MODES: readonly McpAuthMode[] = ['none', 'apikey', 'oauth'] as const;

export type RequestOrigin = 'loopback' | 'remote';

export interface ExecuteAuthDecision {
  ok: boolean;
  status?: number;
  code?: 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'AUTH_MISCONFIGURED';
  message?: string;
  /** Origin the request was classified as — logged, and useful in tests. */
  origin: RequestOrigin;
  /** Normalised mode, or `null` when `MCP_AUTH_MODE` could not be parsed. */
  mode: McpAuthMode | null;
}

/** `MCP_AUTH_STRICT_LOOPBACK` — opt-in tightening of the loopback allowance. */
export type StrictLoopback = 'off' | 'all' | 'routed';

export function parseStrictLoopback(raw: string | undefined): StrictLoopback {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'routed') return 'routed';
  if (v === '1' || v === 'true' || v === 'yes' || v === 'all') return 'all';
  return 'off';
}

/**
 * Normalise `MCP_AUTH_MODE`. Empty / unset is `none` (the shipped default);
 * anything else unrecognised is `null`, which the decision treats as a
 * misconfiguration rather than silently picking a mode.
 */
export function normalizeAuthMode(raw: string | undefined): McpAuthMode | null {
  const v = (raw ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!v) return 'none';
  return (MCP_AUTH_MODES as readonly string[]).includes(v) ? (v as McpAuthMode) : null;
}

const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/** Is this host / IP literal loopback? Strips a port and IPv6 brackets. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  let h = (host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('[')) {
    h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  } else if (h.includes(':') && h.split(':').length === 2) {
    h = h.split(':')[0]; // host:port (IPv4 or name)
  }
  if (LOOPBACK_NAMES.has(h)) return true;
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice('::ffff:'.length));
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

export interface OriginSignals {
  /** `request.nextUrl.hostname` — always present, in tests and in production. */
  urlHostname?: string | null;
  hostHeader?: string | null;
  forwardedFor?: string | null;
  realIp?: string | null;
}

/**
 * Classify the request origin. Any signal that names a non-loopback peer wins:
 * a proxied or tunnelled request carries the public host and the client IP,
 * so it is remote even though the TCP peer is 127.0.0.1.
 */
export function classifyOrigin(signals: OriginSignals): RequestOrigin {
  const firstHop = signals.forwardedFor?.split(',')[0]?.trim();
  if (firstHop && !isLoopbackHost(firstHop)) return 'remote';
  if (signals.realIp?.trim() && !isLoopbackHost(signals.realIp)) return 'remote';
  if (signals.hostHeader?.trim() && !isLoopbackHost(signals.hostHeader)) return 'remote';
  if (signals.urlHostname?.trim() && !isLoopbackHost(signals.urlHostname)) return 'remote';
  // Nothing identifies a remote peer. Only claim loopback if some signal
  // positively says so; a request with no host information at all is remote.
  const anyLoopback =
    isLoopbackHost(firstHop) ||
    isLoopbackHost(signals.realIp) ||
    isLoopbackHost(signals.hostHeader) ||
    isLoopbackHost(signals.urlHostname);
  return anyLoopback ? 'loopback' : 'remote';
}

/** Pull the presented credential from either supported header. */
export function extractCredential(headers: {
  authorization?: string | null;
  apiKey?: string | null;
}): string | null {
  const apiKey = headers.apiKey?.trim();
  if (apiKey) return apiKey;
  const auth = headers.authorization?.trim();
  if (!auth) return null;
  // Accept a bare token too — but `Bearer` with nothing after it is not one.
  const token = auth.replace(/^Bearer\b\s*/i, '').trim();
  return token || null;
}

export interface ExecuteAuthInput {
  origin: RequestOrigin;
  /** Raw `MCP_AUTH_MODE` value, unnormalised. */
  modeRaw: string | undefined;
  /** Configured API keys, from env and/or the `mcp.apiKeys` config row. */
  keys: string[];
  /** Credential the caller presented, or `null`. */
  credential: string | null;
  strictLoopback: StrictLoopback;
  profile: McpProfile;
}

/**
 * The whole auth matrix, as one pure function.
 *
 * | origin   | mode              | keys | credential | result |
 * |----------|-------------------|------|------------|--------|
 * | any      | unparseable       | —    | —          | 401 AUTH_MISCONFIGURED |
 * | loopback | any               | 0    | anything   | allow (credential ignored — nothing to check it against) |
 * | loopback | any               | ≥1   | none       | allow |
 * | loopback | any               | ≥1   | valid      | allow |
 * | loopback | any               | ≥1   | invalid    | 401 AUTH_FAILED |
 * | remote   | any               | 0    | —          | 401 AUTH_REQUIRED (no keys configured) |
 * | remote   | any               | ≥1   | none       | 401 AUTH_REQUIRED |
 * | remote   | any               | ≥1   | valid      | allow |
 * | remote   | any               | ≥1   | invalid    | 401 AUTH_FAILED |
 *
 * `MCP_AUTH_STRICT_LOOPBACK=1` makes loopback behave exactly like remote;
 * `=routed` does so only for `routed` calls (the ones that spend money).
 */
export function decideExecuteAuth(input: ExecuteAuthInput): ExecuteAuthDecision {
  const mode = normalizeAuthMode(input.modeRaw);
  if (mode === null) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_MISCONFIGURED',
      origin: input.origin,
      mode: null,
      message:
        `MCP_AUTH_MODE is set to "${(input.modeRaw ?? '').trim()}", which is not one of ` +
        `${MCP_AUTH_MODES.join(' | ')}. Refusing every request until it is corrected (fail-closed).`,
    };
  }

  const strict =
    input.strictLoopback === 'all' ||
    (input.strictLoopback === 'routed' && input.profile === 'routed');
  const enforced = input.origin === 'remote' || strict;

  if (!enforced) {
    // Loopback allowance. A presented credential is still checked when keys
    // exist, so a wrong key never silently "works"; with no keys configured
    // the credential is ignored (the bridge sends MCP_API_KEY unconditionally).
    if (input.keys.length > 0 && input.credential && !input.keys.includes(input.credential)) {
      return {
        ok: false,
        status: 401,
        code: 'AUTH_FAILED',
        origin: input.origin,
        mode,
        message: `Invalid API key (MCP_AUTH_MODE=${mode}).`,
      };
    }
    return { ok: true, origin: input.origin, mode };
  }

  const why = input.origin === 'remote' ? 'Non-loopback request' : `Loopback request under MCP_AUTH_STRICT_LOOPBACK`;

  if (input.keys.length === 0) {
    const oauthNote =
      mode === 'oauth'
        ? ' OAuth bearer tokens are not verified on this route, so `oauth` alone authenticates nothing here;'
        : '';
    return {
      ok: false,
      status: 401,
      code: 'AUTH_REQUIRED',
      origin: input.origin,
      mode,
      message:
        `${why} refused: MCP_AUTH_MODE=${mode} and no API keys are configured.${oauthNote} ` +
        'set MCP_API_KEYS (comma-separated) or the `mcp.apiKeys` config row, and send the key as ' +
        '`Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    };
  }

  if (!input.credential) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_REQUIRED',
      origin: input.origin,
      mode,
      message:
        `${why} refused: missing credential (MCP_AUTH_MODE=${mode}). ` +
        'Send `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    };
  }

  if (!input.keys.includes(input.credential)) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_FAILED',
      origin: input.origin,
      mode,
      message: `Invalid API key (MCP_AUTH_MODE=${mode}).`,
    };
  }

  return { ok: true, origin: input.origin, mode };
}

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

function splitKeys(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((k) => String(k).trim()).filter(Boolean);
    } catch {
      /* fall through to the delimiter split */
    }
  }
  return trimmed
    .split(/[,\s]+/)
    .map((k) => k.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

let _keyCache: { at: number; keys: string[] } | null = null;
const KEY_CACHE_MS = 30_000;

/** Test hook — drop the cached API-key set. */
export function resetMcpApiKeyCache(): void {
  _keyCache = null;
}

/**
 * Configured API keys: `MCP_API_KEYS` / `MCP_API_KEY` from the environment,
 * plus the `mcp.apiKeys` config row the auth test script already expects.
 * Cached 30 s; a database failure degrades to the env keys.
 */
export async function loadMcpApiKeys(): Promise<string[]> {
  const now = Date.now();
  if (_keyCache && now - _keyCache.at < KEY_CACHE_MS) return _keyCache.keys;

  const keys = new Set<string>([
    ...splitKeys(process.env.MCP_API_KEYS),
    ...splitKeys(process.env.MCP_API_KEY),
  ]);

  try {
    const { prisma } = await import('../db/prisma');
    const row = await prisma.config.findUnique({ where: { key: 'mcp.apiKeys' } });
    for (const k of splitKeys(row?.value)) keys.add(k);
  } catch {
    // No database (or no Config row) — env keys stand on their own.
  }

  const list = [...keys];
  _keyCache = { at: now, keys: list };
  return list;
}
