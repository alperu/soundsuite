import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';

const logger = createLogger('reindex-pages');

/**
 * POST /api/documents/[id]/reindex-pages
 * Selectively reindex specific pages of a document without clearing the whole index.
 * Body: { pages: number[] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let previousStatus: string | null = null;

  try {
    const body = await request.json();
    const pages: number[] = body.pages;

    if (!Array.isArray(pages) || pages.length === 0) {
      return NextResponse.json({ error: 'pages must be a non-empty array of page numbers' }, { status: 400 });
    }
    if (pages.some(p => typeof p !== 'number' || p < 1)) {
      return NextResponse.json({ error: 'All page numbers must be positive integers' }, { status: 400 });
    }

    const doc = await prisma.document.findUnique({
      where: { id },
      include: { case: true, filing: true },
    });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Save previous status for restoration on error
    previousStatus = doc.status;

    // Set status to PROCESSING so home page reflects reindexing
    logger.info(`Starting reindex of ${pages.length} pages for document ${id}`, { pages });
    await prisma.document.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });

    // Publish SSE event so UI updates immediately
    try {
      const { publishDocumentEvent } = await import('@/lib/sse-events');
      await publishDocumentEvent({
        type: 'document_status_changed',
        caseId: doc.caseId,
        documentId: id,
        status: 'PROCESSING',
      });
    } catch {}

    // Lazy imports to avoid bundling heavy deps at module level
    const { getConfig } = await import('@/lib/db/config');
    const { PDFParser } = await import('@/lib/ingestion/pdf-parser');
    const { OCREngine, CachedOCREngine } = await import('@/lib/ingestion/ocr-engine');
    const { LangChainTextChunker } = await import('@/lib/ingestion/langchain-text-chunker');
    const { detectExhibitBoundaries, ExhibitExtractor } = await import('@/lib/ingestion/exhibit-extractor');
    const { VectorStore } = await import('@/lib/vector/vector-store');
    const { EmbeddingProvider } = await import('@/lib/ingestion/embedding-provider');
    const { preprocessImage } = await import('@/lib/ingestion/image-preprocessor');

    const config = await getConfig();

    // --- Instantiate embedding provider (same pattern as worker-init.ts) ---
    let embeddingProvider: import('@/lib/ingestion/embedding-provider').EmbeddingProvider;
    switch (config.embeddingProvider) {
      case 'openai': {
        const { OpenAIEmbeddingProvider } = await import('@/lib/ingestion/openai-embedding-provider');
        embeddingProvider = new OpenAIEmbeddingProvider(config.openaiApiKey || '', config.embeddingModel);
        break;
      }
      case 'claude': {
        const { ClaudeEmbeddingProvider } = await import('@/lib/ingestion/claude-embedding-provider');
        embeddingProvider = new ClaudeEmbeddingProvider(config.claudeApiKey || '', config.embeddingModel);
        break;
      }
      case 'ollama': {
        const { OllamaEmbeddingProvider } = await import('@/lib/ingestion/ollama-embedding-provider');
        embeddingProvider = new OllamaEmbeddingProvider({
          host: config.ollamaHost || 'http://localhost:11434',
          model: config.ollamaModel || config.embeddingModel || 'all-minilm',
          useOrchestrator: !!config.embeddingUseOrchestrator,
        });
        break;
      }
      default: {
        const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
        embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel);
        break;
      }
    }

    // --- Extract text for target pages ---
    const pdfParser = new PDFParser();
    const textChunker = new LangChainTextChunker();

    // Instantiate OCR engine based on config, wrapped in cache so
    // exhibit extraction reuses OCR results from the page fallback pass.
    let rawOcrEngine: import('@/lib/ingestion/ocr-engine').IOCREngine;
    if (config.ocrProvider === 'ollama') {
      const { OllamaOCREngine } = await import('@/lib/ingestion/ollama-ocr-engine');
      const ocrHost = config.ocrOllamaHost || config.ollamaHost || 'http://localhost:11434';
      const ocrModel = config.ocrOllamaModel || 'richardyoung/olmocr2:7b-q8';
      rawOcrEngine = new OllamaOCREngine({ host: ocrHost, model: ocrModel, useOrchestrator: !!config.ocrUseOrchestrator });
    } else {
      rawOcrEngine = new OCREngine();
    }
    const ocrEngine = new CachedOCREngine(rawOcrEngine);

    let documentLoaded = false;
    try {
      await pdfParser.loadDocument(doc.filePath);
      documentLoaded = true;

      logger.info('Extracting text from PDF...');
      const allPages = await pdfParser.extractText(doc.filePath);
      const targetPages = allPages.filter(p => pages.includes(p.pageNumber));
      logger.info(`Extracted text for ${targetPages.length} target pages out of ${allPages.length} total`);

      // --- OCR fallback for low-density pages ---
      const ocrThreshold = config.ocrThreshold || 50;
      let ocrPageCount = 0;
      const emptyPages: number[] = [];

      const preprocessSettings = {
        upscale: config.ocrUpscale,
        minWidth: config.ocrMinWidth,
        minDpi: config.ocrMinDpi,
        grayscale: config.ocrGrayscale,
        normalize: config.ocrNormalize,
        clahe: config.ocrClahe,
        claheClipLimit: config.ocrClaheClipLimit,
        sharpen: config.ocrSharpen,
        sharpenSigma: config.ocrSharpenSigma,
        resize: config.ocrResize,
        maxWidth: config.ocrMaxWidth,
        pngCompressionLevel: config.ocrPngCompression,
      };

      for (const page of targetPages) {
        logger.info(`Page ${page.pageNumber}: density=${page.textDensity}, threshold=${ocrThreshold}`);

        if (page.textDensity < ocrThreshold) {
          let ocrSuccess = false;

          // Phase 1: Try embedded image OCR (standard path)
          const hasImages = await pdfParser.pageHasImages(doc.filePath, page.pageNumber);
          if (hasImages) {
            logger.info(`Page ${page.pageNumber}: OCR needed (density ${page.textDensity} < threshold ${ocrThreshold})`);
            const candidate = await pdfParser.getOcrCandidateImage(doc.filePath, page.pageNumber);
            if (candidate) {
              let ocrBuffer = candidate.buffer;
              try {
                ocrBuffer = await preprocessImage(candidate.buffer, preprocessSettings);
                logger.info(`Page ${page.pageNumber}: preprocessed candidate image (${candidate.buffer.length} → ${ocrBuffer.length} bytes)`);
              } catch (err) {
                logger.warn(`Page ${page.pageNumber}: preprocessing failed, using raw image`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }

              const ocrResult = await ocrEngine.recognizeImage(ocrBuffer);
              if (ocrResult.text && ocrResult.text.trim().length > 0) {
                page.text = ocrResult.text;
                page.textDensity = ocrResult.text.length;
                page.renderFailed = false;
                ocrPageCount++;
                ocrSuccess = true;
                logger.info(`Page ${page.pageNumber}: OCR complete via candidate image, density=${page.textDensity}`);
              } else {
                logger.info(`Page ${page.pageNumber}: candidate image OCR returned no text`);
              }
            } else {
              logger.info(`Page ${page.pageNumber}: has images but no suitable OCR candidate (below size thresholds)`);
            }
          } else {
            logger.info(`Page ${page.pageNumber}: no embedded images detected`);
          }

          // Phase 2: Full-page render fallback — render the entire page to image and OCR it.
          // This catches: text-as-vector-paths, scanned pages with non-standard image formats,
          // and pages where getOcrCandidateImage filtered out images below size thresholds.
          if (!ocrSuccess && page.text.trim().length === 0) {
            logger.info(`Page ${page.pageNumber}: trying full-page render fallback for OCR`);
            try {
              const { renderPage } = await import('@/lib/pdf-page-renderer');
              const { withSemaphore } = await import('@/lib/render-semaphore');
              const rendered = await withSemaphore(() => renderPage(doc.filePath, page.pageNumber, 2.0));
              logger.info(`Page ${page.pageNumber}: rendered full page (${rendered.width}x${rendered.height}, ${rendered.buffer.length} bytes)`);

              let ocrBuffer = rendered.buffer;
              try {
                ocrBuffer = await preprocessImage(rendered.buffer, preprocessSettings);
                logger.info(`Page ${page.pageNumber}: preprocessed rendered page (${rendered.buffer.length} → ${ocrBuffer.length} bytes)`);
              } catch {
                // Use raw rendered buffer
              }

              const ocrResult = await ocrEngine.recognizeImage(ocrBuffer);
              if (ocrResult.text && ocrResult.text.trim().length > 0) {
                page.text = ocrResult.text;
                page.textDensity = ocrResult.text.length;
                page.renderFailed = false;
                ocrPageCount++;
                ocrSuccess = true;
                logger.info(`Page ${page.pageNumber}: full-page render OCR success, density=${page.textDensity}`);
              } else {
                logger.info(`Page ${page.pageNumber}: full-page render OCR returned no text`);
              }
            } catch (err) {
              logger.warn(`Page ${page.pageNumber}: full-page render fallback failed`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          if (!ocrSuccess && page.text.trim().length === 0) {
            logger.info(`Page ${page.pageNumber}: truly empty after all extraction attempts`);
            emptyPages.push(page.pageNumber);
          }
        }
      }

      // --- Update PageCache for processed pages ---
      for (const page of targetPages) {
        const isEmpty = emptyPages.includes(page.pageNumber) || (page.text.trim().length === 0 && page.textDensity === 0);
        const source = isEmpty ? 'empty' : (page.textDensity >= ocrThreshold ? 'extract' : 'ocr');
        try {
          await (prisma as any).pageCache.upsert({
            where: { documentId_pageNumber: { documentId: id, pageNumber: page.pageNumber } },
            create: { documentId: id, pageNumber: page.pageNumber, text: page.text, textDensity: page.textDensity, source },
            update: { text: page.text, textDensity: page.textDensity, source },
          });
        } catch {
          // Non-critical — continue
        }
      }

      // --- Exhibit detection + extraction for target pages ---
      const exhibitBoundaries = detectExhibitBoundaries(targetPages);
      const exhibitExtractor = new ExhibitExtractor('public', pdfParser, ocrEngine);
      let exhibitCount = 0;
      let exhibitChunks: import('@/lib/ingestion/text-chunker').Chunk[] = [];

      if (exhibitBoundaries.length > 0) {
        logger.info(`Detected ${exhibitBoundaries.length} exhibit boundaries`);
        const exhibitResult = await exhibitExtractor.extractExhibits(
          doc.filePath, doc.caseId, id, exhibitBoundaries
        );
        exhibitCount = exhibitResult.totalCount;

        for (const exhibit of exhibitResult.exhibits) {
          if (exhibit.extractedText && exhibit.extractedText.trim().length > 0) {
            const chunks = await textChunker.chunkExhibitText(
              exhibit.extractedText,
              {
                pageNumber: exhibit.pageNumber,
                imagePath: exhibit.imagePath,
                ocrText: exhibit.extractedText,
                documentId: id,
                caseId: doc.caseId,
              }
            );
            exhibitChunks.push(...chunks);
          }
        }
      }

      // --- Chunk target pages (exclude empty pages) ---
      const nonEmptyPages = targetPages.filter(p => !emptyPages.includes(p.pageNumber));
      const pageChunks = await textChunker.chunkPages(nonEmptyPages, id, doc.caseId);
      const allChunks = [...pageChunks, ...exhibitChunks];
      logger.info(`Chunking: ${nonEmptyPages.length} non-empty pages → ${pageChunks.length} page chunks, ${exhibitChunks.length} exhibit chunks`);

      // --- Enrich chunks with filing metadata (same as ingestion-pipeline.ts:681-694) ---
      for (const chunk of allChunks) {
        chunk.metadata.filingId = doc.filing?.id;
        chunk.metadata.filingType = doc.filing?.filingType || doc.documentType || undefined;
        chunk.metadata.volumeNumber = (doc.filing as any)?.volumeNumber ?? undefined;
        chunk.metadata.caseNumber = doc.case?.caseNumber || undefined;
        chunk.metadata.documentType = doc.documentType || undefined;
      }

      // --- Generate embeddings ---
      const batchSize = config.embeddingBatchSize || 50;
      const embeddedChunks: import('@/lib/ingestion/embedding-provider').EmbeddedChunk[] = [];
      logger.info(`Generating embeddings for ${allChunks.length} chunks (batch size ${batchSize})`);

      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);
        const texts = batch.map(c => c.text);
        const embeddings = await embeddingProvider.embed(texts);
        for (let j = 0; j < batch.length; j++) {
          embeddedChunks.push({
            text: batch[j].text,
            embedding: embeddings[j],
            metadata: batch[j].metadata,
          });
        }
      }

      // --- Delete old chunks for these pages, then insert new ones ---
      const vectorStore = new VectorStore({
        dbPath: process.env.LANCEDB_PATH || './data/lancedb',
        tableName: process.env.LANCEDB_TABLE || 'chunks',
      });
      await vectorStore.initialize();
      logger.info(`Clearing old vectors for pages [${pages.join(', ')}]`);
      await vectorStore.deleteByPages(id, pages);

      if (embeddedChunks.length > 0) {
        await vectorStore.insertChunks(embeddedChunks);
        logger.info(`Inserted ${embeddedChunks.length} new vectors`);
      }

      // Cleanup
      await ocrEngine.terminate();
      await exhibitExtractor.terminate();
      textChunker.dispose();

      // Restore status to INDEXED
      await prisma.document.update({
        where: { id },
        data: { status: 'INDEXED' },
      });

      // Publish SSE event for status restoration
      try {
        const { publishDocumentEvent } = await import('@/lib/sse-events');
        await publishDocumentEvent({
          type: 'document_status_changed',
          caseId: doc.caseId,
          documentId: id,
          status: 'INDEXED',
        });
      } catch {}

      logger.info(`Reindex complete: ${targetPages.length} pages, ${embeddedChunks.length} chunks, ${ocrPageCount} OCR, ${emptyPages.length} empty`);

      return NextResponse.json({
        success: true,
        pagesProcessed: targetPages.length,
        chunksCreated: embeddedChunks.length,
        ocrPages: ocrPageCount,
        exhibitCount,
        emptyPages,
      });
    } finally {
      if (documentLoaded) {
        try { await pdfParser.releaseDocument(doc.filePath); } catch {}
      }
    }
  } catch (error) {
    logger.error('Reindex failed', error);

    // Restore previous status on failure
    if (previousStatus) {
      try {
        await prisma.document.update({
          where: { id },
          data: { status: previousStatus },
        });
        const { publishDocumentEvent } = await import('@/lib/sse-events');
        await publishDocumentEvent({
          type: 'document_status_changed',
          caseId: (await prisma.document.findUnique({ where: { id }, select: { caseId: true } }))?.caseId || '',
          documentId: id,
          status: previousStatus,
        });
      } catch {}
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reindex pages' },
      { status: 500 }
    );
  }
}
