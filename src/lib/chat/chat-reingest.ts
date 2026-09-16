/**
 * Rebuild a chat's attachment index after its table was recreated.
 *
 * `ensureChatTableWidth()` drops a chat table whose vector width no longer
 * matches the embedding provider (chat tables built under
 * qwen3-embedding:0.6b hold 1024-wide vectors; the provider now produces
 * 2560). The attachment that triggered the drop recreates the table with its
 * own insert; everything the chat had attached BEFORE that is gone from the
 * index until it is embedded again. This module does that, from the files
 * still on disk under data/chat-attachments/<chatId>/.
 *
 * Deliberately best-effort: a failure here marks that one attachment ERROR
 * and moves on. The attach that triggered the rebuild has already succeeded,
 * and failing it because an older file could not be re-read would turn a
 * self-heal into a regression.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../db/prisma';
import { logger } from '../logger';
import { chatAttachmentDir, extForMimeType } from './chat-attachment-paths';

export interface ReingestSummary {
  attempted: number;
  reindexed: number;
  failed: number;
  missingFiles: number;
}

/** Where the upload route wrote this attachment: <chatDir>/<hash>.<ext>. */
export function attachmentFilePath(chatId: string, hash: string, mimeType: string | null | undefined): string {
  return path.join(chatAttachmentDir(chatId), `${hash}.${extForMimeType(mimeType)}`);
}

export async function reingestOtherAttachments(chatId: string, excludeAttachmentId: string): Promise<ReingestSummary> {
  const summary: ReingestSummary = { attempted: 0, reindexed: 0, failed: 0, missingFiles: 0 };

  const others = await prisma.chatAttachment.findMany({
    where: { chatId, id: { not: excludeAttachmentId }, status: 'INDEXED' },
    select: { id: true, fileName: true, hash: true, mimeType: true, kind: true },
    orderBy: { createdAt: 'asc' },
  });
  if (others.length === 0) return summary;

  logger.info('chat-reingest: rebuilding attachment index after table recreation', {
    chatId,
    attachments: others.length,
  });

  // Lazy imports: both ingest modules import this one back.
  const { ingestChatAttachment } = await import('./chat-ingest');
  const { ingestChatImage } = await import('./chat-image-ingest');

  for (const a of others) {
    summary.attempted++;
    const filePath = attachmentFilePath(chatId, a.hash, a.mimeType);
    try {
      await fs.access(filePath);
    } catch {
      summary.missingFiles++;
      logger.warn('chat-reingest: source file missing — attachment cannot be re-indexed', {
        chatId,
        attachmentId: a.id,
        fileName: a.fileName,
      });
      await prisma.chatAttachment.update({
        where: { id: a.id },
        data: { status: 'ERROR', error: 'Source file missing when the chat index was rebuilt; re-attach the file to search it.' },
      }).catch(() => {});
      continue;
    }
    try {
      const args = { attachmentId: a.id, chatId, filePath, fileName: a.fileName };
      if (a.kind === 'image') await ingestChatImage(args);
      else await ingestChatAttachment(args);
      summary.reindexed++;
    } catch (err) {
      // The ingest functions already mark the row ERROR and log the cause.
      summary.failed++;
      logger.warn('chat-reingest: re-index failed for attachment', {
        chatId,
        attachmentId: a.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('chat-reingest: done', { chatId, ...summary });
  return summary;
}
