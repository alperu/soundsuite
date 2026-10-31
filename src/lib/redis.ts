/**
 * Redis client singleton using ioredis.
 *
 * Connects to Redis using REDIS_URL (redis://[:password@]host:port[/db]) when
 * set, else REDIS_HOST / REDIS_PORT / REDIS_PASSWORD. REDIS_HOST/REDIS_PORT win
 * over the URL when both are set. Falls back to 127.0.0.1:6379, no password.
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
export interface RedisConnOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

/** Connection options from env. See the module header for the order. */
export function redisOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConnOptions {
  let url: URL | null = null;
  if (env.REDIS_URL) {
    try {
      url = new URL(env.REDIS_URL);
    } catch {
      logger.warn('Ignoring invalid REDIS_URL', { REDIS_URL: env.REDIS_URL });
    }
  }
  const host = env.REDIS_HOST || url?.hostname || '127.0.0.1';
  const port = parseInt(env.REDIS_PORT || url?.port || '6379', 10);
  const password = env.REDIS_PASSWORD || (url?.password ? decodeURIComponent(url.password) : undefined) || undefined;
  const dbPath = url?.pathname?.replace(/^\//, '');
  const db = dbPath ? parseInt(dbPath, 10) : undefined;
  return { host, port, password, ...(db !== undefined && !Number.isNaN(db) ? { db } : {}) };
}

export function getRedis(): Redis {
  if (instance) return instance;

  const { host, port, password, db } = redisOptionsFromEnv();

  instance = new Redis({
    host,
    port,
    password,
    db,
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
