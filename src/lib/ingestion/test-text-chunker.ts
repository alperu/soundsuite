import { TextChunker, PageText, Exhibit } from './text-chunker';

async function testTextChunker() {
  console.log('=== Testing TextChunker ===\n');

  // Test 1: Basic chunking with GPT tokenizer
  console.log('Test 1: Basic chunking with GPT tokenizer');
  const chunker1 = new TextChunker({
    chunkSize: 512,
    overlapSize: 50,
    tokenizer: 'huggingface',
  });

  const pages: PageText[] = [
    {
      pageNumber: 1,
      text: `This is a legal document. It contains important information about the case. 
      The plaintiff alleges that the defendant violated the terms of the contract. 
      The contract was signed on January 15, 2023. The defendant denies all allegations.`,
    },
    {
      pageNumber: 2,
      text: `The court finds that the evidence presented is sufficient to proceed with the case. 
      A hearing is scheduled for March 1, 2024. Both parties are required to submit their briefs by February 15, 2024.`,
    },
  ];

  const chunks1 = await chunker1.chunkPages(pages, 'doc-001', 'case-001');
  console.log(`Created ${chunks1.length} chunks`);
  chunks1.forEach((chunk, index) => {
    console.log(`\nChunk ${index}:`);
    console.log(`  Page: ${chunk.metadata.pageNumber}`);
    console.log(`  Text: ${chunk.text.substring(0, 100)}...`);
    console.log(`  Is Exhibit: ${chunk.metadata.isExhibit}`);
  });
  chunker1.dispose();

  // Test 2: Exhibit chunking
  console.log('\n\nTest 2: Exhibit chunking');
  const chunker2 = new TextChunker({
    chunkSize: 512,
    overlapSize: 50,
    tokenizer: 'huggingface',
  });

  const exhibit: Exhibit = {
    pageNumber: 5,
    imagePath: '/exhibits/case-001/doc-001_page5_img0.png',
    ocrText: 'This is text extracted from an exhibit image. It shows a photograph of the accident scene. The timestamp indicates 3:45 PM.',
    documentId: 'doc-001',
    caseId: 'case-001',
  };

  const chunks2 = await chunker2.chunkExhibitText(exhibit.ocrText, exhibit);
  console.log(`Created ${chunks2.length} exhibit chunks`);
  chunks2.forEach((chunk, index) => {
    console.log(`\nExhibit Chunk ${index}:`);
    console.log(`  Page: ${chunk.metadata.pageNumber}`);
    console.log(`  Text: ${chunk.text}`);
    console.log(`  Is Exhibit: ${chunk.metadata.isExhibit}`);
    console.log(`  Exhibit Path: ${chunk.metadata.exhibitPath}`);
  });
  chunker2.dispose();

  // Test 3: Long text with multiple chunks
  console.log('\n\nTest 3: Long text with multiple chunks and overlap');
  const chunker3 = new TextChunker({
    chunkSize: 50, // Small size to demonstrate chunking
    overlapSize: 10,
    tokenizer: 'simple',
  });

  const longText = `The Supreme Court of the United States is the highest court in the federal judiciary. 
  It has ultimate appellate jurisdiction over all federal court cases. The Court consists of nine justices. 
  The Chief Justice presides over the Court. Associate justices are appointed by the President. 
  They must be confirmed by the Senate. Justices serve for life unless they resign or are impeached.`;

  const longPages: PageText[] = [
    {
      pageNumber: 1,
      text: longText,
    },
  ];

  const chunks3 = await chunker3.chunkPages(longPages, 'doc-002', 'case-002');
  console.log(`Created ${chunks3.length} chunks from long text`);
  chunks3.forEach((chunk, index) => {
    console.log(`\nChunk ${index}:`);
    console.log(`  Text: ${chunk.text}`);
    console.log(`  Chunk Index: ${chunk.metadata.chunkIndex}`);
  });
  chunker3.dispose();

  console.log('\n=== All tests completed successfully ===');
}

// Run the test
testTextChunker().catch(console.error);
