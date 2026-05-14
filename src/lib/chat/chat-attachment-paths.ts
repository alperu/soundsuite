import * as path from 'path';

export const ATTACHMENT_ROOT = path.join(process.cwd(), 'data', 'chat-attachments');

/** Map a mimeType to its on-disk file extension. */
export function extForMimeType(mimeType: string | null | undefined): string {
  switch ((mimeType || '').toLowerCase()) {
    case 'application/pdf':
      return 'pdf';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    default:
      return 'pdf';
  }
}

/** Map a filename to a normalized mimeType (or null if unsupported). */
export function mimeTypeForFileName(fileName: string): {
  mimeType: string;
  kind: 'pdf' | 'image';
  ext: string;
} | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return { mimeType: 'application/pdf', kind: 'pdf', ext: 'pdf' };
  }
  if (lower.endsWith('.png')) {
    return { mimeType: 'image/png', kind: 'image', ext: 'png' };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return { mimeType: 'image/jpeg', kind: 'image', ext: 'jpg' };
  }
  return null;
}

export function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function chatAttachmentDir(chatId: string): string {
  return path.join(ATTACHMENT_ROOT, sanitizeChatId(chatId));
}

/**
 * Returns the on-disk path for an attachment row.
 * Prefers mimeType; falls back to fileName extension; final fallback is pdf.
 */
export function chatAttachmentFilePath(row: {
  chatId: string;
  hash: string;
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  let ext = extForMimeType(row.mimeType);
  if (!row.mimeType && row.fileName) {
    const m = mimeTypeForFileName(row.fileName);
    if (m) ext = m.ext;
  }
  return path.join(chatAttachmentDir(row.chatId), `${row.hash}.${ext}`);
}
