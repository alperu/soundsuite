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
import { getServicesManager, type ServiceHealth } from '@/lib/services-manager'
import { FilingsCacheService } from '@/services/filings-cache'
import { FolderIndexService } from '@/services/folder-index-service'

export async function GET() {
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

  return NextResponse.json({ ...systemHealth, cache: cacheStats }, { status: statusCode })
}
