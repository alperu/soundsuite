import { FileWatcher } from '../file-watcher';
import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock chokidar to avoid ESM issues in Jest
let mockWatcherInstance: any = null;

jest.mock('chokidar', () => {
  const EventEmitter = require('events');
  
  class MockWatcher extends EventEmitter {
    close() {
      return Promise.resolve();
    }
    
    on(event: string, handler: Function) {
      super.on(event, handler);
      
      // Emit ready event after a short delay
      if (event === 'ready') {
        setTimeout(() => this.emit('ready'), 100);
      }
      
      return this;
    }
  }
  
  return {
    watch: jest.fn(() => {
      mockWatcherInstance = new MockWatcher();
      return mockWatcherInstance;
    }),
  };
});

describe('FileWatcher', () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let watcher: FileWatcher;

  beforeAll(async () => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-watcher-test-'));
  });

  afterEach(async () => {
    // Stop watcher if running
    if (watcher) {
      await watcher.stop();
    }

    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to clean up temp directory:', error);
    }

    // Clean up test data from database
    await prisma.document.deleteMany({
      where: {
        case: {
          path: tempDir,
        },
      },
    });
    await prisma.case.deleteMany({
      where: {
        path: tempDir,
      },
    });
  });

  describe('initialization', () => {
    it('should create a FileWatcher instance', () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      expect(watcher).toBeInstanceOf(FileWatcher);
      expect(watcher.isWatcherRunning()).toBe(false);
    });

    it('should start and stop successfully', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      
      // Wait a bit for watcher to be ready
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(watcher.isWatcherRunning()).toBe(true);

      await watcher.stop();
      expect(watcher.isWatcherRunning()).toBe(false);
    });

    it('should create case records on start', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      
      // Wait for case creation
      await new Promise(resolve => setTimeout(resolve, 200));

      const caseRecord = await prisma.case.findUnique({
        where: { path: tempDir },
      });

      expect(caseRecord).toBeDefined();
      expect(caseRecord?.path).toBe(tempDir);
      expect(caseRecord?.name).toBe(path.basename(tempDir));

      await watcher.stop();
    });
  });

  describe('error handling', () => {
    it('should handle empty watch paths gracefully', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [],
        },
        prisma
      );

      await expect(watcher.start()).resolves.not.toThrow();
      expect(watcher.isWatcherRunning()).toBe(false);
    });

    it('should not crash when stopping a non-running watcher', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
        },
        prisma
      );

      await expect(watcher.stop()).resolves.not.toThrow();
    });

    it('should not start twice', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Try to start again
      await watcher.start();
      
      expect(watcher.isWatcherRunning()).toBe(true);

      await watcher.stop();
    });
  });

  describe('auto-restart on error', () => {
    it('should automatically restart after encountering an error', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(watcher.isWatcherRunning()).toBe(true);

      // Simulate an error using the mock watcher instance
      if (mockWatcherInstance) {
        mockWatcherInstance.emit('error', new Error('Test error'));
      }

      // Wait for restart (5 second delay + buffer)
      await new Promise(resolve => setTimeout(resolve, 5500));

      // Watcher should have restarted
      expect(watcher.isWatcherRunning()).toBe(true);

      await watcher.stop();
    });

    it('should cancel restart when stopped manually', async () => {
      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      // Simulate an error
      if (mockWatcherInstance) {
        mockWatcherInstance.emit('error', new Error('Test error'));
      }

      // Stop immediately (before restart happens)
      await watcher.stop();

      // Wait past the restart delay
      await new Promise(resolve => setTimeout(resolve, 5500));

      // Watcher should remain stopped
      expect(watcher.isWatcherRunning()).toBe(false);
    });

    it('should retry restart if restart fails', async () => {
      let startCallCount = 0;

      // Mock start to fail once, then succeed
      const originalStart = FileWatcher.prototype.start;
      FileWatcher.prototype.start = jest.fn(async function(this: FileWatcher) {
        startCallCount++;
        if (startCallCount === 2) {
          // Second call (first restart attempt) fails
          throw new Error('Restart failed');
        }
        // First call and third call (second restart attempt) succeed
        return originalStart.call(this);
      });

      watcher = new FileWatcher(
        {
          watchPaths: [tempDir],
          ignoreInitial: true,
        },
        prisma
      );

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      // Simulate an error
      if (mockWatcherInstance) {
        mockWatcherInstance.emit('error', new Error('Test error'));
      }

      // Wait for first restart attempt to fail and second to succeed
      await new Promise(resolve => setTimeout(resolve, 11000));

      // Watcher should eventually restart successfully
      expect(watcher.isWatcherRunning()).toBe(true);
      expect(startCallCount).toBeGreaterThanOrEqual(3);

      // Restore original start method
      FileWatcher.prototype.start = originalStart;

      await watcher.stop();
    });
  });
});
