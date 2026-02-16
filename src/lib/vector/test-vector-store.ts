/**
 * Integration test script for VectorStore.
 * 
 * This script demonstrates the complete workflow of:
 * 1. Initializing the vector store
 * 2. Inserting embedded chunks
 * 3. Performing vector similarity search
 * 4. Performing hybrid search
 * 5. Deleting chunks by document
 * 
 * Run with: npx ts-node src/lib/vector/test-vector-store.ts
 */

import { VectorStore } from './vector-store.js';
import { EmbeddedChunk } from '../ingestion/embedding-provider.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = path.join(__dirname, 'test-demo-lancedb');

async function main() {
  console.log('🚀 VectorStore Integration Test\n');

  // Clean up any existing test database
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }

  // Initialize VectorStore
  console.log('1. Initializing VectorStore...');
  const vectorStore = new VectorStore({
    dbPath: TEST_DB_PATH,
    tableName: 'legal_chunks',
  });
  await vectorStore.initialize();
  console.log('   ✓ VectorStore initialized\n');

  // Create sample embedded chunks
  console.log('2. Creating sample embedded chunks...');
  const chunks: EmbeddedChunk[] = [
    {
      text: 'The defendant was charged with breach of contract on January 15, 2024.',
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
      metadata: {
        documentId: 'doc-001',
        caseId: 'case-001',
        pageNumber: 1,
        chunkIndex: 0,
        isExhibit: false,
      },
    },
    {
      text: 'The plaintiff filed a motion for summary judgment on February 20, 2024.',
      embedding: [0.2, 0.3, 0.4, 0.5, 0.6],
      metadata: {
        documentId: 'doc-001',
        caseId: 'case-001',
        pageNumber: 2,
        chunkIndex: 1,
        isExhibit: false,
      },
    },
    {
      text: 'Exhibit A shows the signed contract dated December 1, 2023.',
      embedding: [0.3, 0.4, 0.5, 0.6, 0.7],
      metadata: {
        documentId: 'doc-001',
        caseId: 'case-001',
        pageNumber: 5,
        chunkIndex: 2,
        isExhibit: true,
        exhibitPath: '/public/exhibits/case-001/doc-001_page5_img0.png',
      },
    },
    {
      text: 'The court ruled in favor of the plaintiff on March 15, 2024.',
      embedding: [0.4, 0.5, 0.6, 0.7, 0.8],
      metadata: {
        documentId: 'doc-002',
        caseId: 'case-001',
        pageNumber: 1,
        chunkIndex: 0,
        isExhibit: false,
      },
    },
  ];

  await vectorStore.insertChunks(chunks);
  console.log(`   ✓ Inserted ${chunks.length} chunks\n`);

  // Perform vector similarity search
  console.log('3. Performing vector similarity search...');
  const vectorResults = await vectorStore.search({
    vector: [0.15, 0.25, 0.35, 0.45, 0.55], // Similar to first chunk
    limit: 3,
  });
  console.log(`   ✓ Found ${vectorResults.length} results:`);
  vectorResults.forEach((result, i) => {
    console.log(`      ${i + 1}. [Score: ${result.score.toFixed(4)}] ${result.text.substring(0, 60)}...`);
  });
  console.log();

  // Perform text search
  console.log('4. Performing text search for "contract"...');
  const textResults = await vectorStore.search({
    hybridQuery: 'contract',
    limit: 5,
  });
  console.log(`   ✓ Found ${textResults.length} results:`);
  textResults.forEach((result, i) => {
    console.log(`      ${i + 1}. ${result.text}`);
  });
  console.log();

  // Perform hybrid search
  console.log('5. Performing hybrid search (vector + text)...');
  const hybridResults = await vectorStore.search({
    vector: [0.15, 0.25, 0.35, 0.45, 0.55],
    hybridQuery: 'plaintiff',
    limit: 5,
  });
  console.log(`   ✓ Found ${hybridResults.length} results:`);
  hybridResults.forEach((result, i) => {
    console.log(`      ${i + 1}. [Score: ${result.score.toFixed(4)}] ${result.text}`);
  });
  console.log();

  // Filter by case
  console.log('6. Filtering by caseId...');
  const caseResults = await vectorStore.search({
    vector: [0.5, 0.5, 0.5, 0.5, 0.5],
    filter: { caseId: 'case-001' },
    limit: 10,
  });
  console.log(`   ✓ Found ${caseResults.length} results for case-001\n`);

  // Filter by exhibit
  console.log('7. Filtering by isExhibit...');
  const exhibitResults = await vectorStore.search({
    vector: [0.5, 0.5, 0.5, 0.5, 0.5],
    filter: { isExhibit: true },
    limit: 10,
  });
  console.log(`   ✓ Found ${exhibitResults.length} exhibit chunks:`);
  exhibitResults.forEach((result, i) => {
    console.log(`      ${i + 1}. ${result.text}`);
    console.log(`         Path: ${result.metadata.exhibitPath}`);
  });
  console.log();

  // Delete chunks by document
  console.log('8. Deleting chunks for doc-001...');
  await vectorStore.deleteByDocument('doc-001');
  const remainingResults = await vectorStore.search({
    vector: [0.5, 0.5, 0.5, 0.5, 0.5],
    limit: 10,
  });
  console.log(`   ✓ Deleted chunks for doc-001`);
  console.log(`   ✓ Remaining chunks: ${remainingResults.length}\n`);

  // Clean up
  await vectorStore.close();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }

  console.log('✅ All tests completed successfully!\n');
}

main().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
