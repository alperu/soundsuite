/**
 * Master self-identification helpers.
 *
 * The master pushes its canonical URL to every sidecar so the sidecar can
 * persist it and re-establish the link after a container is recreated with a
 * fresh config volume.
 *
 * Resolution order for the canonical URL:
 *   1. process.env.SOUND_SUITE_MASTER_URL
 *   2. Config key `master.url` (settable via /admin)
 *   3. derived-from-recent-request cache (Host header from inbound HTTP hits)
 *
 * Wire shapes are documented in docs/sidecar-master-self-identification.md and
 * MUST stay in sync with the sidecar's consumer code (Agent B).
 *
 *   WS frame (after `registered` ack):
 *     { type: "master-identity",
 *       canonicalUrl: "http://172.16.16.9:3000",
 *       wsPort: 3002,
 *       name?: string,
 *       pushedAt: <epoch ms> }
 *
 *   HTTP header on heartbeat/register replies:
 *     X-Sound-Suite-Master-Url: http://172.16.16.9:3000
 *
 *   Reverse-poll POST (when sidecar lost its config):
 *     POST http://<sidecar-host>:8098/api/masters
 *     Body: { serverUrl: "http://172.16.16.9:3000" }
 */

import { createLogger } from '@/lib/logger';
import { getConfig } from '@/lib/db/config';

const logger = createLogger('MasterIdentity');

const g = globalThis as any;
if (!g.__ss_master_url_cache__) g.__ss_master_url_cache__ = { value: null as string | null, setAt: 0 };
const urlCache: { value: string | null; setAt: number } = g.__ss_master_url_cache__;

/** Cache a URL derived from an inbound HTTP request's Host header. */
export function noteRequestOrigin(origin: string | null | undefined): void {
  if (!origin) return;
  // Only accept full URL with scheme. Filter out obvious garbage.
  if (!/^https?:\/\//i.test(origin)) return;
  urlCache.value = origin.replace(/\/+$/, '');
  urlCache.setAt = Date.now();
}

/**
 * Derive an origin from a NextRequest. Prefers X-Forwarded-Proto/Host
 * (reverse-proxy case) then Host header.
 */
export function deriveOriginFromHeaders(headers: Headers): string | null {
  const xfHost = headers.get('x-forwarded-host');
  const xfProto = headers.get('x-forwarded-proto');
  const host = xfHost || headers.get('host');
  if (!host) return null;
  // Strip any port-stripped malformed entries.
  const proto = (xfProto || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Resolve the canonical master URL or null if unknown. */
export async function getCanonicalMasterUrl(): Promise<string | null> {
  // 1. env
  const env = process.env.SOUND_SUITE_MASTER_URL;
  if (env && /^https?:\/\//i.test(env)) {
    return env.replace(/\/+$/, '');
  }

  // 2. Config DB
  try {
    const cfg = await getConfig();
    if (cfg.masterUrl && /^https?:\/\//i.test(cfg.masterUrl)) {
      return cfg.masterUrl.replace(/\/+$/, '');
    }
  } catch (err) {
    logger.warn('Failed to read masterUrl from config', { error: (err as Error).message });
  }

  // 3. Derived-from-request cache
  if (urlCache.value) return urlCache.value;
  return null;
}

/** Build the master-identity WS frame payload. Returns null if URL unknown. */
export async function buildMasterIdentityFrame(): Promise<{
  type: 'master-identity';
  canonicalUrl: string;
  wsPort: number;
  name?: string;
  pushedAt: number;
} | null> {
  const url = await getCanonicalMasterUrl();
  if (!url) return null;
  const wsPort = parseInt(process.env.GPU_WS_PORT || '3002', 10);
  const name = process.env.SOUND_SUITE_MASTER_NAME || undefined;
  return {
    type: 'master-identity',
    canonicalUrl: url,
    wsPort,
    name,
    pushedAt: Date.now(),
  };
}

/** HTTP response header name for the canonical master URL. */
export const MASTER_URL_HEADER = 'X-Sound-Suite-Master-Url';
