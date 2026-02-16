/**
 * WorkerPoolService — PID-controlled dynamic worker allocation.
 *
 * Manages a pool of virtual workers split between UI (real-time folder requests)
 * and Background (pre-caching, stale refresh, full scan) tasks.
 *
 * A PID controller monitors UI queue depth and request rate, dynamically
 * shifting workers between pools. When UI demand spikes, workers shift to UI.
 * When idle, workers shift to background pre-caching.
 *
 * Port of ExpeDat's WorkerPoolService.php to TypeScript/ioredis.
 */

import { getRedis, isRedisAvailable } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import type { FolderIndexService } from './folder-index-service';

const logger = createLogger('WorkerPoolService');

const KEYS = {
  STATE: 'soundsuite:workers:state',
  UI_QUEUE: 'soundsuite:workers:ui_queue',
  BG_QUEUE: 'soundsuite:workers:bg_queue',
  METRICS: 'soundsuite:workers:metrics',
  PID_STATE: 'soundsuite:workers:pid_state',
  UI_RATE: 'soundsuite:workers:ui_rate',
  UI_PENDING: 'soundsuite:workers:ui_pending',
  STOP: 'soundsuite:workers:stop',
  SCAN_PROGRESS: 'soundsuite:workers:scan_progress',
} as const;

export interface WorkerPoolState {
  totalWorkers: number;
  uiWorkers: number;
  bgWorkers: number;
  uiQueueDepth: number;
  bgQueueDepth: number;
  uiRequestRate: number;
  startedAt: number;
  lastUpdate: number;
  pid: {
    integral: number;
    prevError: number;
    idleCycles: number;
    kp: number;
    ki: number;
    kd: number;
  };
  metrics: {
    uiRequestsTotal: number;
    uiRequestsProcessed: number;
    bgTasksTotal: number;
    bgTasksProcessed: number;
    pidAdjustments: number;
    documentsParsed: number;
  };
  scan: {
    startedAt: number;
    complete: boolean;
    lastPath: string;
    foldersQueued: number;
    documentsQueued: number;
  };
  /** Number of QUEUED documents waiting to be parsed */
  documentBacklog: number;
}

export class WorkerPoolService {
  private totalWorkers: number;
  private minUiWorkers: number;
  private minBgWorkers: number;
  private kp: number;
  private ki: number;
  private kd: number;

  constructor(opts?: { totalWorkers?: number; minUiWorkers?: number; minBgWorkers?: number; kp?: number; ki?: number; kd?: number }) {
      this.totalWorkers = opts?.totalWorkers ?? parseInt(process.env.WORKER_POOL_SIZE || '20', 10);
      this.minUiWorkers = opts?.minUiWorkers ?? parseInt(process.env.MIN_UI_WORKERS || '3', 10);
      this.minBgWorkers = opts?.minBgWorkers ?? parseInt(process.env.MIN_BG_WORKERS || '2', 10);
      this.kp = opts?.kp ?? parseFloat(process.env.PID_KP || '2.0');
      this.ki = opts?.ki ?? parseFloat(process.env.PID_KI || '0.5');
      this.kd = opts?.kd ?? parseFloat(process.env.PID_KD || '0.1');
    }

    /**
     * Create a WorkerPoolService with settings loaded from the database.
     * Falls back to env vars / defaults if DB is unavailable.
     */
    static async fromConfig(): Promise<WorkerPoolService> {
      try {
        const { getConfig } = await import('@/lib/db/config');
        const cfg = await getConfig();
        return new WorkerPoolService({
          totalWorkers: cfg.workerPoolSize,
          minUiWorkers: cfg.minUiWorkers,
          minBgWorkers: cfg.minBgWorkers,
          kp: cfg.pidKp,
          ki: cfg.pidKi,
          kd: cfg.pidKd,
        });
      } catch {
        return new WorkerPoolService();
      }
    }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    const redis = getRedis();
    const exists = await redis.exists(KEYS.STATE);
    if (exists) return;

    const initialUi = Math.max(this.minUiWorkers, Math.floor(this.totalWorkers * 0.2));
    const initialBg = this.totalWorkers - initialUi;

    await redis.hset(KEYS.STATE, {
      total_workers: this.totalWorkers,
      ui_workers: initialUi,
      bg_workers: initialBg,
      started_at: Math.floor(Date.now() / 1000),
      last_update: Math.floor(Date.now() / 1000),
    });

    await redis.hset(KEYS.PID_STATE, {
      integral: 0,
      prev_error: 0,
      last_update: Date.now(),
      idle_cycles: 0,
    });

    await redis.hset(KEYS.METRICS, {
      ui_requests_total: 0,
      ui_requests_processed: 0,
      bg_tasks_total: 0,
      bg_tasks_processed: 0,
      pid_adjustments: 0,
      documents_parsed: 0,
    });

    logger.info('Initialized worker pool', { ui: initialUi, bg: initialBg, total: this.totalWorkers });
  }
  /**
   * Apply updated config to the running pool state in Redis.
   * Called after saving config from the admin UI.
   */
  async applyConfig(): Promise<void> {
    const redis = getRedis();
    const state = await redis.hgetall(KEYS.STATE);
    if (!state.total_workers) {
      // Not initialized yet, just initialize fresh
      await redis.del(KEYS.STATE);
      await this.initialize();
      return;
    }

    const oldTotal = parseInt(state.total_workers, 10);
    if (oldTotal !== this.totalWorkers) {
      // Rebalance: keep the same UI/BG ratio but scale to new total
      const oldUi = parseInt(state.ui_workers || '0', 10);
      const ratio = oldTotal > 0 ? oldUi / oldTotal : 0.2;
      const newUi = Math.max(this.minUiWorkers, Math.min(this.totalWorkers - this.minBgWorkers, Math.round(ratio * this.totalWorkers)));
      const newBg = this.totalWorkers - newUi;

      await redis.hset(KEYS.STATE, {
        total_workers: this.totalWorkers,
        ui_workers: newUi,
        bg_workers: newBg,
        last_update: Math.floor(Date.now() / 1000),
      });

      logger.info('Applied pool config', { oldTotal, newTotal: this.totalWorkers, ui: newUi, bg: newBg });
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  async getState(): Promise<WorkerPoolState> {
    const redis = getRedis();

    const [state, pidState, metrics] = await Promise.all([
      redis.hgetall(KEYS.STATE),
      redis.hgetall(KEYS.PID_STATE),
      redis.hgetall(KEYS.METRICS),
    ]);

    const uiQueueDepth = await redis.llen(KEYS.UI_QUEUE) || 0;
    const bgQueueDepth = await redis.llen(KEYS.BG_QUEUE) || 0;
    const uiRequestRate = await this.getRequestRate();
    const scan = await this.getScanProgress();

    // Count QUEUED documents as backlog
    let documentBacklog = 0;
    try {
      const { prisma } = await import('@/lib/db/prisma');
      documentBacklog = await (prisma as any).document.count({ where: { status: 'QUEUED' } });
    } catch { /* prisma not available */ }

    return {
      totalWorkers: parseInt(state.total_workers || String(this.totalWorkers), 10),
      uiWorkers: parseInt(state.ui_workers || String(this.minUiWorkers), 10),
      bgWorkers: parseInt(state.bg_workers || String(this.totalWorkers - this.minUiWorkers), 10),
      uiQueueDepth,
      bgQueueDepth,
      uiRequestRate,
      startedAt: parseInt(state.started_at || '0', 10),
      lastUpdate: parseInt(state.last_update || '0', 10),
      pid: {
        integral: parseFloat(pidState.integral || '0'),
        prevError: parseFloat(pidState.prev_error || '0'),
        idleCycles: parseInt(pidState.idle_cycles || '0', 10),
        kp: this.kp,
        ki: this.ki,
        kd: this.kd,
      },
      metrics: {
        uiRequestsTotal: parseInt(metrics.ui_requests_total || '0', 10),
        uiRequestsProcessed: parseInt(metrics.ui_requests_processed || '0', 10),
        bgTasksTotal: parseInt(metrics.bg_tasks_total || '0', 10),
        bgTasksProcessed: parseInt(metrics.bg_tasks_processed || '0', 10),
        pidAdjustments: parseInt(metrics.pid_adjustments || '0', 10),
        documentsParsed: parseInt(metrics.documents_parsed || '0', 10),
      },
      scan,
      documentBacklog,
    };
  }

  // ---------------------------------------------------------------------------
  // Request rate tracking
  // ---------------------------------------------------------------------------

  async recordRequestTime(): Promise<void> {
    const redis = getRedis();
    const now = Date.now();
    await redis.zadd(KEYS.UI_RATE, now, String(now));
    // Remove entries older than 60 seconds
    await redis.zremrangebyscore(KEYS.UI_RATE, 0, now - 60_000);
    await redis.expire(KEYS.UI_RATE, 120);
  }

  async getRequestRate(windowSeconds = 10): Promise<number> {
    const redis = getRedis();
    const now = Date.now();
    const count = await redis.zcount(KEYS.UI_RATE, now - windowSeconds * 1000, now);
    return windowSeconds > 0 ? Math.round((count / windowSeconds) * 100) / 100 : 0;
  }

  // ---------------------------------------------------------------------------
  // PID Controller
  // ---------------------------------------------------------------------------

  async runPidController(): Promise<{
    uiWorkers: number;
    bgWorkers: number;
    adjustment: number;
    error: number;
    integral: number;
    derivative: number;
    output: number;
  }> {
    const redis = getRedis();

    const uiQueueDepth = (await redis.llen(KEYS.UI_QUEUE)) || 0;
    const requestRate = await this.getRequestRate(10);

    const state = await redis.hgetall(KEYS.STATE);
    const currentUi = parseInt(state.ui_workers || String(this.minUiWorkers), 10);

    const pidState = await redis.hgetall(KEYS.PID_STATE);
    let integral = parseFloat(pidState.integral || '0');
    const prevError = parseFloat(pidState.prev_error || '0');
    const lastUpdate = parseFloat(pidState.last_update || String(Date.now()));
    let idleCycles = parseInt(pidState.idle_cycles || '0', 10);

    const now = Date.now();
    const dt = Math.max(0.001, (now - lastUpdate) / 1000); // seconds

    // Calculate error based on queue depth AND request rate
    let error: number;
    if (uiQueueDepth === 0) {
      const workersNeeded = Math.max(this.minUiWorkers, Math.ceil(requestRate * 2));
      const excessWorkers = currentUi - workersNeeded;

      if (excessWorkers > 0) {
        error = -excessWorkers * 0.5;
        idleCycles++;
        if (idleCycles > 3) {
          error = -excessWorkers;
        }
        integral *= 0.9; // decay integral when idle
      } else {
        error = 0;
        idleCycles = 0;
      }
    } else {
      error = uiQueueDepth;
      idleCycles = 0;
    }

    // PID calculation
    integral += error * dt;

    // Anti-windup clamp
    const maxIntegral = 20 / Math.max(0.1, this.ki);
    integral = Math.max(-maxIntegral, Math.min(maxIntegral, integral));

    // Aggressive integral reset on sign change
    if ((prevError > 0 && error < 0) || (prevError < 0 && error > 0)) {
      integral *= 0.3;
    }

    const derivative = (error - prevError) / dt;
    const output = (this.kp * error) + (this.ki * integral) + (this.kd * derivative);

    // Calculate new UI worker count
    const targetUi = currentUi + Math.round(output);
    const maxUi = this.totalWorkers - this.minBgWorkers;
    const newUi = Math.max(this.minUiWorkers, Math.min(maxUi, targetUi));
    const newBg = this.totalWorkers - newUi;

    // Update state
    await redis.hset(KEYS.STATE, {
      ui_workers: newUi,
      bg_workers: newBg,
      last_update: Math.floor(Date.now() / 1000),
    });

    await redis.hset(KEYS.PID_STATE, {
      integral,
      prev_error: error,
      last_update: now,
      idle_cycles: idleCycles,
    });

    if (newUi !== currentUi) {
      await redis.hincrby(KEYS.METRICS, 'pid_adjustments', 1);
    }

    return { uiWorkers: newUi, bgWorkers: newBg, adjustment: newUi - currentUi, error, integral, derivative, output };
  }

  // ---------------------------------------------------------------------------
  // UI Queue
  // ---------------------------------------------------------------------------

  async queueUiRequest(data: Record<string, unknown>): Promise<void> {
    const redis = getRedis();
    await redis.rpush(KEYS.UI_QUEUE, JSON.stringify({ data, queued_at: Date.now() }));
    await redis.hincrby(KEYS.METRICS, 'ui_requests_total', 1);
    await this.recordRequestTime();
  }

  async queueUiRequestsDeduped(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const redis = getRedis();
    let queued = 0;

    for (const path of paths) {
      const isPending = await redis.sismember(KEYS.UI_PENDING, path);
      if (isPending) continue;

      await redis.sadd(KEYS.UI_PENDING, path);
      await redis.expire(KEYS.UI_PENDING, 30);

      await redis.rpush(KEYS.UI_QUEUE, JSON.stringify({
        data: { type: 'folder_count', path, requested_at: Date.now() },
        queued_at: Date.now(),
      }));
      queued++;
    }

    if (queued > 0) {
      await redis.hincrby(KEYS.METRICS, 'ui_requests_total', queued);
      for (let i = 0; i < queued; i++) {
        await this.recordRequestTime();
      }
    }

    return queued;
  }

  async getNextUiRequest(): Promise<{ data: Record<string, unknown>; queued_at: number } | null> {
    const redis = getRedis();
    const item = await redis.lpop(KEYS.UI_QUEUE);
    if (!item) return null;

    await redis.hincrby(KEYS.METRICS, 'ui_requests_processed', 1);
    const decoded = JSON.parse(item);

    // Remove from pending set
    if (decoded.data?.path) {
      await redis.srem(KEYS.UI_PENDING, decoded.data.path);
    }

    return decoded;
  }

  // ---------------------------------------------------------------------------
  // Background Queue
  // ---------------------------------------------------------------------------

  async queueBackgroundTask(data: Record<string, unknown>): Promise<void> {
    const redis = getRedis();
    await redis.rpush(KEYS.BG_QUEUE, JSON.stringify({ data, queued_at: Date.now() }));
    await redis.hincrby(KEYS.METRICS, 'bg_tasks_total', 1);
  }

  /**
   * Queue a document parsing task as a BG task so the PID controller
   * is aware of parsing demand.
   */
  async queueParsingTask(documentId: string): Promise<void> {
    await this.queueBackgroundTask({ type: 'parse_document', documentId });
  }

  /** Increment the documents_parsed metric counter */
  async recordDocumentParsed(): Promise<void> {
    await getRedis().hincrby(KEYS.METRICS, 'documents_parsed', 1);
  }

  /** Get the current count of QUEUED documents */
  async getDocumentBacklog(): Promise<number> {
    try {
      const { prisma } = await import('@/lib/db/prisma');
      return await (prisma as any).document.count({ where: { status: 'QUEUED' } });
    } catch {
      return 0;
    }
  }

  async getNextBackgroundTask(): Promise<{ data: Record<string, unknown>; queued_at: number } | null> {
    const redis = getRedis();
    const item = await redis.lpop(KEYS.BG_QUEUE);
    if (!item) return null;

    await redis.hincrby(KEYS.METRICS, 'bg_tasks_processed', 1);
    return JSON.parse(item);
  }

  async hasUiRequests(): Promise<boolean> {
    return ((await getRedis().llen(KEYS.UI_QUEUE)) || 0) > 0;
  }

  async hasBackgroundTasks(): Promise<boolean> {
    return ((await getRedis().llen(KEYS.BG_QUEUE)) || 0) > 0;
  }

  async getUiWorkerCount(): Promise<number> {
    const state = await getRedis().hgetall(KEYS.STATE);
    return parseInt(state.ui_workers || String(this.minUiWorkers), 10);
  }

  async getBgWorkerCount(): Promise<number> {
    const state = await getRedis().hgetall(KEYS.STATE);
    return parseInt(state.bg_workers || String(this.totalWorkers - this.minUiWorkers), 10);
  }

  // ---------------------------------------------------------------------------
  // Seed background tasks from folder index
  // ---------------------------------------------------------------------------

  async seedBackgroundTasks(indexService: FolderIndexService): Promise<number> {
    const redis = getRedis();
    const currentDepth = (await redis.llen(KEYS.BG_QUEUE)) || 0;
    if (currentDepth > 100) return 0;

    let seeded = 0;

    // 1. Folders needing refresh (about to expire)
    const needsRefresh = await indexService.getFoldersNeedingRefresh();
    for (const path of needsRefresh.slice(0, 50)) {
      await this.queueBackgroundTask({ type: 'refresh', path });
      seeded++;
    }

    // 2. Popular folders that might be stale
    const popular = await indexService.getPopularFolders(50);
    for (const path of popular) {
      if (await indexService.isStale(path)) {
        await this.queueBackgroundTask({ type: 'popular_refresh', path });
        seeded++;
      }
    }

    // 3. If truly idle, trigger progressive full scan
    if (seeded === 0 && currentDepth === 0) {
      seeded = await this.seedFullScan(indexService);
    }

    return seeded;
  }

  private async seedFullScan(indexService: FolderIndexService, batchSize = 50): Promise<number> {
    const redis = getRedis();
    const basePath = process.env.CASE_FILES_ROOT;
    if (!basePath) return 0;

    const { readdirSync, statSync } = await import('fs');
    const { join, relative, sep } = await import('path');

    const progress = await redis.hgetall(KEYS.SCAN_PROGRESS);
    let lastPath = progress.last_path || '';
    const scanComplete = progress.complete === '1';
    const scanStarted = parseInt(progress.started_at || '0', 10);
    const now = Math.floor(Date.now() / 1000);

    // If scan completed recently (within 10 minutes), don't restart
    if (scanComplete && scanStarted > now - 600) return 0;

    // If no progress or scan is old, start fresh
    if (!lastPath || scanStarted < now - 3600) {
      lastPath = '';
      await redis.hset(KEYS.SCAN_PROGRESS, {
        started_at: now,
        complete: '0',
        last_path: '',
        folders_queued: 0,
      });
    }

    // Recursive directory walk
    let seeded = 0;
    let foundLast = !lastPath;
    let lastQueued = lastPath;

    const walk = (dir: string) => {
      if (seeded >= batchSize) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const entry of entries) {
        if (seeded >= batchSize) return;
        const full = join(dir, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;

        const rel = relative(basePath, full).split(sep).join('/');

        if (!foundLast) {
          if (rel === lastPath) foundLast = true;
          walk(full);
          continue;
        }

        // Queue if not cached
        // We can't await inside a sync walk, so we collect paths
        uncachedPaths.push(rel);
        walk(full);
      }
    };

    const uncachedPaths: string[] = [];
    walk(basePath);

    // Now async-check cache and queue
    for (const rel of uncachedPaths) {
      if (seeded >= batchSize) break;
      const cached = await indexService.getCount(rel);
      if (cached !== null) continue;
      await this.queueBackgroundTask({ type: 'full_scan', path: rel });
      seeded++;
      lastQueued = rel;
    }

    const prevQueued = parseInt(progress.folders_queued || '0', 10);
    if (seeded < batchSize) {
      await redis.hset(KEYS.SCAN_PROGRESS, { complete: '1', last_path: '', folders_queued: prevQueued + seeded });
    } else {
      await redis.hset(KEYS.SCAN_PROGRESS, { last_path: lastQueued, folders_queued: prevQueued + seeded });
    }

    return seeded;
  }

  async getScanProgress(): Promise<WorkerPoolState['scan']> {
      const progress = await getRedis().hgetall(KEYS.SCAN_PROGRESS);

      // Count QUEUED documents from the database
      let documentsQueued = 0;
      try {
        const { prisma } = await import('@/lib/db/prisma');
        documentsQueued = await (prisma as any).document.count({ where: { status: 'QUEUED' } });
      } catch { /* prisma not available */ }

      return {
        startedAt: parseInt(progress.started_at || '0', 10),
        complete: progress.complete === '1',
        lastPath: progress.last_path || '',
        foldersQueued: parseInt(progress.folders_queued || '0', 10),
        documentsQueued,
      };
    }

  // ---------------------------------------------------------------------------
  // Stop / Reset
  // ---------------------------------------------------------------------------

  async signalStop(): Promise<void> {
    await getRedis().set(KEYS.STOP, Math.floor(Date.now() / 1000));
  }

  async shouldStop(): Promise<boolean> {
    return (await getRedis().exists(KEYS.STOP)) === 1;
  }

  async clearStopSignal(): Promise<void> {
    await getRedis().del(KEYS.STOP);
  }

  async reset(): Promise<void> {
    const redis = getRedis();
    await redis.del(KEYS.STATE, KEYS.PID_STATE, KEYS.UI_QUEUE, KEYS.BG_QUEUE, KEYS.METRICS, KEYS.STOP, KEYS.SCAN_PROGRESS, KEYS.UI_RATE, KEYS.UI_PENDING);
    await this.initialize();
  }

  async getQueueDepths(): Promise<{ ui: number; bg: number }> {
    const redis = getRedis();
    return {
      ui: (await redis.llen(KEYS.UI_QUEUE)) || 0,
      bg: (await redis.llen(KEYS.BG_QUEUE)) || 0,
    };
  }
}
