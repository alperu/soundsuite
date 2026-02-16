/**
 * End-to-end integration test for the ingestion pipeline
 * 
 * This test verifies the complete workflow:
 * 1. Creates a real PDF file
 * 2. Processes it through the ingestion pipeline
 * 3. Verifies text extraction, chunking, embedding, and indexing
 * 4. Verifies data is stored in both SQLite and LanceDB
 */

import { IngestionPipeline } from '../ingestion-pipeline';
import { PDFParser } from '../pdf-parser';
import { OCREngine } from '../ocr-engine';
import { TextChunker } from '../text-chunker';
import { TransformersEmbeddingProvider } from '../transformers-embedding-provider';
import { VectorStore } from '../../vector/vector-store';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

describe('Ingestion Pipeline E2E', () => {
  let pipeline: IngestionPipeline;
  let pdfParser: PDFParser;
  let ocrEngine: OCREngine;
  let textChunker: TextChunker;
  let embeddingProvider: TransformersEmbeddingProvider;
  let vectorStore: VectorStore;
  let database: PrismaClient;
  
  let testDir: string;
  let testPdfPath: string;
  let testCaseId: string;
  let testDocumentId: string;

  beforeAll(async () => {
    // Create test directory
    testDir = path.join(__dirname, '../../../../data/test-e2e');
    await fs.mkdir(testDir, { recursive: true });

    // Initialize components
    database = new PrismaClient();
    pdfParser = new PDFParser();
    ocrEngine = new OCREngine();
    textChunker = new TextChunker({
      chunkSize: 512,
      overlapSize: 50,
      tokenizer: 'simple',
    });
    embeddingProvider = new TransformersEmbeddingProvider({
      provider: 'transformers',
      model: 'Xenova/all-MiniLM-L6-v2',
    });
    vectorStore = new VectorStore({
      dbPath: path.join(testDir, 'lancedb-test'),
      tableName: 'test_chunks',
    });

    await vectorStore.initialize();

    pipeline = new IngestionPipeline(
      pdfParser,
      ocrEngine,
      textChunker,
      embeddingProvider,
      vectorStore,
      database
    );

    // Create test case
    const testCase = await database.case.create({
      data: {
        name: 'E2E Test Case',
        path: testDir,
      },
    });
    testCaseId = testCase.id;
  });

  afterAll(async () => {
    // Cleanup
    await pipeline.terminate();
    await vectorStore.close();
    
    // Delete test case and documents
    if (testCaseId) {
      await database.document.deleteMany({
        where: { caseId: testCaseId },
      });
      await database.case.delete({
        where: { id: testCaseId },
      });
    }
    
    await database.$disconnect();

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  });

  it('should process a PDF document end-to-end', async () => {
    // Create a test PDF with multiple pages
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Page 1
    const page1 = pdfDoc.addPage([600, 400]);
    page1.drawText('Legal Document - Page 1', {
      x: 50,
      y: 350,
      size: 20,
      font,
      color: rgb(0, 0, 0),
    });
    page1.drawText(
      'This is a test legal document for the Sound Suite system. ' +
      'It contains multiple pages with text content that will be ' +
      'extracted, chunked, embedded, and indexed in the vector database.',
      {
        x: 50,
        y: 300,
        size: 12,
        font,
        color: rgb(0, 0, 0),
        maxWidth: 500,
      }
    );

    // Page 2
    const page2 = pdfDoc.addPage([600, 400]);
    page2.drawText('Legal Document - Page 2', {
      x: 50,
      y: 350,
      size: 20,
      font,
      color: rgb(0, 0, 0),
    });
    page2.drawText(
      'This page contains information about case law and precedents. ' +
      'The ingestion pipeline should extract this text and create ' +
      'searchable embeddings for semantic search capabilities.',
      {
        x: 50,
        y: 300,
        size: 12,
        font,
        color: rgb(0, 0, 0),
        maxWidth: 500,
      }
    );

    // Save PDF
    const pdfBytes = await pdfDoc.save();
    testPdfPath = path.join(testDir, 'test-document.pdf');
    await fs.writeFile(testPdfPath, pdfBytes);

    // Create document record
    const document = await database.document.create({
      data: {
        caseId: testCaseId,
        filePath: testPdfPath,
        fileName: 'test-document.pdf',
        hash: 'test-hash-' + Date.now(),
        status: 'QUEUED',
      },
    });
    testDocumentId = document.id;

    // Process the document
    const result = await pipeline.processDocument(testDocumentId, testPdfPath);

    // Verify processing succeeded
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.pageCount).toBe(2);
    expect(result.chunkCount).toBeGreaterThan(0);

    // Verify document status in database
    const updatedDoc = await database.document.findUnique({
      where: { id: testDocumentId },
    });
    expect(updatedDoc).toBeDefined();
    expect(updatedDoc!.status).toBe('INDEXED');
    expect(updatedDoc!.pageCount).toBe(2);

    // Verify embeddings in vector store
    const searchResults = await vectorStore.search({
      vector: await embeddingProvider.embed(['legal document']).then(e => e[0]),
      limit: 5,
    });

    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].metadata.documentId).toBe(testDocumentId);
    expect(searchResults[0].metadata.caseId).toBe(testCaseId);
    expect(searchResults[0].text).toContain('legal');

    console.log('✅ E2E Test Results:');
    console.log(`  - Pages extracted: ${result.pageCount}`);
    console.log(`  - Chunks created: ${result.chunkCount}`);
    console.log(`  - Exhibits found: ${result.exhibitCount || 0}`);
    console.log(`  - Search results: ${searchResults.length}`);
  }, 60000); // 60 second timeout for embedding generation

  it('should handle documents with low text density (OCR trigger)', async () => {
    // Create a PDF with minimal text (should trigger OCR)
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 400]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    // Add very little text (< 50 characters)
    page.drawText('Test', {
      x: 50,
      y: 350,
      size: 12,
      font,
      color: rgb(0, 0, 0),
    });

    const pdfBytes = await pdfDoc.save();
    const lowDensityPdfPath = path.join(testDir, 'low-density.pdf');
    await fs.writeFile(lowDensityPdfPath, pdfBytes);

    // Create document record
    const document = await database.document.create({
      data: {
        caseId: testCaseId,
        filePath: lowDensityPdfPath,
        fileName: 'low-density.pdf',
        hash: 'test-hash-low-density-' + Date.now(),
        status: 'QUEUED',
      },
    });

    // Process the document
    const result = await pipeline.processDocument(document.id, lowDensityPdfPath);

    // Verify processing succeeded
    expect(result.success).toBe(true);
    expect(result.pageCount).toBe(1);

    // Cleanup
    await database.document.delete({ where: { id: document.id } });
    await fs.unlink(lowDensityPdfPath);
  }, 60000);

  it('should handle errors gracefully', async () => {
    // Try to process a non-existent file
    const document = await database.document.create({
      data: {
        caseId: testCaseId,
        filePath: '/nonexistent/file.pdf',
        fileName: 'nonexistent.pdf',
        hash: 'test-hash-error-' + Date.now(),
        status: 'QUEUED',
      },
    });

    const result = await pipeline.processDocument(document.id, '/nonexistent/file.pdf');

    // Verify error handling
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // Verify document status is ERROR
    const updatedDoc = await database.document.findUnique({
      where: { id: document.id },
    });
    expect(updatedDoc!.status).toBe('ERROR');
    expect(updatedDoc!.errorMessage).toBeDefined();

    // Cleanup
    await database.document.delete({ where: { id: document.id } });
  });
});
