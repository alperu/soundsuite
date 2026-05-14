import { PDFParser, PageText } from '../ingestion/pdf-parser';
import { OCREngine } from '../ingestion/ocr-engine';
import { LegalTextSplitter } from '../ingestion/legal-text-splitter';
import type { Chunk } from '../ingestion/text-chunker';
import type { EmbeddedChunk } from '../ingestion/embedding-provider';
import { getToolRegistry } from '../mcp/get-tool-registry';
import { getChatVectorStore } from './chat-vector-store';
import { prisma } from '../db/prisma';
import { logger } from '../logger';

const OCR_DENSITY_THRESHOLD = 0.01;

export interface ChatIngestResult {
  pageCount: number;
  chunkCount: number;
  ocrPages: number;
}

export async function ingestChatAttachment(opts: {
  attachmentId: string;
  chatId: string;
  filePath: string;
  fileName: string;
}): Promise<ChatIngestResult> {
  const { attachmentId, chatId, filePath, fileName } = opts;

  await prisma.chatAttachment.update({
    where: { id: attachmentId },
    data: { status: 'PROCESSING', error: null },
  });

  try {
    const pdfParser = new PDFParser();
    let pages: PageText[] = await pdfParser.extractText(filePath);

    let ocrPages = 0;
    const lowDensityPages = pages.filter(
      (p) => p.renderFailed || p.textDensity < OCR_DENSITY_THRESHOLD,
    );

    if (lowDensityPages.length > 0) {
      const ocr = new OCREngine({ language: 'eng' });
      try {
        for (const page of lowDensityPages) {
          try {
            const hasImages = await pdfParser.pageHasImages(filePath, page.pageNumber);
            if (!hasImages) continue;
            const imageBuf = await pdfParser.renderPageToImage(filePath, page.pageNumber);
            const result = await ocr.recognizeImage(imageBuf);
            if (result.text && result.text.trim().length > 0) {
              page.text = result.text;
              page.textDensity = Math.max(0.5, result.text.length / 1000);
              page.renderFailed = false;
              ocrPages++;
            }
          } catch (err) {
            logger.warn('chat-ingest: OCR failed for page', {
              attachmentId,
              pageNumber: page.pageNumber,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        await ocr.terminate();
      }
    }

    const splitter = new LegalTextSplitter({ chunkSize: 512, overlapSize: 64, tokenizer: 'simple' });
    const chunks: Chunk[] = await splitter.chunkPages(pages, attachmentId, chatId, {
      caseName: undefined,
      filingType: undefined,
      documentSummary: fileName,
    });

    if (chunks.length === 0) {
      await prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: { status: 'INDEXED', pageCount: pages.length, chunkCount: 0 },
      });
      return { pageCount: pages.length, chunkCount: 0, ocrPages };
    }

    const registry = await getToolRegistry();
    const embeddingProvider = registry.getContext().embeddingProvider;
    if (!embeddingProvider) {
      throw new Error('Embedding provider not configured');
    }

    const batchSize = 32;
    const embedded: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const vectors = await embeddingProvider.embed(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j++) {
        embedded.push({
          text: batch[j].text,
          embedding: vectors[j],
          metadata: batch[j].metadata,
        });
      }
    }

    const vs = await getChatVectorStore(chatId);
    await vs.insertChunks(embedded);

    await prisma.chatAttachment.update({
      where: { id: attachmentId },
      data: {
        status: 'INDEXED',
        pageCount: pages.length,
        chunkCount: embedded.length,
      },
    });

    logger.info('chat-ingest: completed', {
      attachmentId,
      chatId,
      pageCount: pages.length,
      chunkCount: embedded.length,
      ocrPages,
    });

    return { pageCount: pages.length, chunkCount: embedded.length, ocrPages };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('chat-ingest: failed', { attachmentId, chatId, error: msg });
    await prisma.chatAttachment.update({
      where: { id: attachmentId },
      data: { status: 'ERROR', error: msg },
    });
    throw error;
  }
}
