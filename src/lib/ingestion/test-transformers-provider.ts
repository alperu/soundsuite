/**
 * Manual test script for TransformersEmbeddingProvider
 * 
 * This script demonstrates how to use the TransformersEmbeddingProvider
 * and can be run manually to test the actual embedding generation.
 * 
 * Run with: npx ts-node src/lib/ingestion/test-transformers-provider.ts
 */

import { TransformersEmbeddingProvider } from './transformers-embedding-provider';

async function testTransformersProvider() {
  console.log('Testing TransformersEmbeddingProvider...\n');

  try {
    // Test 1: Create provider with default model
    console.log('1. Creating provider with default model (all-MiniLM-L6-v2)...');
    const provider = new TransformersEmbeddingProvider();
    console.log(`   ✓ Provider created`);
    console.log(`   - Dimensions: ${provider.getDimensions()}`);
    console.log(`   - Available models: ${provider.getAvailableModels().join(', ')}\n`);

    // Test 2: Check if model is downloaded
    console.log('2. Checking if model is downloaded...');
    const isDownloaded = await TransformersEmbeddingProvider.isModelDownloaded(
      'Xenova/all-MiniLM-L6-v2'
    );
    console.log(`   ${isDownloaded ? '✓' : '✗'} Model downloaded: ${isDownloaded}\n`);

    // Test 3: Get model size
    console.log('3. Getting model size...');
    const size = await TransformersEmbeddingProvider.getModelSize(
      'Xenova/all-MiniLM-L6-v2'
    );
    const estimatedSize = TransformersEmbeddingProvider.getEstimatedModelSize(
      'Xenova/all-MiniLM-L6-v2'
    );
    console.log(`   - Actual size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   - Estimated size: ${(estimatedSize / 1024 / 1024).toFixed(2)} MB\n`);

    // Test 4: Generate embeddings
    console.log('4. Generating embeddings for sample texts...');
    const texts = [
      'This is a legal document about contract law.',
      'The defendant was found guilty of fraud.',
      'The court ruled in favor of the plaintiff.',
    ];
    
    console.log('   Texts to embed:');
    texts.forEach((text, i) => console.log(`   ${i + 1}. "${text}"`));
    
    console.log('\n   Generating embeddings...');
    const startTime = Date.now();
    const embeddings = await provider.embed(texts);
    const duration = Date.now() - startTime;
    
    console.log(`   ✓ Generated ${embeddings.length} embeddings in ${duration}ms`);
    console.log(`   - Each embedding has ${embeddings[0].length} dimensions`);
    console.log(`   - First embedding sample: [${embeddings[0].slice(0, 5).map(v => v.toFixed(4)).join(', ')}, ...]\n`);

    // Test 5: Verify embedding properties
    console.log('5. Verifying embedding properties...');
    const allCorrectDimensions = embeddings.every(emb => emb.length === 384);
    const allNumbers = embeddings.every(emb => emb.every(v => typeof v === 'number'));
    const allNormalized = embeddings.every(emb => {
      const magnitude = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
      return Math.abs(magnitude - 1.0) < 0.01; // Should be normalized to unit length
    });
    
    console.log(`   ${allCorrectDimensions ? '✓' : '✗'} All embeddings have correct dimensions`);
    console.log(`   ${allNumbers ? '✓' : '✗'} All values are numbers`);
    console.log(`   ${allNormalized ? '✓' : '✗'} All embeddings are normalized\n`);

    // Test 6: Test batching
    console.log('6. Testing batch processing...');
    const largeBatch = Array(250).fill('Test text for batching');
    const batchStartTime = Date.now();
    const batchEmbeddings = await provider.embed(largeBatch);
    const batchDuration = Date.now() - batchStartTime;
    
    console.log(`   ✓ Processed ${largeBatch.length} texts in ${batchDuration}ms`);
    console.log(`   - Average time per text: ${(batchDuration / largeBatch.length).toFixed(2)}ms\n`);

    // Test 7: Test with different model
    console.log('7. Testing with all-mpnet-base-v2 model...');
    const provider2 = new TransformersEmbeddingProvider('Xenova/all-mpnet-base-v2');
    console.log(`   ✓ Provider created`);
    console.log(`   - Dimensions: ${provider2.getDimensions()}`);
    
    const isDownloaded2 = await TransformersEmbeddingProvider.isModelDownloaded(
      'Xenova/all-mpnet-base-v2'
    );
    console.log(`   ${isDownloaded2 ? '✓' : '✗'} Model downloaded: ${isDownloaded2}\n`);

    console.log('✅ All tests completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  testTransformersProvider().catch(console.error);
}

export { testTransformersProvider };
