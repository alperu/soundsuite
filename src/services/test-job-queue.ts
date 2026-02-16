/**
 * Test script for JobQueue
 * 
 * This script demonstrates the JobQueue functionality with a simple example.
 * Run with: npx ts-node src/services/test-job-queue.ts
 */

import { JobQueue } from './job-queue';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Mock processing function that simulates document processing
async function processDocument(documentId: string, filePath: string): Promise<void> {
  console.log(`Processing document ${documentId} from ${filePath}...`);
  
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Randomly fail some jobs to test retry logic
  if (Math.random() < 0.3) {
    throw new Error(`Random failure for ${documentId}`);
  }
  
  console.log(`✓ Successfully processed ${documentId}`);
}

async function main() {
  console.log('JobQueue Test Script\n');
  
  // Create job queue with concurrency of 2
  const jobQueue = new JobQueue(
    {
      maxConcurrency: 2,
      maxRetries: 3,
      retryDelayBase: 500, // 500ms base delay
    },
    processDocument,
    prisma
  );

  // Listen to progress events
  jobQueue.on('progress', (event) => {
    console.log(`[Progress] Job ${event.jobId}: ${event.status} (attempt ${event.attempt})`);
    if (event.error) {
      console.log(`  Error: ${event.error}`);
    }
  });

  console.log('Enqueueing 5 jobs...\n');

  // Enqueue some jobs
  const jobIds = await Promise.all([
    jobQueue.enqueue('/path/to/doc1.pdf', 'doc-1'),
    jobQueue.enqueue('/path/to/doc2.pdf', 'doc-2'),
    jobQueue.enqueue('/path/to/doc3.pdf', 'doc-3'),
    jobQueue.enqueue('/path/to/doc4.pdf', 'doc-4'),
    jobQueue.enqueue('/path/to/doc5.pdf', 'doc-5'),
  ]);

  console.log(`Enqueued ${jobIds.length} jobs`);
  console.log(`Queue length: ${jobQueue.getQueueLength()}`);
  console.log(`Active jobs: ${jobQueue.getActiveJobs().length}\n`);

  // Wait for all jobs to complete
  console.log('Waiting for jobs to complete...\n');
  await jobQueue.shutdown();

  console.log('\n=== Final Status ===');
  const allJobs = jobQueue.getAllJobs();
  
  const completed = allJobs.filter(j => j.status === 'completed').length;
  const failed = allJobs.filter(j => j.status === 'failed').length;
  
  console.log(`Total jobs: ${allJobs.length}`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);
  
  console.log('\n=== Job Details ===');
  allJobs.forEach(job => {
    console.log(`${job.id}: ${job.status} (${job.attempt} attempts)`);
    if (job.error) {
      console.log(`  Error: ${job.error}`);
    }
  });

  await prisma.$disconnect();
}

main().catch(console.error);
