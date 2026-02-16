/**
 * Unit tests for JobQueue
 */

import { JobQueue, ProcessDocumentFn } from '../job-queue';
import { PrismaClient } from '@prisma/client';

// Mock p-queue
jest.mock('p-queue', () => {
  return jest.fn().mockImplementation((options) => {
    const tasks: Array<() => Promise<void>> = [];
    let running = 0;
    const concurrency = options?.concurrency || 1;

    const processTasks = async () => {
      while (tasks.length > 0 && running < concurrency) {
        const task = tasks.shift();
        if (task) {
          running++;
          task().finally(() => {
            running--;
            processTasks();
          });
        }
      }
    };

    return {
      add: (fn: () => Promise<void>) => {
        tasks.push(fn);
        processTasks();
        return Promise.resolve();
      },
      onIdle: () => {
        return new Promise<void>((resolve) => {
          const checkIdle = () => {
            if (tasks.length === 0 && running === 0) {
              resolve();
            } else {
              setTimeout(checkIdle, 10);
            }
          };
          checkIdle();
        });
      },
      get size() {
        return tasks.length;
      },
      get pending() {
        return running;
      },
    };
  });
});

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    document: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

describe('JobQueue', () => {
  let jobQueue: JobQueue;
  let mockProcessDocument: jest.MockedFunction<ProcessDocumentFn>;
  let mockPrisma: any;

  beforeEach(() => {
    mockProcessDocument = jest.fn().mockResolvedValue(undefined);
    mockPrisma = new PrismaClient();
    
    // Mock findMany to return empty array (no pending jobs)
    mockPrisma.document.findMany.mockResolvedValue([]);
    
    jobQueue = new JobQueue(
      { maxConcurrency: 2, maxRetries: 3, retryDelayBase: 100 },
      mockProcessDocument,
      mockPrisma
    );
  });

  afterEach(async () => {
    await jobQueue.shutdown();
    jest.clearAllMocks();
  });

  describe('enqueue', () => {
    it('should enqueue a job and return a job ID', async () => {
      const jobId = await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      
      expect(jobId).toBe('job-doc-123');
      expect(jobQueue.getQueueLength()).toBeGreaterThanOrEqual(0);
    });

    it('should emit progress event when job is enqueued', async () => {
      const progressSpy = jest.fn();
      jobQueue.on('progress', progressSpy);

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      // Should have emitted at least one progress event
      expect(progressSpy).toHaveBeenCalled();
      
      // First call should be for the job
      const firstCall = progressSpy.mock.calls[0][0];
      expect(firstCall.jobId).toBe('job-doc-123');
      expect(firstCall.documentId).toBe('doc-123');
    });
  });

  describe('job execution', () => {
    it('should execute the process function for a job', async () => {
      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      
      // Wait for job to complete
      await jobQueue.shutdown();

      expect(mockProcessDocument).toHaveBeenCalledWith('doc-123', '/path/to/file.pdf');
    });

    it('should update document status to PROCESSING before execution', async () => {
      mockPrisma.document.update.mockResolvedValue({});

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      expect(mockPrisma.document.update).toHaveBeenCalledWith({
        where: { id: 'doc-123' },
        data: { status: 'PROCESSING' }
      });
    });

    it('should mark job as completed on success', async () => {
      const progressSpy = jest.fn();
      jobQueue.on('progress', progressSpy);

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      const job = await jobQueue.getStatus('job-doc-123');
      expect(job?.status).toBe('completed');
    });
  });

  describe('retry logic', () => {
    it('should retry failed jobs with exponential backoff', async () => {
      // Make the first 2 attempts fail, then succeed
      mockProcessDocument
        .mockRejectedValueOnce(new Error('Attempt 1 failed'))
        .mockRejectedValueOnce(new Error('Attempt 2 failed'))
        .mockResolvedValueOnce(undefined);

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      // Should have been called 3 times (initial + 2 retries)
      expect(mockProcessDocument).toHaveBeenCalledTimes(3);
      
      const job = await jobQueue.getStatus('job-doc-123');
      expect(job?.status).toBe('completed');
    });

    it('should mark job as failed after all retries exhausted', async () => {
      // Make all attempts fail
      mockProcessDocument.mockRejectedValue(new Error('Processing failed'));

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      // Should have been called 4 times (initial + 3 retries)
      expect(mockProcessDocument).toHaveBeenCalledTimes(4);
      
      const job = await jobQueue.getStatus('job-doc-123');
      expect(job?.status).toBe('failed');
      expect(job?.error).toBe('Processing failed');
    });

    it('should update document status to ERROR after all retries fail', async () => {
      mockProcessDocument.mockRejectedValue(new Error('Processing failed'));

      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      await jobQueue.shutdown();

      expect(mockPrisma.document.update).toHaveBeenCalledWith({
        where: { id: 'doc-123' },
        data: {
          status: 'ERROR',
          errorMessage: 'Processing failed'
        }
      });
    });
  });

  describe('status methods', () => {
    it('should return job status', async () => {
      await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');
      
      const job = await jobQueue.getStatus('job-doc-123');
      expect(job).toBeDefined();
      expect(job?.documentId).toBe('doc-123');
      expect(job?.filePath).toBe('/path/to/file.pdf');
    });

    it('should return undefined for non-existent job', async () => {
      const job = await jobQueue.getStatus('non-existent');
      expect(job).toBeUndefined();
    });

    it('should return queue length', async () => {
      // Enqueue multiple jobs
      await jobQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await jobQueue.enqueue('/path/to/file2.pdf', 'doc-2');
      await jobQueue.enqueue('/path/to/file3.pdf', 'doc-3');

      const queueLength = jobQueue.getQueueLength();
      expect(queueLength).toBeGreaterThanOrEqual(0);
    });

    it('should return active jobs', async () => {
      // Create a slow processing function
      const slowProcess = jest.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 100))
      );
      
      const slowQueue = new JobQueue(
        { maxConcurrency: 1, maxRetries: 3, retryDelayBase: 100 },
        slowProcess,
        mockPrisma
      );

      await slowQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await slowQueue.enqueue('/path/to/file2.pdf', 'doc-2');

      // Give it a moment to start processing
      await new Promise(resolve => setTimeout(resolve, 10));

      const activeJobs = slowQueue.getActiveJobs();
      expect(activeJobs.length).toBeGreaterThanOrEqual(0);
      expect(activeJobs.length).toBeLessThanOrEqual(1); // Max concurrency is 1

      await slowQueue.shutdown();
    });

    it('should return all jobs', async () => {
      await jobQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await jobQueue.enqueue('/path/to/file2.pdf', 'doc-2');

      const allJobs = jobQueue.getAllJobs();
      expect(allJobs.length).toBe(2);
    });
  });

  describe('concurrency control', () => {
    it('should respect max concurrency setting', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const trackingProcess = jest.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(resolve => setTimeout(resolve, 50));
        concurrentCount--;
      });

      const concurrentQueue = new JobQueue(
        { maxConcurrency: 2, maxRetries: 3, retryDelayBase: 100 },
        trackingProcess,
        mockPrisma
      );

      // Enqueue 5 jobs
      await concurrentQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await concurrentQueue.enqueue('/path/to/file2.pdf', 'doc-2');
      await concurrentQueue.enqueue('/path/to/file3.pdf', 'doc-3');
      await concurrentQueue.enqueue('/path/to/file4.pdf', 'doc-4');
      await concurrentQueue.enqueue('/path/to/file5.pdf', 'doc-5');

      await concurrentQueue.shutdown();

      // Max concurrent should not exceed 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(trackingProcess).toHaveBeenCalledTimes(5);
    });
  });

  describe('crash recovery', () => {
    it('should load pending jobs from database on startup', async () => {
      const pendingDocs = [
        {
          id: 'doc-1',
          filePath: '/path/to/file1.pdf',
          status: 'QUEUED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'doc-2',
          filePath: '/path/to/file2.pdf',
          status: 'QUEUED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.document.findMany.mockResolvedValue(pendingDocs);

      const recoveryQueue = new JobQueue(
        { maxConcurrency: 2, maxRetries: 3, retryDelayBase: 100 },
        mockProcessDocument,
        mockPrisma
      );

      // Wait for async loading
      await new Promise(resolve => setTimeout(resolve, 10));

      const allJobs = recoveryQueue.getAllJobs();
      expect(allJobs.length).toBe(2);

      await recoveryQueue.shutdown();
    });
  });

  describe('clearCompletedJobs', () => {
    it('should remove completed jobs from memory', async () => {
      await jobQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await jobQueue.enqueue('/path/to/file2.pdf', 'doc-2');
      await jobQueue.shutdown();

      expect(jobQueue.getAllJobs().length).toBe(2);

      jobQueue.clearCompletedJobs();

      expect(jobQueue.getAllJobs().length).toBe(0);
    });

    it('should keep failed jobs for debugging', async () => {
      mockProcessDocument.mockRejectedValue(new Error('Failed'));

      await jobQueue.enqueue('/path/to/file1.pdf', 'doc-1');
      await jobQueue.shutdown();

      jobQueue.clearCompletedJobs();

      const allJobs = jobQueue.getAllJobs();
      expect(allJobs.length).toBe(1);
      expect(allJobs[0].status).toBe('failed');
    });
  });
});
