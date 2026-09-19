/**
 * Redis client singleton using ioredis.
 *
 * Connects to Redis using REDIS_HOST / REDIS_PORT / REDIS_PASSWORD from .env.
 * Falls back to 127.0.0.1:6379 with no password.
 *
 * Usage:
 *   import { getRedis, isRedisAvailable } from '@/lib/redis';
 *   const redis = getRedis();
 */

import Redis from 'ioredis';
import { createLogger } from './logger';
import { activeProfileName, LEGACY_PROFILE } from './profiles/registry';

const logger = createLogger('Redis');

let instance: Redis | null = null;
let instanceProfile: string | null = null;
let available: boolean | null = null;

/**
 * Key prefix for the active profile. Every key this process writes through
 * `getRedis()` — filings cache, classifier cache, queue state — is namespaced
 * so a Demo profile never reads Alper's cached filings. The legacy profile
 * (no profiles on disk yet) keeps the historical unprefixed keys.
 *
 * ioredis applies `keyPrefix` to command KEYS only; pub/sub channel names
 * (`soundsuite:doc_status`) are left alone, which is what the SSE relays
 * want — a status event carries its documentId and is harmless across
 * profiles, and prefixing only one side of a subscribe/publish pair would
 * silently drop every event.
 */
export function redisKeyPrefix(profile = activeProfileName()): string {
  return profile === LEGACY_PROFILE ? '' : `p:${profile}:`;
}

/**
 * Get (or create) the shared ioredis instance for the ACTIVE profile.
 * Lazy-connects on first call; a profile switch gets a fresh client with the
 * new prefix (the old one is quit by `disconnectRedis`).
 */
export function getRedis(): Redis {
  const profile = activeProfileName();
  if (instance && instanceProfile === profile) return instance;
  if (instance) {
    const stale = instance;
    instance = null;
    stale.quit().catch(() => {});
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  instanceProfile = profile;
  instance = new Redis({
    host,
    port,
    password,
    keyPrefix: redisKeyPrefix(profile),
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null; // stop retrying after 5 attempts
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  instance.on('connect', () => {
    available = true;
    logger.info('Connected', { host, port });
  });

  instance.on('error', (err) => {
    available = false;
    logger.error('Connection error', err);
  });

  instance.on('close', () => {
    available = false;
  });

  // Trigger the connection
  instance.connect().catch(() => {
    available = false;
  });

  return instance;
}

/**
 * Check if Redis is currently connected.
 */
export async function isRedisAvailable(): Promise<boolean> {
  if (available === false) return false;
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    available = pong === 'PONG';
    return available;
  } catch {
    available = false;
    return false;
  }
}

/**
 * Disconnect the Redis client (for graceful shutdown).
 */
export async function disconnectRedis(): Promise<void> {
  if (instance) {
    const stale = instance;
    instance = null;
    instanceProfile = null;
    available = null;
    await stale.quit().catch(() => {});
  }
}
