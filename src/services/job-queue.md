# JobQueue

The JobQueue class manages asynchronous document processing with concurrency control, retry logic, and crash recovery.

## Features

- **Concurrency Control**: Configurable number of concurrent jobs (default: 2)
- **Retry Logic**: Automatic retry with exponential backoff (3 attempts: 1s, 2s, 4s)
- **Crash Recovery**: Loads pending jobs from database on startup
- **Progress Events**: Emits events for Dashboard real-time updates
- **Status Tracking**: Monitor queue length, active jobs, and job status

## Usage

```typescript
import { JobQueue } from './services/job-queue';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Define your processing function
async function processDocument(documentId: string, filePath: string): Promise<void> {
  // Your document processing logic here
  console.log(`Processing ${filePath}...`);
}

// Create job queue
const jobQueue = new JobQueue(
  {
    maxConcurrency: 2,      // Process 2 jobs at a time
    maxRetries: 3,          // Retry failed jobs 3 times
    retryDelayBase: 1000,   // 1 second base delay for exponential backoff
  },
  processDocument,
  prisma
);

// Listen to progress events
jobQueue.on('progress', (event) => {
  console.log(`Job ${event.jobId}: ${event.status}`);
});

// Enqueue a job
const jobId = await jobQueue.enqueue('/path/to/file.pdf', 'doc-123');

// Check job status
const job = await jobQueue.getStatus(jobId);
console.log(job?.status); // 'pending', 'active', 'completed', or 'failed'

// Get queue metrics
console.log(`Queue length: ${jobQueue.getQueueLength()}`);
console.log(`Active jobs: ${jobQueue.getActiveJobs().length}`);

// Wait for all jobs to complete
await jobQueue.shutdown();
```

## Configuration

### JobConfig

```typescript
interface JobConfig {
  maxConcurrency: number;   // Maximum number of concurrent jobs
  maxRetries: number;       // Number of retry attempts for failed jobs
  retryDelayBase: number;   // Base delay in milliseconds for exponential backoff
}
```

**Default values:**
- `maxConcurrency`: 2
- `maxRetries`: 3
- `retryDelayBase`: 1000 (1 second)

### Retry Delays

With `retryDelayBase: 1000` and `maxRetries: 3`:
- Attempt 1: Immediate
- Attempt 2: 1 second delay
- Attempt 3: 2 seconds delay
- Attempt 4: 4 seconds delay

## Job Lifecycle

1. **Pending**: Job is enqueued and waiting to be processed
2. **Active**: Job is currently being processed
3. **Completed**: Job finished successfully
4. **Failed**: Job failed after all retry attempts

## Progress Events

The JobQueue emits `progress` events with the following structure:

```typescript
interface JobProgressEvent {
  jobId: string;
  documentId: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  attempt: number;
  error?: string;
}
```

## Database Integration

The JobQueue integrates with Prisma to:
- Update document status during processing
- Mark documents as ERROR after failed retries
- Load pending jobs on startup for crash recovery

## Methods

### `enqueue(filePath: string, documentId: string): Promise<string>`
Enqueue a new document processing job. Returns the job ID.

### `getStatus(jobId: string): Promise<Job | undefined>`
Get the current status of a specific job.

### `getQueueLength(): number`
Get the number of pending jobs in the queue.

### `getActiveJobs(): Job[]`
Get all currently active (processing) jobs.

### `getAllJobs(): Job[]`
Get all jobs (pending, active, completed, and failed).

### `shutdown(): Promise<void>`
Wait for all jobs to complete before shutting down.

### `clearCompletedJobs(): void`
Remove completed jobs from memory (keeps failed jobs for debugging).

## Error Handling

- Failed jobs are automatically retried with exponential backoff
- After all retries are exhausted, the job is marked as failed
- The associated document status is updated to ERROR in the database
- Error messages are stored in both the job and document records

## Testing

Run the test suite:
```bash
npm test -- src/services/__tests__/job-queue.test.ts
```

Run the demo script:
```bash
npx ts-node src/services/test-job-queue.ts
```

## Requirements Satisfied

This implementation satisfies the following requirements from the Sound Suite spec:

- **17.1**: Uses p-queue for job management
- **17.2**: Processes documents sequentially with configurable concurrency
- **17.3**: Supports configurable concurrency (default: 2)
- **17.4**: Implements retry logic with exponential backoff (3 attempts)
- **17.5**: Marks documents as ERROR after all retries fail
- **17.6**: Provides queue length and active jobs for Dashboard display
