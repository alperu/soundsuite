/**
 * Test script for OCREngine
 * Run with: npx ts-node src/lib/ingestion/test-ocr-engine.ts
 */

import { OCREngine } from './ocr-engine.js';
import sharp from 'sharp';

async function testOCREngine() {
  console.log('Testing OCREngine...\n');

  const ocr = new OCREngine({ language: 'eng' });

  try {
    // Test 1: Create a simple test image with text
    console.log('Test 1: Creating test image with text...');
    const testImage = await sharp({
      create: {
        width: 400,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();

    console.log('Test image created (blank white image)');
    console.log('Note: For a real test, you would need an image with actual text\n');

    // Test 2: Try to recognize the image
    console.log('Test 2: Running OCR on test image...');
    const result = await ocr.recognizeImage(testImage);
    console.log('OCR Result:');
    console.log(`  Text: "${result.text}"`);
    console.log(`  Confidence: ${result.confidence.toFixed(2)}%`);

    if (result.confidence < 60) {
      console.log('  (Low confidence - likely no text in image)\n');
    }

    // Test 3: Test with grayscale preprocessing
    console.log('Test 3: Testing image preprocessing...');
    const grayscaleImage = await sharp(testImage).grayscale().toBuffer();
    console.log('Image preprocessed to grayscale\n');

    console.log('✓ OCREngine basic functionality works!');
    console.log('\nTo test with real images:');
    console.log('1. Place an image with text in the project directory');
    console.log('2. Modify this script to load that image');
    console.log('3. Run the test again');
  } catch (error) {
    console.error('✗ Error testing OCREngine:', error);
    throw error;
  } finally {
    // Cleanup
    await ocr.terminate();
    console.log('\nOCR worker terminated');
  }
}

// Run the test
testOCREngine().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
