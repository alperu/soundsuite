/**
 * Manual test script for ExhibitExtractor
 * 
 * Usage:
 *   npx ts-node src/lib/ingestion/test-exhibit-extractor.ts <path-to-pdf> <case-id> <document-id>
 * 
 * Example:
 *   npx ts-node src/lib/ingestion/test-exhibit-extractor.ts ./sample.pdf case-123 doc-456
 */

import { ExhibitExtractor } from './exhibit-extractor';
import * as path from 'path';

async function testExhibitExtractor() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: npx ts-node test-exhibit-extractor.ts <pdf-path> <case-id> <document-id>');
    console.error('Example: npx ts-node test-exhibit-extractor.ts ./sample.pdf case-123 doc-456');
    process.exit(1);
  }

  const [pdfPath, caseId, documentId] = args;

  console.log('=== Exhibit Extractor Test ===\n');
  console.log(`PDF File: ${pdfPath}`);
  console.log(`Case ID: ${caseId}`);
  console.log(`Document ID: ${documentId}\n`);

  const extractor = new ExhibitExtractor();

  try {
    console.log('Extracting exhibits...\n');
    const result = await extractor.extractExhibits(pdfPath, caseId, documentId);

    console.log(`✓ Extraction complete!`);
    console.log(`  Total exhibits found: ${result.totalCount}\n`);

    if (result.exhibits.length > 0) {
      console.log('Exhibit Details:');
      console.log('================\n');

      result.exhibits.forEach((exhibit, index) => {
        console.log(`Exhibit ${index + 1}:`);
        console.log(`  Page Number: ${exhibit.pageNumber}`);
        console.log(`  Image Path: ${exhibit.imagePath}`);
        console.log(`  OCR Confidence: ${exhibit.confidence?.toFixed(2)}%`);
        console.log(`  Extracted Text: ${exhibit.extractedText.substring(0, 100)}${exhibit.extractedText.length > 100 ? '...' : ''}`);
        console.log('');
      });

      console.log(`\nExhibits saved to: public/exhibits/${caseId}/`);
    } else {
      console.log('No exhibits found in this PDF.');
    }

  } catch (error) {
    console.error('Error during exhibit extraction:', error);
    process.exit(1);
  } finally {
    await extractor.terminate();
  }
}

testExhibitExtractor();
