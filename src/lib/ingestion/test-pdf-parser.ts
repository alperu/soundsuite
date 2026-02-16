/**
 * Manual test script for PDFParser
 * Run with: npx ts-node src/lib/ingestion/test-pdf-parser.ts <path-to-pdf>
 */

import { PDFParser } from './pdf-parser';

async function testPDFParser() {
  const pdfPath = process.argv[2];
  
  if (!pdfPath) {
    console.error('Usage: npx ts-node src/lib/ingestion/test-pdf-parser.ts <path-to-pdf>');
    process.exit(1);
  }

  console.log(`Testing PDFParser with file: ${pdfPath}\n`);

  const parser = new PDFParser();

  try {
    // Test getPageCount
    console.log('Testing getPageCount()...');
    const pageCount = await parser.getPageCount(pdfPath);
    console.log(`✓ Page count: ${pageCount}\n`);

    // Test extractText
    console.log('Testing extractText()...');
    const pages = await parser.extractText(pdfPath);
    console.log(`✓ Extracted text from ${pages.length} pages`);
    
    pages.forEach((page, index) => {
      console.log(`  Page ${page.pageNumber}:`);
      console.log(`    Text length: ${page.text.length} characters`);
      console.log(`    Text density: ${page.textDensity} characters/page`);
      console.log(`    Preview: ${page.text.substring(0, 100)}...`);
      
      // Check if OCR would be triggered (< 50 characters)
      if (page.textDensity < 50) {
        console.log(`    ⚠️  Low text density - OCR would be triggered`);
      }
      console.log();
    });

    // Test extractImages
    console.log('Testing extractImages()...');
    const images = await parser.extractImages(pdfPath);
    console.log(`✓ Extracted ${images.length} images`);
    
    images.forEach((image) => {
      console.log(`  Image on page ${image.pageNumber}, index ${image.imageIndex}:`);
      console.log(`    Dimensions: ${image.width}x${image.height}`);
      console.log(`    Buffer size: ${image.buffer.length} bytes`);
    });

    console.log('\n✅ All tests completed successfully!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testPDFParser();
