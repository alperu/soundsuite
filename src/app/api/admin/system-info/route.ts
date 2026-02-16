/**
 * System Info API Route
 *
 * GET /api/admin/system-info — Returns comprehensive system information
 * for the admin dashboard: DB stats, service status, uptime, etc.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';
import { isRedisAvailable, getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Database stats
    const [caseCount, documentCount, jobLogCount, configCount, actionLogCount] =
      await Promise.all([
        prisma.case.count(),
        prisma.document.count(),
        prisma.jobLog.count(),
        prisma.config.count(),
        prisma.actionLog.count(),
      ]);

    const docsByStatus = await prisma.document.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const recentJobs = await prisma.jobLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    });

    // Service health
    const servicesManager = getServicesManager();
    const fileWatcher = servicesManager.checkFileWatcherHealth();
    const jobQueue = servicesManager.checkJobQueueHealth();
    const mcpServer = servicesManager.checkMCPServerHealth();

    // Redis info
    let redisInfo: Record<string, unknown> = { available: false };
    try {
      if (await isRedisAvailable()) {
        const redis = getRedis();
        const info = await redis.info('memory');
        const memMatch = info.match(/used_memory_human:(\S+)/);
        const keysMatch = info.match(/db0:keys=(\d+)/);

        let keyCount = 0;
        try {
          const dbInfo = await redis.info('keyspace');
          const dbMatch = dbInfo.match(/db0:keys=(\d+)/);
          keyCount = dbMatch ? parseInt(dbMatch[1], 10) : 0;
        } catch { /* ignore */ }

        redisInfo = {
          available: true,
          memoryUsed: memMatch ? memMatch[1] : 'unknown',
          keyCount,
        };
      }
    } catch { /* Redis not available */ }

    // Uptime (process uptime)
    const uptimeSeconds = process.uptime();

    return NextResponse.json({
      database: {
        cases: caseCount,
        documents: documentCount,
        jobLogs: jobLogCount,
        configs: configCount,
        actionLogs: actionLogCount,
        documentsByStatus: docsByStatus.reduce(
          (acc, d) => ({ ...acc, [d.status]: d._count.id }),
          {} as Record<string, number>
        ),
      },
      services: {
        fileWatcher,
        jobQueue,
        mcpServer,
      },
      redis: redisInfo,
      recentJobs,
      uptime: {
        seconds: Math.floor(uptimeSeconds),
        formatted: formatUptime(uptimeSeconds),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get system info' },
      { status: 500 }
    );
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
