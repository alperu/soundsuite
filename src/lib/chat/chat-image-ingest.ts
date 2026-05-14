import * as fs from 'fs/promises';
import { OCREngine } from '../ingestion/ocr-engine';
import { LegalTextSplitter } from '../ingestion/legal-text-splitter';
import type { Chunk } from '../ingestion/text-chunker';
import type { PageText } from '../ingestion/pdf-parser';
import type { EmbeddedChunk } from '../ingestion/embedding-provider';
import { getToolRegistry } from '../mcp/get-tool-registry';
import { getChatVectorStore } from './chat-vector-store';
import { prisma } from '../db/prisma';
import { logger } from '../logger';

export interface ChatImageIngestResult {
  chunkCount: number;
  ocrTextLength: number;
}

/**
 * Ingest an image attachment into the chat vector store.
 * - Reads metadata via sharp, persists imageWidth/imageHeight.
 * - Lightweight preprocess (autorotate + grayscale + normalize) before OCR.
 * - One OCR pass over the whole image; chunk+embed any text recovered.
 * - Empty OCR result still marks status INDEXED with chunkCount=0.
 */
export async function ingestChatImage(opts: {
  attachmentId: string;
  chatId: string;
  filePath: string;
  fileName: string;
}): Promise<ChatImageIngestResult> {
  const { attachmentId, chatId, filePath, fileName } = opts;

  await prisma.chatAttachment.update({
    where: { id: attachmentId },
    data: { status: 'PROCESSING', error: null },
  });

  try {
    // Use sharp for metadata + light preprocessing for OCR.
    // Dynamic import keeps Next.js webpack server-externals happy.
    const sharpMod = await import('sharp');
    const sharp = (sharpMod as any).default ?? sharpMod;

    const rawBuffer = await fs.readFile(filePath);
    const meta = await sharp(rawBuffer).metadata();

    if (meta.width && meta.height) {
      await prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: { imageWidth: meta.width, imageHeight: meta.height },
      });
    }

    // Preprocess: rotate per EXIF, grayscale, normalize contrast.
    // Keep output as PNG for tesseract.
    let ocrInput: Buffer;
    try {
      ocrInput = await sharp(rawBuffer).rotate().grayscale().normalize().png().toBuffer();
    } catch (err) {
      logger.warn('chat-image-ingest: sharp preprocess failed, using raw buffer', {
        attachmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      ocrInput = rawBuffer;
    }

    let ocrText = '';
    const ocr = new OCREngine({ language: 'eng' });
    try {
      const result = await ocr.recognizeImage(ocrInput);
      ocrText = (result?.text ?? '').trim();
    } catch (err) {
      logger.warn('chat-image-ingest: OCR failed', {
        attachmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await ocr.terminate();
    }

    if (!ocrText) {
      await prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: { status: 'INDEXED', pageCount: 1, chunkCount: 0 },
      });
      logger.info('chat-image-ingest: completed (empty OCR)', {
        attachmentId,
        chatId,
        ocrTextLength: 0,
      });
      return { chunkCount: 0, ocrTextLength: 0 };
    }

    const synthPage: PageText = {
      pageNumber: 1,
      text: ocrText,
      textDensity: Math.max(0.5, ocrText.length / 1000),
      renderFailed: false,
    };

    const splitter = new LegalTextSplitter({ chunkSize: 512, overlapSize: 64, tokenizer: 'simple' });
    const chunks: Chunk[] = await splitter.chunkPages([synthPage], attachmentId, chatId, {
      caseName: undefined,
      filingType: undefined,
      documentSummary: fileName,
    });

    if (chunks.length === 0) {
      await prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: { status: 'INDEXED', pageCount: 1, chunkCount: 0 },
      });
      return { chunkCount: 0, ocrTextLength: ocrText.length };
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
        pageCount: 1,
        chunkCount: embedded.length,
      },
    });

    logger.info('chat-image-ingest: completed', {
      attachmentId,
      chatId,
      chunkCount: embedded.length,
      ocrTextLength: ocrText.length,
    });

    return { chunkCount: embedded.length, ocrTextLength: ocrText.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('chat-image-ingest: failed', { attachmentId, chatId, error: msg });
    await prisma.chatAttachment.update({
      where: { id: attachmentId },
      data: { status: 'ERROR', error: msg },
    });
    throw error;
  }
}
