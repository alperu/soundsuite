/**
 * ServicesManager Tests
 * 
 * Tests the ServicesManager singleton class to ensure it correctly tracks
 * and reports the health status of all system services.
 * 
 * Requirements: 19.5
 */

import { getServicesManager } from '../services-manager'
import { FileWatcher } from '@/services/file-watcher'
import { JobQueue } from '@/services/job-queue'
import { MCPServer } from '@/lib/mcp/mcp-server'

// Mock the services
jest.mock('@/services/file-watcher')
jest.mock('@/services/job-queue')
jest.mock('@/lib/mcp/mcp-server')

describe('ServicesManager', () => {
  let mockFileWatcher: jest.Mocked<FileWatcher>
  let mockJobQueue: jest.Mocked<JobQueue>
  let mockMCPServer: jest.Mocked<MCPServer>

  beforeEach(() => {
    // Create mock instances
    mockFileWatcher = {
      isWatcherRunning: jest.fn(),
    } as any

    mockJobQueue = {
      getQueueLength: jest.fn(),
      getActiveJobs: jest.fn(),
    } as any

    mockMCPServer = {} as any
  })

  afterEach(() => {
    // Reset singleton after each test
    const manager = getServicesManager()
    manager.unregisterFileWatcher()
    manager.unregisterJobQueue()
    manager.unregisterMCPServer()
  })

  describe('service registration', () => {
    it('should register and track FileWatcher', () => {
      const manager = getServicesManager()
      
      manager.registerFileWatcher(mockFileWatcher)
      
      const health = manager.checkFileWatcherHealth()
      expect(health.status).not.toBe('unknown')
    })

    it('should register and track JobQueue', () => {
      const manager = getServicesManager()
      
      manager.registerJobQueue(mockJobQueue)
      
      const health = manager.checkJobQueueHealth()
      expect(health.status).not.toBe('unknown')
    })

    it('should register and track MCP Server', () => {
      const manager = getServicesManager()
      
      manager.registerMCPServer(mockMCPServer)
      
      const health = manager.checkMCPServerHealth()
      expect(health.status).not.toBe('unknown')
    })

    it('should unregister services', () => {
      const manager = getServicesManager()
      
      manager.registerFileWatcher(mockFileWatcher)
      manager.unregisterFileWatcher()
      
      const health = manager.checkFileWatcherHealth()
      expect(health.status).toBe('unknown')
      expect(health.message).toContain('not registered')
    })
  })

  describe('FileWatcher health check', () => {
    it('should return running status when FileWatcher is active', () => {
      const manager = getServicesManager()
      mockFileWatcher.isWatcherRunning.mockReturnValue(true)
      
      manager.registerFileWatcher(mockFileWatcher)
      const health = manager.checkFileWatcherHealth()
      
      expect(health.status).toBe('running')
      expect(health.message).toContain('active')
    })

    it('should return stopped status when FileWatcher is not running', () => {
      const manager = getServicesManager()
      mockFileWatcher.isWatcherRunning.mockReturnValue(false)
      
      manager.registerFileWatcher(mockFileWatcher)
      const health = manager.checkFileWatcherHealth()
      
      expect(health.status).toBe('stopped')
      expect(health.message).toContain('not currently running')
    })

    it('should return unknown status when FileWatcher is not registered', () => {
      const manager = getServicesManager()
      
      const health = manager.checkFileWatcherHealth()
      
      expect(health.status).toBe('unknown')
      expect(health.message).toContain('not registered')
    })

    it('should return error status when health check throws', () => {
      const manager = getServicesManager()
      mockFileWatcher.isWatcherRunning.mockImplementation(() => {
        throw new Error('Health check failed')
      })
      
      manager.registerFileWatcher(mockFileWatcher)
      const health = manager.checkFileWatcherHealth()
      
      expect(health.status).toBe('error')
      expect(health.message).toContain('Health check failed')
    })
  })

  describe('JobQueue health check', () => {
    it('should return running status with queue details', () => {
      const manager = getServicesManager()
      mockJobQueue.getQueueLength.mockReturnValue(5)
      mockJobQueue.getActiveJobs.mockReturnValue([
        {
          id: 'job-1',
          documentId: 'doc-1',
          filePath: '/path/to/doc1.pdf',
          attempt: 1,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      
      manager.registerJobQueue(mockJobQueue)
      const health = manager.checkJobQueueHealth()
      
      expect(health.status).toBe('running')
      expect(health.message).toContain('operational')
      expect(health.details?.queueLength).toBe(5)
      expect(health.details?.activeJobsCount).toBe(1)
      expect(health.details?.activeJobs).toHaveLength(1)
    })

    it('should return unknown status when JobQueue is not registered', () => {
      const manager = getServicesManager()
      
      const health = manager.checkJobQueueHealth()
      
      expect(health.status).toBe('unknown')
      expect(health.message).toContain('not registered')
    })

    it('should return error status when health check throws', () => {
      const manager = getServicesManager()
      mockJobQueue.getQueueLength.mockImplementation(() => {
        throw new Error('Queue error')
      })
      
      manager.registerJobQueue(mockJobQueue)
      const health = manager.checkJobQueueHealth()
      
      expect(health.status).toBe('error')
      expect(health.message).toContain('Queue error')
    })
  })

  describe('MCP Server health check', () => {
    it('should return running status when MCP Server is registered', () => {
      const manager = getServicesManager()
      
      manager.registerMCPServer(mockMCPServer)
      const health = manager.checkMCPServerHealth()
      
      expect(health.status).toBe('running')
      expect(health.message).toContain('operational')
    })

    it('should return unknown status when MCP Server is not registered', () => {
      const manager = getServicesManager()
      
      const health = manager.checkMCPServerHealth()
      
      expect(health.status).toBe('unknown')
      expect(health.message).toContain('not registered')
    })
  })

  describe('system health check', () => {
    it('should return healthy when all services are running', async () => {
      const manager = getServicesManager()
      
      mockFileWatcher.isWatcherRunning.mockReturnValue(true)
      mockJobQueue.getQueueLength.mockReturnValue(0)
      mockJobQueue.getActiveJobs.mockReturnValue([])
      
      manager.registerFileWatcher(mockFileWatcher)
      manager.registerJobQueue(mockJobQueue)
      manager.registerMCPServer(mockMCPServer)
      
      const databaseHealth = {
        status: 'running' as const,
        message: 'Database connected',
      }
      
      const systemHealth = await manager.getSystemHealth(databaseHealth)
      
      expect(systemHealth.overall).toBe('healthy')
      expect(systemHealth.fileWatcher.status).toBe('running')
      expect(systemHealth.jobQueue.status).toBe('running')
      expect(systemHealth.mcpServer.status).toBe('running')
      expect(systemHealth.database.status).toBe('running')
      expect(systemHealth.timestamp).toBeDefined()
    })

    it('should return degraded when some services are stopped', async () => {
      const manager = getServicesManager()
      
      mockFileWatcher.isWatcherRunning.mockReturnValue(false)
      mockJobQueue.getQueueLength.mockReturnValue(0)
      mockJobQueue.getActiveJobs.mockReturnValue([])
      
      manager.registerFileWatcher(mockFileWatcher)
      manager.registerJobQueue(mockJobQueue)
      manager.registerMCPServer(mockMCPServer)
      
      const databaseHealth = {
        status: 'running' as const,
        message: 'Database connected',
      }
      
      const systemHealth = await manager.getSystemHealth(databaseHealth)
      
      expect(systemHealth.overall).toBe('degraded')
      expect(systemHealth.fileWatcher.status).toBe('stopped')
    })

    it('should return unhealthy when database is down', async () => {
      const manager = getServicesManager()
      
      mockFileWatcher.isWatcherRunning.mockReturnValue(true)
      mockJobQueue.getQueueLength.mockReturnValue(0)
      mockJobQueue.getActiveJobs.mockReturnValue([])
      
      manager.registerFileWatcher(mockFileWatcher)
      manager.registerJobQueue(mockJobQueue)
      manager.registerMCPServer(mockMCPServer)
      
      const databaseHealth = {
        status: 'error' as const,
        message: 'Database connection failed',
      }
      
      const systemHealth = await manager.getSystemHealth(databaseHealth)
      
      expect(systemHealth.overall).toBe('unhealthy')
      expect(systemHealth.database.status).toBe('error')
    })

    it('should return degraded when services are not registered', async () => {
      const manager = getServicesManager()
      
      const databaseHealth = {
        status: 'running' as const,
        message: 'Database connected',
      }
      
      const systemHealth = await manager.getSystemHealth(databaseHealth)
      
      expect(systemHealth.overall).toBe('degraded')
      expect(systemHealth.fileWatcher.status).toBe('unknown')
      expect(systemHealth.jobQueue.status).toBe('unknown')
      expect(systemHealth.mcpServer.status).toBe('unknown')
    })
  })

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const manager1 = getServicesManager()
      const manager2 = getServicesManager()
      
      expect(manager1).toBe(manager2)
    })

    it('should maintain state across calls', () => {
      const manager1 = getServicesManager()
      manager1.registerFileWatcher(mockFileWatcher)
      
      const manager2 = getServicesManager()
      const health = manager2.checkFileWatcherHealth()
      
      expect(health.status).not.toBe('unknown')
    })
  })
})
