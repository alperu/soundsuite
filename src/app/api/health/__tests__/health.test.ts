/**
 * Health Check API Route Tests
 * 
 * Tests the health check endpoint to ensure it correctly reports the status
 * of all system services (FileWatcher, JobQueue, MCP Server, Database).
 * 
 * Requirements: 19.5
 *
 * @jest-environment node
 */

import { GET } from '../route'
import { prisma } from '@/lib/db/prisma'
import { getServicesManager } from '@/lib/services-manager'
import { FileWatcher } from '@/services/file-watcher'
import { JobQueue } from '@/services/job-queue'
import { MCPServer } from '@/lib/mcp/mcp-server'

// Mock dependencies
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    case: { count: jest.fn() },
    document: { count: jest.fn() },
    jobLog: { count: jest.fn() },
    config: { count: jest.fn() },
    modelDownload: { count: jest.fn() },
  },
}))

jest.mock('@/lib/services-manager')

describe('Health Check API', () => {
  let mockServicesManager: any

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup mock services manager
    mockServicesManager = {
      getSystemHealth: jest.fn(),
    }

    ;(getServicesManager as jest.Mock).mockReturnValue(mockServicesManager)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('GET /api/health', () => {
    it('should return healthy status when all services are running', async () => {
      // Mock database responses
      ;(prisma.$connect as jest.Mock).mockResolvedValue(undefined)
      ;(prisma.case.count as jest.Mock).mockResolvedValue(4)
      ;(prisma.document.count as jest.Mock).mockResolvedValue(10)
      ;(prisma.jobLog.count as jest.Mock).mockResolvedValue(5)
      ;(prisma.config.count as jest.Mock).mockResolvedValue(3)
      ;(prisma.modelDownload.count as jest.Mock).mockResolvedValue(2)

      // Mock system health response
      mockServicesManager.getSystemHealth.mockResolvedValue({
        fileWatcher: {
          status: 'running',
          message: 'FileWatcher is active and monitoring directories',
        },
        jobQueue: {
          status: 'running',
          message: 'JobQueue is operational',
          details: {
            queueLength: 0,
            activeJobsCount: 0,
            activeJobs: [],
          },
        },
        mcpServer: {
          status: 'running',
          message: 'MCP Server is operational',
        },
        database: {
          status: 'running',
          message: 'Database is connected and operational',
          details: {
            tables: {
              cases: 4,
              documents: 10,
              jobLogs: 5,
              config: 3,
              modelDownloads: 2,
            },
          },
        },
        overall: 'healthy',
        timestamp: expect.any(String),
      })

      const response = await GET()
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.overall).toBe('healthy')
      expect(data.fileWatcher.status).toBe('running')
      expect(data.jobQueue.status).toBe('running')
      expect(data.mcpServer.status).toBe('running')
      expect(data.database.status).toBe('running')
      expect(data.timestamp).toBeDefined()
    })

    it('should return degraded status when some services are not running', async () => {
      // Mock database responses
      ;(prisma.$connect as jest.Mock).mockResolvedValue(undefined)
      ;(prisma.case.count as jest.Mock).mockResolvedValue(4)
      ;(prisma.document.count as jest.Mock).mockResolvedValue(10)
      ;(prisma.jobLog.count as jest.Mock).mockResolvedValue(5)
      ;(prisma.config.count as jest.Mock).mockResolvedValue(3)
      ;(prisma.modelDownload.count as jest.Mock).mockResolvedValue(2)

      // Mock system health response with FileWatcher stopped
      mockServicesManager.getSystemHealth.mockResolvedValue({
        fileWatcher: {
          status: 'stopped',
          message: 'FileWatcher is not currently running',
        },
        jobQueue: {
          status: 'running',
          message: 'JobQueue is operational',
          details: {
            queueLength: 0,
            activeJobsCount: 0,
            activeJobs: [],
          },
        },
        mcpServer: {
          status: 'running',
          message: 'MCP Server is operational',
        },
        database: {
          status: 'running',
          message: 'Database is connected and operational',
          details: {
            tables: {
              cases: 4,
              documents: 10,
              jobLogs: 5,
              config: 3,
              modelDownloads: 2,
            },
          },
        },
        overall: 'degraded',
        timestamp: expect.any(String),
      })

      const response = await GET()
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.overall).toBe('degraded')
      expect(data.fileWatcher.status).toBe('stopped')
    })

    it('should return unhealthy status when database is down', async () => {
      // Mock database connection failure
      const dbError = new Error('Connection refused')
      ;(prisma.$connect as jest.Mock).mockRejectedValue(dbError)

      // Mock system health response with database error
      mockServicesManager.getSystemHealth.mockResolvedValue({
        fileWatcher: {
          status: 'running',
          message: 'FileWatcher is active and monitoring directories',
        },
        jobQueue: {
          status: 'running',
          message: 'JobQueue is operational',
          details: {
            queueLength: 0,
            activeJobsCount: 0,
            activeJobs: [],
          },
        },
        mcpServer: {
          status: 'running',
          message: 'MCP Server is operational',
        },
        database: {
          status: 'error',
          message: 'Connection refused',
        },
        overall: 'unhealthy',
        timestamp: expect.any(String),
      })

      const response = await GET()
      const data = await response.json()

      expect(response.status).toBe(503)
      expect(data.overall).toBe('unhealthy')
      expect(data.database.status).toBe('error')
      expect(data.database.message).toBe('Connection refused')
    })

    it('should return unknown status for unregistered services', async () => {
      // Mock database responses
      ;(prisma.$connect as jest.Mock).mockResolvedValue(undefined)
      ;(prisma.case.count as jest.Mock).mockResolvedValue(0)
      ;(prisma.document.count as jest.Mock).mockResolvedValue(0)
      ;(prisma.jobLog.count as jest.Mock).mockResolvedValue(0)
      ;(prisma.config.count as jest.Mock).mockResolvedValue(0)
      ;(prisma.modelDownload.count as jest.Mock).mockResolvedValue(0)

      // Mock system health response with unregistered services
      mockServicesManager.getSystemHealth.mockResolvedValue({
        fileWatcher: {
          status: 'unknown',
          message: 'FileWatcher not registered',
        },
        jobQueue: {
          status: 'unknown',
          message: 'JobQueue not registered',
        },
        mcpServer: {
          status: 'unknown',
          message: 'MCP Server not registered',
        },
        database: {
          status: 'running',
          message: 'Database is connected and operational',
          details: {
            tables: {
              cases: 0,
              documents: 0,
              jobLogs: 0,
              config: 0,
              modelDownloads: 0,
            },
          },
        },
        overall: 'degraded',
        timestamp: expect.any(String),
      })

      const response = await GET()
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.overall).toBe('degraded')
      expect(data.fileWatcher.status).toBe('unknown')
      expect(data.jobQueue.status).toBe('unknown')
      expect(data.mcpServer.status).toBe('unknown')
    })

    it('should include job queue details when jobs are active', async () => {
      // Mock database responses
      ;(prisma.$connect as jest.Mock).mockResolvedValue(undefined)
      ;(prisma.case.count as jest.Mock).mockResolvedValue(4)
      ;(prisma.document.count as jest.Mock).mockResolvedValue(10)
      ;(prisma.jobLog.count as jest.Mock).mockResolvedValue(5)
      ;(prisma.config.count as jest.Mock).mockResolvedValue(3)
      ;(prisma.modelDownload.count as jest.Mock).mockResolvedValue(2)

      // Mock system health response with active jobs
      mockServicesManager.getSystemHealth.mockResolvedValue({
        fileWatcher: {
          status: 'running',
          message: 'FileWatcher is active and monitoring directories',
        },
        jobQueue: {
          status: 'running',
          message: 'JobQueue is operational',
          details: {
            queueLength: 3,
            activeJobsCount: 2,
            activeJobs: [
              {
                id: 'job-1',
                documentId: 'doc-1',
                status: 'active',
                attempt: 1,
              },
              {
                id: 'job-2',
                documentId: 'doc-2',
                status: 'active',
                attempt: 1,
              },
            ],
          },
        },
        mcpServer: {
          status: 'running',
          message: 'MCP Server is operational',
        },
        database: {
          status: 'running',
          message: 'Database is connected and operational',
          details: {
            tables: {
              cases: 4,
              documents: 10,
              jobLogs: 5,
              config: 3,
              modelDownloads: 2,
            },
          },
        },
        overall: 'healthy',
        timestamp: expect.any(String),
      })

      const response = await GET()
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.jobQueue.details.queueLength).toBe(3)
      expect(data.jobQueue.details.activeJobsCount).toBe(2)
      expect(data.jobQueue.details.activeJobs).toHaveLength(2)
    })
  })
})
