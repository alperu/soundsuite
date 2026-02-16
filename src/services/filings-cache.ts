/**
 * FilingsCacheService — Redis-based caching for filings and case file data.
 *
 * Cache key structure:
 *   soundsuite:case:{caseId}:filings       — cached filings list for a case
 *   soundsuite:case:{caseId}:files         — cached file tree for a case
 *   soundsuite:court:{courtId}:filings     — cached filings grouped by court/jurisdiction
 *   soundsuite:cache:stats                 — cache hit/miss counters
 *
 * Features:
 *   - TTL-based expiration (configurable via FILINGS_CACHE_TTL env var)
 *   - Graceful degradation when Redis is unavailable
 *   - Cache invalidation on file add/remove/modify events
 *   - Cache warming on startup
 *   - Cache stats for health endpoint
 */

import { getRedis, isRedisAvailable } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const logger = createLogger('FilingsCacheService');

const KEYS = {
  CASE_FILINGS: 'soundsuite:case:',       // + {caseId}:filings
  CASE_FILES: 'soundsuite:case:',          // + {caseId}:files
  COURT_FILINGS: 'soundsuite:court:',      // + {courtId}:filings
  STATS: 'soundsuite:cache:stats',
} as const;

function caseFilingsKey(caseId: string): string {
  return `${KEYS.CASE_FILINGS}${caseId}:filings`;
}

function caseFilesKey(caseId: string): string {
  return `${KEYS.CASE_FILES}${caseId}:files`;
}

function courtFilingsKey(courtId: string): string {
  return `${KEYS.COURT_FILINGS}${courtId}:filings`;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: string;
  cachedCases: number;
  cachedCourts: number;
  available: boolean;
}

export class FilingsCacheService {
  private ttl: number;

  constructor() {
    this.ttl = parseInt(process.env.FILINGS_CACHE_TTL || '300', 10); // 5 min default
  }

  // ── Filings per case ────────────────────────────────────────────

  async getCaseFilings(caseId: string): Promise<unknown[] | null> {
    try {
      if (!(await isRedisAvailable())) return null;
      const redis = getRedis();
      const raw = await redis.get(caseFilingsKey(caseId));
      if (!raw) {
        await this.recordMiss();
        return null;
      }
      await this.recordHit();
      return JSON.parse(raw);
    } catch (e) {
      logger.error('getCaseFilings failed', e);
      return null;
    }
  }

  async setCaseFilings(caseId: string, filings: unknown[]): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.setex(caseFilingsKey(caseId), this.ttl, JSON.stringify(filings));
    } catch (e) {
      logger.error('setCaseFilings failed', e);
    }
  }

  async invalidateCaseFilings(caseId: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.del(caseFilingsKey(caseId));
      logger.debug('Invalidated case filings cache', { caseId });
    } catch (e) {
      logger.error('invalidateCaseFilings failed', e);
    }
  }

  // ── Files per case ──────────────────────────────────────────────

  async getCaseFiles(caseId: string): Promise<unknown | null> {
    try {
      if (!(await isRedisAvailable())) return null;
      const redis = getRedis();
      const raw = await redis.get(caseFilesKey(caseId));
      if (!raw) {
        await this.recordMiss();
        return null;
      }
      await this.recordHit();
      return JSON.parse(raw);
    } catch (e) {
      logger.error('getCaseFiles failed', e);
      return null;
    }
  }

  async setCaseFiles(caseId: string, data: unknown): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.setex(caseFilesKey(caseId), this.ttl, JSON.stringify(data));
    } catch (e) {
      logger.error('setCaseFiles failed', e);
    }
  }

  async invalidateCaseFiles(caseId: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.del(caseFilesKey(caseId));
      logger.debug('Invalidated case files cache', { caseId });
    } catch (e) {
      logger.error('invalidateCaseFiles failed', e);
    }
  }

  // ── Filings per court ───────────────────────────────────────────

  async getCourtFilings(courtId: string): Promise<unknown[] | null> {
    try {
      if (!(await isRedisAvailable())) return null;
      const redis = getRedis();
      const raw = await redis.get(courtFilingsKey(courtId));
      if (!raw) {
        await this.recordMiss();
        return null;
      }
      await this.recordHit();
      return JSON.parse(raw);
    } catch (e) {
      logger.error('getCourtFilings failed', e);
      return null;
    }
  }

  async setCourtFilings(courtId: string, filings: unknown[]): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.setex(courtFilingsKey(courtId), this.ttl, JSON.stringify(filings));
    } catch (e) {
      logger.error('setCourtFilings failed', e);
    }
  }

  async invalidateCourtFilings(courtId: string): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.del(courtFilingsKey(courtId));
    } catch (e) {
      logger.error('invalidateCourtFilings failed', e);
    }
  }

  // ── Invalidate all caches for a case ────────────────────────────

  async invalidateCase(caseId: string): Promise<void> {
    await Promise.all([
      this.invalidateCaseFilings(caseId),
      this.invalidateCaseFiles(caseId),
    ]);
  }

  // ── Invalidate by file path (used by FileWatcher) ──────────────

  async invalidateByFilePath(filePath: string, caseId: string): Promise<void> {
    await this.invalidateCase(caseId);
    logger.debug('Invalidated cache for file change', { filePath, caseId });
  }

  // ── Cache warming ──────────────────────────────────────────────

  async warmCaseFilings(
    caseId: string,
    fetchFilings: () => Promise<unknown[]>
  ): Promise<void> {
    try {
      const filings = await fetchFilings();
      await this.setCaseFilings(caseId, filings);
      logger.debug('Warmed filings cache', { caseId, count: filings.length });
    } catch (e) {
      logger.error('warmCaseFilings failed', e);
    }
  }

  // ── Stats ──────────────────────────────────────────────────────

  private async recordHit(): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.hincrby(KEYS.STATS, 'hits', 1);
    } catch { /* non-critical */ }
  }

  private async recordMiss(): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.hincrby(KEYS.STATS, 'misses', 1);
    } catch { /* non-critical */ }
  }

  async getStats(): Promise<CacheStats> {
    const unavailable: CacheStats = {
      hits: 0,
      misses: 0,
      hitRate: '0%',
      cachedCases: 0,
      cachedCourts: 0,
      available: false,
    };

    try {
      if (!(await isRedisAvailable())) return unavailable;
      const redis = getRedis();

      const [hitsRaw, missesRaw] = await Promise.all([
        redis.hget(KEYS.STATS, 'hits'),
        redis.hget(KEYS.STATS, 'misses'),
      ]);
      const hits = parseInt(hitsRaw || '0', 10);
      const misses = parseInt(missesRaw || '0', 10);
      const total = hits + misses;
      const hitRate = total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '0%';

      // Count cached cases and courts by scanning keys
      const caseKeys = await redis.keys('soundsuite:case:*:filings');
      const courtKeys = await redis.keys('soundsuite:court:*:filings');

      return {
        hits,
        misses,
        hitRate,
        cachedCases: caseKeys.length,
        cachedCourts: courtKeys.length,
        available: true,
      };
    } catch {
      return unavailable;
    }
  }

  async resetStats(): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      await redis.del(KEYS.STATS);
    } catch { /* non-critical */ }
  }

  async clearAll(): Promise<void> {
    try {
      if (!(await isRedisAvailable())) return;
      const redis = getRedis();
      const patterns = [
        'soundsuite:case:*:filings',
        'soundsuite:case:*:files',
        'soundsuite:court:*:filings',
      ];
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) await redis.del(...keys);
      }
      await redis.del(KEYS.STATS);
      logger.info('Cleared all filings cache');
    } catch (e) {
      logger.error('clearAll failed', e);
    }
  }
}
