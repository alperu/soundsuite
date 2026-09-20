/**
 * Health Check API Route
 * 
 * This route provides comprehensive system health monitoring by checking:
 * - FileWatcher status
 * - JobQueue status
 * - MCP Server status
 * - Database connectivity
 * 
 * Returns structured health status for all services and an overall system status.
 * 
 * Requirements: 19.5
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { activeProfile, listProfiles, profilesEnabled } from '@/lib/profiles'
import { systemSqlitePath } from '@/lib/db/prisma'
import { getServicesManager, type ServiceHealth } from '@/lib/services-manager'
import { FilingsCacheService } from '@/services/filings-cache'
import { FolderIndexService } from '@/services/folder-index-service'
import { isDevMode } from '@/lib/dev-mode'

export async function GET() {
  // Self-heal: services start lazily (instrumentation → getWorkerManager) and
  // the manager may be empty after a profile switch or a dev HMR reload. If
  // nothing is registered and no init is in flight, kick the same start path
  // and report this call's snapshot; the next call sees them registered.
  {
    const sm = getServicesManager()
    if (!sm.getFileWatcher() && !sm.getToolRegistry() && !sm.getJobQueue()) {
      import('@/services/worker-init')
        .then(({ getWorkerManager }) => getWorkerManager())
        .catch((err) => console.warn('[health] service self-start failed:', (err as Error)?.message))
    }
  }
  const servicesManager = getServicesManager()
  
  // Check database connectivity
  let databaseHealth: ServiceHealth
  let databaseDetails: Record<string, any> = {}
  
  try {
    // Test database connection
    await prisma.$connect()
    
    // Get counts from all tables
    const [caseCount, documentCount, jobLogCount, configCount, modelDownloadCount, actionLogCount] =
      await Promise.all([
        prisma.case.count(),
        prisma.document.count(),
        prisma.jobLog.count(),
        prisma.config.count(),
        prisma.modelDownload.count(),
        prisma.actionLog.count(),
      ])

    databaseHealth = {
      status: 'running',
      message: 'Database is connected and operational',
      details: {
        tables: {
          cases: caseCount,
          documents: documentCount,
          jobLogs: jobLogCount,
          config: configCount,
          modelDownloads: modelDownloadCount,
          actionLogs: actionLogCount,
        },
      },
    }
    
    databaseDetails = databaseHealth.details || {}
  } catch (error) {
    databaseHealth = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown database error',
    }
  } finally {
    await prisma.$disconnect()
  }

  // Gather cache stats
  let cacheStats = {};
  try {
    const filingsCache = new FilingsCacheService();
    const folderIndex = new FolderIndexService();
    const [filingsCacheStats, folderIndexStats] = await Promise.all([
      filingsCache.getStats(),
      folderIndex.getStats(),
    ]);
    cacheStats = {
      filingsCache: filingsCacheStats,
      folderIndex: folderIndexStats,
    };
  } catch {
    cacheStats = { error: 'Failed to retrieve cache stats' };
  }

  // Get comprehensive system health from ServicesManager
  const systemHealth = await servicesManager.getSystemHealth(databaseHealth)

  // Determine HTTP status code based on overall health
  const statusCode = systemHealth.overall === 'unhealthy' ? 503 : 200

  // Which data set every number above was read from (docs/tasks/54-profiles.md).
  const p = activeProfile()
  const profile = {
    active: p.name,
    legacy: !profilesEnabled(),
    available: listProfiles().map((m) => m.name),
    paths: { sqlite: p.sqlite, lancedb: p.lancedb, system: p.legacy ? p.sqlite : systemSqlitePath() },
  }
  // Developer-mode marker (config/dev-mode on this host). Read by the
  // /admin/login `#auth=` fragment gate; see src/lib/dev-mode.ts.
  const devMode = isDevMode()
  return NextResponse.json({ profile, devMode, ...systemHealth, cache: cacheStats }, { status: statusCode })
}
