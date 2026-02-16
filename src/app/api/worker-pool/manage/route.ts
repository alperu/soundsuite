/**
 * Worker Pool Management API
 *
 * GET  /api/worker-pool/manage — Full worker pool status (pool state + parsing workers + daemon + PIDs)
 * POST /api/worker-pool/manage — Adjust worker pool settings
 *   Actions:
 *     { action: "scale", totalWorkers: number }           — Change total pool size
 *     { action: "scale_parsing", count: number }          — Change parsing worker count
 *     { action: "rebalance" }                             — Force PID controller rebalance
 *     { action: "reset" }                                 — Reset worker pool state in Redis
 *     { action: "update_pid", kp?: number, ki?: number, kd?: number } — Tune PID gains
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRedisAvailable } from '@/lib/redis';
import { WorkerPoolService } from '@/services/worker-pool-service';
import { getServicesManager } from '@/lib/services-manager';
import { setConfigValue } from '@/lib/db/config';

export async function GET() {
  try {
    const sm = getServicesManager();

    // Worker pool state from Redis
    let poolState = null;
    if (await isRedisAvailable()) {
      const pool = sm.getWorkerPoolService() ?? await WorkerPoolService.fromConfig();
      poolState = await pool.getState();
    }

    // Parsing worker status
    const parsingManager = sm.getParsingWorkerManager();
    const parsingWorkers = parsingManager
      ? { count: parsingManager.getWorkerCount(), workers: parsingManager.getStatus() }
      : null;

    // Daemon status
    const daemon = sm.getBackgroundDaemon();
    const daemonStatus = daemon ? { running: daemon.isRunning() } : null;

    // Tracked PIDs
    const pids = Object.fromEntries(sm.getWorkerPids());

    return NextResponse.json({
      pool: poolState,
      parsingWorkers,
      daemon: daemonStatus,
      pids,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get worker pool status' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    if (!(await isRedisAvailable())) {
      return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
    }

    const sm = getServicesManager();

    switch (action) {
      case 'scale': {
        const totalWorkers = parseInt(body.totalWorkers, 10);
        if (isNaN(totalWorkers) || totalWorkers < 3 || totalWorkers > 100) {
          return NextResponse.json({ error: 'totalWorkers must be between 3 and 100' }, { status: 400 });
        }

        await setConfigValue('workers.poolSize', String(totalWorkers));

        const pool = await WorkerPoolService.fromConfig();
        await pool.applyConfig();
        const state = await pool.getState();

        return NextResponse.json({ success: true, state });
      }

      case 'scale_parsing': {
        const count = parseInt(body.count, 10);
        if (isNaN(count) || count < 0 || count > 10) {
          return NextResponse.json({ error: 'count must be between 0 and 10' }, { status: 400 });
        }

        const parsingManager = sm.getParsingWorkerManager();
        if (!parsingManager) {
          return NextResponse.json({ error: 'ParsingWorkerManager not initialized' }, { status: 503 });
        }

        await parsingManager.setWorkerCount(count);
        await setConfigValue('parsing.workerCount', String(count));

        return NextResponse.json({
          success: true,
          workerCount: parsingManager.getWorkerCount(),
          workers: parsingManager.getStatus(),
        });
      }

      case 'rebalance': {
        const pool = sm.getWorkerPoolService() ?? await WorkerPoolService.fromConfig();
        const result = await pool.runPidController();
        return NextResponse.json({ success: true, result });
      }

      case 'reset': {
        const pool = sm.getWorkerPoolService() ?? await WorkerPoolService.fromConfig();
        await pool.reset();
        const state = await pool.getState();
        return NextResponse.json({ success: true, state });
      }

      case 'update_pid': {
        const updates: Array<{ key: string; value: string }> = [];
        if (body.kp !== undefined) updates.push({ key: 'workers.pidKp', value: String(body.kp) });
        if (body.ki !== undefined) updates.push({ key: 'workers.pidKi', value: String(body.ki) });
        if (body.kd !== undefined) updates.push({ key: 'workers.pidKd', value: String(body.kd) });

        if (updates.length === 0) {
          return NextResponse.json({ error: 'At least one of kp, ki, kd must be provided' }, { status: 400 });
        }

        for (const { key, value } of updates) {
          await setConfigValue(key, value);
        }

        return NextResponse.json({ success: true, updated: updates.map(u => u.key) });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid actions: scale, scale_parsing, rebalance, reset, update_pid` },
          { status: 400 }
        );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to manage worker pool' },
      { status: 500 }
    );
  }
}
