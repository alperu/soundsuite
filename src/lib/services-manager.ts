/**
 * ServicesManager - Centralized manager for tracking service health status
 * 
 * This singleton class maintains references to all running services and provides
 * health check capabilities for monitoring system status.
 * 
 * Requirements: 19.5
 */

import { FileWatcher } from '@/services/file-watcher';
import { JobQueue } from '@/services/job-queue';
import { MCPServer } from '@/lib/mcp/mcp-server';
import { ParsingWorkerManager } from '@/services/parsing-worker-manager';
import type { WorkerPoolService } from '@/services/worker-pool-service';
import type { BackgroundScannerDaemon } from '@/services/background-scanner-daemon';
import type { ToolRegistry } from '@/lib/mcp/tool-registry';
import { createLogger, Logger } from './logger';

export interface ServiceHealth {
  status: 'running' | 'stopped' | 'error' | 'unknown';
  message?: string;
  details?: Record<string, any>;
}

export interface WorkerPoolHealth {
  workerPool: ServiceHealth;
  parsingWorkers: ServiceHealth;
  daemon: ServiceHealth;
}

export interface SystemHealth {
  fileWatcher: ServiceHealth;
  jobQueue: ServiceHealth;
  mcpServer: ServiceHealth;
  database: ServiceHealth;
  workerPool?: WorkerPoolHealth;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
}

/**
 * ServicesManager provides centralized service management and health monitoring.
 * 
 * This singleton class maintains references to all running services (FileWatcher,
 * JobQueue, MCP Server) and provides methods to check their health status.
 */
class ServicesManager {
  private static instance: ServicesManager | null = null;
  private logger: Logger;

  private fileWatcher: FileWatcher | null = null;
  private jobQueue: JobQueue | null = null;
  private mcpServer: MCPServer | null = null;
  private parsingWorkerManager: ParsingWorkerManager | null = null;
  private workerPoolService: WorkerPoolService | null = null;
  private backgroundDaemon: BackgroundScannerDaemon | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private workerPids: Map<string, number> = new Map();

  private constructor() {
    this.logger = createLogger('ServicesManager');
  }

  /**
   * Get the singleton instance of ServicesManager
   */
  static getInstance(): ServicesManager {
    if (!ServicesManager.instance) {
      ServicesManager.instance = new ServicesManager();
    }
    return ServicesManager.instance;
  }

  /**
   * Register the FileWatcher service
   */
  registerFileWatcher(fileWatcher: FileWatcher): void {
    this.fileWatcher = fileWatcher;
    this.logger.info('FileWatcher registered');
  }

  /**
   * Register the JobQueue service
   */
  registerJobQueue(jobQueue: JobQueue): void {
    this.jobQueue = jobQueue;
    this.logger.info('JobQueue registered');
  }

  /**
   * Register the MCP Server
   */
  registerMCPServer(mcpServer: MCPServer): void {
    this.mcpServer = mcpServer;
    this.logger.info('MCP Server registered');
  }

  /**
   * Register the ToolRegistry
   */
  registerToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
    this.logger.info('ToolRegistry registered');
  }

  /**
   * Get the registered ToolRegistry instance
   */
  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  /**
   * Get the registered FileWatcher instance
   */
  getFileWatcher(): FileWatcher | null {
    return this.fileWatcher;
  }

  /**
   * Get the registered JobQueue instance
   */
  getJobQueue(): JobQueue | null {
    return this.jobQueue;
  }

  /**
   * Get the registered MCP Server instance
   */
  getMCPServer(): MCPServer | null {
    return this.mcpServer;
  }

  /**
   * Register the ParsingWorkerManager
   */
  registerParsingWorkerManager(manager: ParsingWorkerManager): void {
    this.parsingWorkerManager = manager;
    this.logger.info('ParsingWorkerManager registered');
  }

  /**
   * Get the registered ParsingWorkerManager instance
   */
  getParsingWorkerManager(): ParsingWorkerManager | null {
    return this.parsingWorkerManager;
  }

  /**
   * Register the WorkerPoolService
   */
  registerWorkerPoolService(pool: WorkerPoolService): void {
    this.workerPoolService = pool;
    this.logger.info('WorkerPoolService registered');
  }

  /**
   * Get the registered WorkerPoolService instance
   */
  getWorkerPoolService(): WorkerPoolService | null {
    return this.workerPoolService;
  }

  /**
   * Register the BackgroundScannerDaemon
   */
  registerBackgroundDaemon(daemon: BackgroundScannerDaemon): void {
    this.backgroundDaemon = daemon;
    this.logger.info('BackgroundScannerDaemon registered');
  }

  /**
   * Get the registered BackgroundScannerDaemon instance
   */
  getBackgroundDaemon(): BackgroundScannerDaemon | null {
    return this.backgroundDaemon;
  }

  /**
   * Track a worker PID (writes to .pids/ directory)
   */
  async trackWorkerPid(workerId: string, pid: number): Promise<void> {
    this.workerPids.set(workerId, pid);
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const pidDir = path.join(process.cwd(), '.pids');
      await fs.mkdir(pidDir, { recursive: true });
      await fs.writeFile(path.join(pidDir, `worker-${workerId}.pid`), String(pid));
    } catch (err) {
      this.logger.error('Failed to write worker PID file', err, { workerId, pid });
    }
  }

  /**
   * Remove a tracked worker PID
   */
  async untrackWorkerPid(workerId: string): Promise<void> {
    this.workerPids.delete(workerId);
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const pidFile = path.join(process.cwd(), '.pids', `worker-${workerId}.pid`);
      await fs.unlink(pidFile).catch(() => {});
    } catch {
      // PID file already removed
    }
  }

  /**
   * Get all tracked worker PIDs
   */
  getWorkerPids(): Map<string, number> {
    return new Map(this.workerPids);
  }

  /**
   * Unregister the FileWatcher service
   */
  unregisterFileWatcher(): void {
    this.fileWatcher = null;
    this.logger.info('FileWatcher unregistered');
  }

  /**
   * Unregister the JobQueue service
   */
  unregisterJobQueue(): void {
    this.jobQueue = null;
    this.logger.info('JobQueue unregistered');
  }

  /**
   * Unregister the MCP Server
   */
  unregisterMCPServer(): void {
    this.mcpServer = null;
    this.logger.info('MCP Server unregistered');
  }

  /**
   * Check FileWatcher health status
   */
  checkFileWatcherHealth(): ServiceHealth {
    if (!this.fileWatcher) {
      return {
        status: 'unknown',
        message: 'FileWatcher not registered',
      };
    }

    try {
      const isRunning = this.fileWatcher.isWatcherRunning();
      
      if (isRunning) {
        return {
          status: 'running',
          message: 'FileWatcher is active and monitoring directories',
        };
      } else {
        return {
          status: 'stopped',
          message: 'FileWatcher is not currently running',
        };
      }
    } catch (error) {
      this.logger.error('Error checking FileWatcher health', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check JobQueue health status
   */
  checkJobQueueHealth(): ServiceHealth {
    if (!this.jobQueue) {
      return {
        status: 'unknown',
        message: 'JobQueue not registered',
      };
    }

    try {
      const queueLength = this.jobQueue.getQueueLength();
      const activeJobs = this.jobQueue.getActiveJobs();
      
      return {
        status: 'running',
        message: 'JobQueue is operational',
        details: {
          queueLength,
          activeJobsCount: activeJobs.length,
          activeJobs: activeJobs.map(job => ({
            id: job.id,
            documentId: job.documentId,
            status: job.status,
            attempt: job.attempt,
          })),
        },
      };
    } catch (error) {
      this.logger.error('Error checking JobQueue health', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check MCP Server health status.
   * The standalone HTTP server on port 3001 is no longer started — MCP tools
   * are served via Next.js API routes (/api/mcp/execute). Health is determined
   * by whether the ToolRegistry singleton has been registered.
   */
  checkMCPServerHealth(): ServiceHealth {
    if (!this.toolRegistry) {
      return {
        status: 'unknown',
        message: 'ToolRegistry not registered',
      };
    }

    try {
      const enabledCount = this.toolRegistry.listTools().filter(t => t.config.enabled).length;
      return {
        status: 'running',
        message: `MCP tools available via API (${enabledCount} enabled)`,
      };
    } catch (error) {
      this.logger.error('Error checking MCP Server health', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check WorkerPoolService health
   */
  async checkWorkerPoolHealth(): Promise<WorkerPoolHealth> {
    const poolHealth: ServiceHealth = !this.workerPoolService
      ? { status: 'unknown', message: 'WorkerPoolService not registered' }
      : { status: 'running', message: 'WorkerPoolService is operational' };

    let parsingHealth: ServiceHealth;
    if (!this.parsingWorkerManager) {
      parsingHealth = { status: 'unknown', message: 'ParsingWorkerManager not registered' };
    } else {
      const workers = this.parsingWorkerManager.getStatus();
      const runningCount = workers.filter(w => w.running).length;
      parsingHealth = {
        status: runningCount > 0 ? 'running' : 'stopped',
        message: `${runningCount}/${workers.length} parsing workers active`,
        details: {
          totalWorkers: workers.length,
          activeWorkers: runningCount,
          workers,
          trackedPids: Object.fromEntries(this.workerPids),
        },
      };
    }

    const daemonHealth: ServiceHealth = !this.backgroundDaemon
      ? { status: 'unknown', message: 'BackgroundScannerDaemon not registered' }
      : this.backgroundDaemon.isRunning()
        ? { status: 'running', message: 'BackgroundScannerDaemon is active' }
        : { status: 'stopped', message: 'BackgroundScannerDaemon is not running' };

    return { workerPool: poolHealth, parsingWorkers: parsingHealth, daemon: daemonHealth };
  }

  /**
   * Get comprehensive system health status
   *
   * This method checks all registered services and returns a structured
   * health report including overall system status.
   *
   * Requirements: 19.5
   */
  async getSystemHealth(databaseHealth: ServiceHealth): Promise<SystemHealth> {
    const fileWatcherHealth = this.checkFileWatcherHealth();
    const jobQueueHealth = this.checkJobQueueHealth();
    const mcpServerHealth = this.checkMCPServerHealth();
    const workerPoolHealth = await this.checkWorkerPoolHealth();

    // Determine overall health status
    // Filter out unregistered optional services (status === 'unknown') — these
    // are FileWatcher/JobQueue/MCPServer which may never be registered in dev.
    const optionalStatuses = [
      fileWatcherHealth.status,
      jobQueueHealth.status,
      mcpServerHealth.status,
    ].filter(s => s !== 'unknown');

    const registeredStatuses = [
      databaseHealth.status,
      ...optionalStatuses,
    ];

    // Include worker pool parsing workers status if registered
    if (workerPoolHealth.parsingWorkers?.status !== 'unknown') {
      registeredStatuses.push(workerPoolHealth.parsingWorkers.status);
    }

    let overall: 'healthy' | 'degraded' | 'unhealthy';

    if (databaseHealth.status === 'error' || databaseHealth.status === 'stopped') {
      overall = 'unhealthy';
    } else if (registeredStatuses.some(s => s === 'error' || s === 'stopped')) {
      overall = 'degraded';
    } else {
      overall = 'healthy';
    }

    return {
      fileWatcher: fileWatcherHealth,
      jobQueue: jobQueueHealth,
      mcpServer: mcpServerHealth,
      database: databaseHealth,
      workerPool: workerPoolHealth,
      overall,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static reset(): void {
    ServicesManager.instance = null;
  }
}

// Export singleton instance getter
export const getServicesManager = () => ServicesManager.getInstance();
