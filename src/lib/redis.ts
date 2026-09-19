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

const logger = createLogger('Redis');

let instance: Redis | null = null;
let available: boolean | null = null;

/**
 * Redis is NOT partitioned by profile (docs/tasks/56-system-db.md).
 *
 * A first cut prefixed every key with the active profile. That broke the GPU
 * fleet: the sidecar command queue, heartbeats and poll state are machine
 * state, and a switch mid-command orphaned the queue. It also bought nothing
 * for case data — every cached key is rooted in a UUID (case id, document id,
 * chat id) and a profile's ids never collide with another's, since a new
 * profile copies the schema, never rows. The one real overlap, the
 * filename-keyed classifier cache, yields the same answer for the same file.
 */
export function getRedis(): Redis {
  if (instance) return instance;

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  instance = new Redis({
    host,
    port,
    password,
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
    available = null;
    await stale.quit().catch(() => {});
  }
}
