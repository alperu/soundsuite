/**
 * Test script for IngestionPipeline
 * 
 * This script demonstrates how to use the IngestionPipeline to process documents.
 * It's meant for manual testing and verification.
 */

import { IngestionPipeline } from './ingestion-pipeline';
import { PDFParser } from './pdf-parser';
import { OCREngine } from './ocr-engine';
import { TextChunker } from './text-chunker';
import { TransformersEmbeddingProvider } from './transformers-embedding-provider';
import { VectorStore } from '../vector/vector-store';
import { prisma } from '../db/prisma';
import * as path from 'path';

async function testIngestionPipeline() {
  console.log('Testing IngestionPipeline...\n');

  // Initialize components
  const pdfParser = new PDFParser();
  const ocrEngine = new OCREngine({ language: 'eng' });
  const textChunker = new TextChunker({
    chunkSize: 512,
    overlapSize: 50,
    tokenizer: 'huggingface',
  });
  const embeddingProvider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
  const vectorStore = new VectorStore({
    dbPath: './data/lancedb-test',
    tableName: 'test_chunks',
  });

  // Initialize vector store
  await vectorStore.initialize();

  // Create pipeline
  const pipeline = new IngestionPipeline(
    pdfParser,
    ocrEngine,
    textChunker,
    embeddingProvider,
    vectorStore,
    prisma,
    {
      publicDir: 'public',
      ocrThreshold: 50,
    }
  );

  console.log('✓ IngestionPipeline created successfully\n');

  // Example: Create a test case and document
  try {
    // Create a test case
    const testCase = await prisma.case.upsert({
      where: { path: '/test/case' },
      update: {},
      create: {
        name: 'Test Case',
        path: '/test/case',
      },
    });

    console.log(`✓ Test case created: ${testCase.id}\n`);

    // Create a test document
    const testDocument = await prisma.document.create({
      data: {
        caseId: testCase.id,
        filePath: '/test/sample.pdf',
        fileName: 'sample.pdf',
        hash: 'test-hash-' + Date.now(),
        status: 'QUEUED',
      },
    });

    console.log(`✓ Test document created: ${testDocument.id}`);
    console.log(`  Status: ${testDocument.status}\n`);

    // Note: To actually process a document, you would need a real PDF file:
    // const result = await pipeline.processDocument(testDocument.id, '/path/to/real.pdf');
    // console.log('Processing result:', result);

    console.log('Pipeline is ready to process documents!');
    console.log('\nTo process a real document:');
    console.log('1. Place a PDF file in a monitored directory');
    console.log('2. The FileWatcher will detect it and create a Document record');
    console.log('3. The JobQueue will call pipeline.processDocument()');
    console.log('4. The document will go through: QUEUED → PROCESSING → INDEXED\n');

    // Cleanup
    await prisma.document.delete({ where: { id: testDocument.id } });
    await prisma.case.delete({ where: { id: testCase.id } });
    console.log('✓ Test data cleaned up');

  } catch (error) {
    console.error('Error during test:', error);
  } finally {
    // Cleanup resources
    await pipeline.terminate();
    await vectorStore.close();
    console.log('\n✓ Resources cleaned up');
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testIngestionPipeline()
    .then(() => {
      console.log('\n✅ Test completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    });
}

export { testIngestionPipeline };
