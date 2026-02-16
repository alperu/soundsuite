/**
 * FolderIndexService — Redis-based folder count and content caching.
 *
 * Mirrors ExpeDat's FolderIndexService.php:
 *   - Caches folder item counts and full directory listings in Redis
 *   - Tracks access patterns for popularity-based refresh
 *   - Supports staleness detection via mtime hashes and TTL
 *   - Provides warm-up and progressive scan capabilities
 */

import { getRedis, isRedisAvailable } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const logger = createLogger('FolderIndexService');

// Redis key prefixes
const KEYS = {
  COUNTS: 'soundsuite:folder:counts',
  MTIMES: 'soundsuite:folder:mtimes',
  ACCESS: 'soundsuite:folder:access',
  CONTENT: 'soundsuite:folder:content:',
  HASHES: 'soundsuite:folder:hashes',
} as const;

export interface CachedFileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: CachedFileEntry[];
}

export class FolderIndexService {
  private ttl: number;
  private refreshBeforeExpiry: number;

  constructor() {
    this.ttl = parseInt(process.env.FOLDER_INDEX_TTL || '3600', 10);
    this.refreshBeforeExpiry = parseInt(process.env.FOLDER_INDEX_REFRESH_BEFORE_EXPIRY || '300', 10);
  }

  private hashPath(p: string): string {
    const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return normalized || '/';
  }

  private contentKey(p: string): string {
    const hash = crypto.createHash('md5').update(this.hashPath(p)).digest('hex');
    return KEYS.CONTENT + hash;
  }

  // ── Count operations ──────────────────────────────────────────────

  async getCount(folderPath: string): Promise<number | null> {
    try {
      if (!(await isRedisAvailable())) return null;
      const redis = getRedis();
      const val = await redis.hget(KEYS.COUNTS, this.hashPath(folderPath));
      return val !== null ? parseInt(val, 10) : null;
    } catch (e) {
      logger.error('getCount failed', e);
      return null;
    }
  }

  async getCounts(paths: string[]): Promise<Record<string, number | null>> {
    const result: Record<string, number | null> = {};
    if (paths.length === 0) return result;
    try {
      if (!(await isRedisAvailable())) {
        for (const p of paths) result[p] = null;
        return result;
      }
      const redis = getRedis();
      const keys = paths.map(p => this.hashPath(p));
      const vals = await redis.hmget(KEYS.COUNTS, ...keys);
      for (let i = 0; i < paths.length; i++) {
        result[paths[i]] = vals[i] !== null ? parseInt(vals[i]!, 10) : null;
      }
    } catch (e) {
      logger.error('getCounts failed', e);
      for (const p of paths) result[p] = null;
    }
    return result;
  }

  async setCount(folderPath: string, count: number, mtime?: number): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      const key = this.hashPath(folderPath);
      await redis.hset(KEYS.COUNTS, key, count.toString());
      if (mtime !== undefined) {
        await redis.hset(KEYS.MTIMES, key, mtime.toString());
      }
    } catch (e) {
      logger.error('setCount failed', e);
    }
  }

  // ── Content operations ────────────────────────────────────────────

  async getFolderContent(folderPath: string, currentHash?: string): Promise<CachedFileEntry[] | null> {
    try {
      if (!(await isRedisAvailable())) return null;
      const redis = getRedis();
      const key = this.hashPath(folderPath);

      if (currentHash) {
        const storedHash = await redis.hget(KEYS.HASHES, key);
        if (!storedHash || storedHash !== currentHash) return null;
      }

      const compressed = await redis.getBuffer(this.contentKey(folderPath));
      if (!compressed) return null;

      const json = await gunzip(compressed);
      return JSON.parse(json.toString());
    } catch (e) {
      logger.error('getFolderContent failed', e);
      return null;
    }
  }

  async setFolderContent(folderPath: string, entries: CachedFileEntry[], hash: string, ttl?: number): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      const key = this.hashPath(folderPath);
      const effectiveTtl = ttl ?? this.ttl;

      const json = JSON.stringify(entries);
      const compressed = await gzip(json);

      await redis.setex(this.contentKey(folderPath), effectiveTtl, compressed);
      await redis.hset(KEYS.HASHES, key, hash);
    } catch (e) {
      logger.error('setFolderContent failed', e);
    }
  }

  async generateFolderHash(fullPath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(fullPath);
      return crypto.createHash('md5').update(fullPath + ':' + stat.mtimeMs).digest('hex');
    } catch {
      return null;
    }
  }

  // ── Staleness & access tracking ───────────────────────────────────

  async isStale(folderPath: string): Promise<boolean> {
    try {
      if (!(await isRedisAvailable())) return true;
      const redis = getRedis();
      const key = this.hashPath(folderPath);
      const cachedMtime = await redis.hget(KEYS.MTIMES, key);
      if (!cachedMtime) return true;
      const cachedTime = parseInt(cachedMtime, 10);
      return (Date.now() / 1000 - cachedTime) > this.ttl;
    } catch {
      return true;
    }
  }

  async recordAccess(folderPath: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.zadd(KEYS.ACCESS, Date.now() / 1000, this.hashPath(folderPath));
    } catch { /* non-critical */ }
  }

  async getPopularFolders(limit = 100): Promise<string[]> {
    try {
      if (!(await isRedisAvailable())) return [];
      const redis = getRedis();
      return await redis.zrevrange(KEYS.ACCESS, 0, limit - 1);
    } catch {
      return [];
    }
  }

  async getFoldersNeedingRefresh(): Promise<string[]> {
    try {
      if (!(await isRedisAvailable())) return [];
      const redis = getRedis();
      const mtimes = await redis.hgetall(KEYS.MTIMES);
      const threshold = Date.now() / 1000 - (this.ttl - this.refreshBeforeExpiry);
      const result: string[] = [];
      for (const [p, mtime] of Object.entries(mtimes)) {
        if (parseInt(mtime, 10) < threshold) result.push(p);
      }
      return result;
    } catch {
      return [];
    }
  }

  // ── Invalidation ──────────────────────────────────────────────────

  async invalidate(folderPath: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      const key = this.hashPath(folderPath);
      await redis.hdel(KEYS.COUNTS, key);
      await redis.hdel(KEYS.MTIMES, key);
    } catch (e) {
      logger.error('invalidate failed', e);
    }
  }

  async invalidateContent(folderPath: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      const key = this.hashPath(folderPath);
      await redis.del(this.contentKey(folderPath));
      await redis.hdel(KEYS.HASHES, key);
    } catch (e) {
      logger.error('invalidateContent failed', e);
    }
  }

  // ── Filesystem scanning ───────────────────────────────────────────

  async scanAndCacheFolder(relativePath: string, fullPath: string): Promise<void> {
    try {
      const entries = await this.scanDirectory(fullPath);
      const count = entries.length;
      const now = Math.floor(Date.now() / 1000);

      await this.setCount(relativePath, count, now);

      const hash = await this.generateFolderHash(fullPath);
      if (hash) {
        await this.setFolderContent(relativePath, entries, hash);
      }
    } catch (e) {
      logger.error('scanAndCacheFolder failed', e, { relativePath });
    }
  }

  private async scanDirectory(dirPath: string): Promise<CachedFileEntry[]> {
    const entries: CachedFileEntry[] = [];
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
          const children = await this.scanDirectory(fullPath);
          if (children.length > 0) {
            entries.push({ name: item.name, path: fullPath, type: 'folder', children });
          }
        } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
          const stat = await fs.stat(fullPath);
          entries.push({ name: item.name, path: fullPath, type: 'file', size: stat.size });
        }
      }
    } catch { /* skip unreadable dirs */ }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async warmFolder(basePath: string, relativePath = '', depth = 1): Promise<{ scanned: number; cached: number; errors: number }> {
    const stats = { scanned: 0, cached: 0, errors: 0 };
    if (depth <= 0) return stats;

    const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
    try {
      await fs.access(fullPath);
    } catch {
      stats.errors++;
      return stats;
    }

    stats.scanned++;
    try {
      await this.scanAndCacheFolder(relativePath || '/', fullPath);
      stats.cached++;
    } catch {
      stats.errors++;
    }

    if (depth > 1) {
      try {
        const items = await fs.readdir(fullPath, { withFileTypes: true });
        for (const item of items) {
          if (!item.isDirectory() || item.name.startsWith('.')) continue;
          const childRel = relativePath ? relativePath + '/' + item.name : item.name;
          const childStats = await this.warmFolder(basePath, childRel, depth - 1);
          stats.scanned += childStats.scanned;
          stats.cached += childStats.cached;
          stats.errors += childStats.errors;
        }
      } catch {
        stats.errors++;
      }
    }
    return stats;
  }

  // ── Stats & cleanup ───────────────────────────────────────────────

  async getStats(): Promise<{ cachedFolders: number; trackedFolders: number }> {
    try {
      if (!(await isRedisAvailable())) return { cachedFolders: 0, trackedFolders: 0 };
      const redis = getRedis();
      const [cached, tracked] = await Promise.all([
        redis.hlen(KEYS.COUNTS),
        redis.zcard(KEYS.ACCESS),
      ]);
      return { cachedFolders: cached, trackedFolders: tracked };
    } catch {
      return { cachedFolders: 0, trackedFolders: 0 };
    }
  }

  async clearAll(): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.del(KEYS.COUNTS, KEYS.MTIMES, KEYS.ACCESS, KEYS.HASHES);
      // Delete all content keys
      const contentKeys = await redis.keys(KEYS.CONTENT + '*');
      if (contentKeys.length > 0) await redis.del(...contentKeys);
    } catch (e) {
      logger.error('clearAll failed', e);
    }
  }
}
