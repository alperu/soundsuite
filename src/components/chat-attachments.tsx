'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ChatAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  pageCount: number | null;
  chunkCount: number | null;
  status: 'QUEUED' | 'PROCESSING' | 'INDEXED' | 'ERROR' | string;
  error: string | null;
  createdAt: string;
  kind?: 'pdf' | 'image' | string;
  mimeType?: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
}

interface ChatAttachmentsStripProps {
  chatId: string;
  refreshKey?: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ChatAttachmentsStrip({ chatId, refreshKey }: ChatAttachmentsStripProps) {
  const [items, setItems] = useState<ChatAttachment[]>([]);

  const load = useCallback(async () => {
    if (!chatId) {
      setItems([]);
      return;
    }
    try {
      const res = await fetch(`/api/search/chat-attachments?chatId=${encodeURIComponent(chatId)}`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.attachments || []);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
  }, [chatId]);

  // Reset on chat switch so the previous chat's items don't flash
  useEffect(() => { setItems([]); }, [chatId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  // Poll while any attachment is QUEUED/PROCESSING
  useEffect(() => {
    const pending = items.some((a) => a.status === 'QUEUED' || a.status === 'PROCESSING');
    if (!pending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [items, load]);

  const removeAttachment = async (id: string) => {
    await fetch(`/api/search/chat-attachments/${id}`, { method: 'DELETE' });
    await load();
  };

  const reindexAttachment = async (id: string) => {
    await fetch(`/api/search/chat-attachments/${id}/reindex`, { method: 'POST' });
    await load();
  };

  if (!chatId) return null;
  if (items.length === 0) return null;

  return (
    <div className="border-t border-gray-200 bg-white px-6 py-2">
      <div className="max-w-3xl mx-auto">
        <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1.5">
          Chat Attachments ({items.length})
        </div>
        <div className="flex flex-wrap gap-2">
          {items.map((a) => {
            const isImage = a.kind === 'image' || (a.mimeType?.startsWith('image/') ?? false);
            const pill =
              a.status === 'INDEXED' ? 'bg-green-100 text-green-700' :
              a.status === 'ERROR' ? 'bg-red-100 text-red-700' :
              'bg-amber-100 text-amber-700';
            const indexedLabel = isImage
              ? (a.imageWidth && a.imageHeight
                  ? `${a.imageWidth}×${a.imageHeight}`
                  : `${a.chunkCount ?? 0}c`)
              : `${a.pageCount ?? '?'}p`;
            const statusLabel =
              a.status === 'INDEXED' ? indexedLabel :
              a.status === 'ERROR' ? 'error' :
              a.status === 'PROCESSING' ? 'indexing…' :
              'queued';
            const noTextHint = isImage && a.status === 'INDEXED' && (a.chunkCount ?? 0) === 0
              ? 'No text detected'
              : null;
            const tooltip = a.error
              || noTextHint
              || `${a.fileName} (${formatBytes(a.sizeBytes)})`;
            return (
              <div
                key={a.id}
                className="group inline-flex items-center gap-2 border border-gray-200 hover:border-gray-300 bg-gray-50 hover:bg-white rounded px-2 py-1 text-xs transition-colors"
                title={tooltip}
              >
                <a
                  href={`/api/search/chat-attachments/${a.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-gray-700 hover:text-blue-600 max-w-[240px]"
                >
                  {isImage && (
                    <img
                      src={`/api/search/chat-attachments/${a.id}/file`}
                      alt=""
                      loading="lazy"
                      className="w-8 h-8 object-cover rounded border border-gray-200 bg-white flex-shrink-0"
                    />
                  )}
                  <span className="truncate">{a.fileName}</span>
                </a>
                <span className={`px-1.5 py-0.5 rounded ${pill}`}>{statusLabel}</span>
                <button
                  type="button"
                  onClick={() => reindexAttachment(a.id)}
                  disabled={a.status === 'PROCESSING' || a.status === 'QUEUED'}
                  className="text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30 disabled:hover:text-gray-400 disabled:cursor-not-allowed"
                  aria-label="Reindex attachment"
                  title="Reindex"
                >
                  ↻
                </button>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove attachment"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
