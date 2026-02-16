'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const PROVIDER_MODELS: Record<string, Record<string, string>> = {
  transformers: {
    'Xenova/all-MiniLM-L6-v2': 'all-MiniLM-L6-v2',
    'Xenova/all-mpnet-base-v2': 'all-mpnet-base-v2',
  },
  openai: {
    'text-embedding-3-small': 'text-embedding-3-small',
    'text-embedding-3-large': 'text-embedding-3-large',
    'text-embedding-ada-002': 'text-embedding-ada-002',
  },
  claude: {
    'claude-3-opus-20240229': 'Claude 3 Opus',
    'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
    'claude-3-haiku-20240307': 'Claude 3 Haiku',
  },
};

interface ToolbarProps {
  caseName: string;
  totalDocuments: number;
  /** Documents currently displayed — used to compute mismatch count */
  documents?: Array<{ status: string; embeddingModel: string | null }>;
}

export default function Toolbar({ caseName, totalDocuments, documents }: ToolbarProps) {
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((config) => {
        const provider = config.embeddingProvider || 'transformers';
        const model = config.embeddingModel || '';
        const label = PROVIDER_MODELS[provider]?.[model] || model;
        setModelLabel(`${provider}: ${label}`);
        const stampedName =
          provider === 'ollama'
            ? `ollama/${config.ollamaModel || model}`
            : provider === 'transformers'
            ? model
            : `${provider}/${model}`;
        setCurrentModel(stampedName);
      })
      .catch(() => setModelLabel(null));

  }, []);

  // Count INDEXED documents whose embeddingModel differs from current config model
  const staleCount =
    currentModel && documents
      ? documents.filter(
          (d) =>
            d.status === 'INDEXED' &&
            d.embeddingModel !== null &&
            d.embeddingModel !== currentModel
        ).length
      : 0;

  // Count documents currently queued or processing
  const queuedCount = documents
    ? documents.filter((d) => d.status === 'QUEUED' || d.status === 'PROCESSING').length
    : 0;

  const handleClearQueue = async () => {
    if (queuedCount === 0) return;
    setClearing(true);
    try {
      await fetch('/api/queue/clear', { method: 'POST' });
      // Trigger a page refresh to update document statuses
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear queue:', error);
    } finally {
      setClearing(false);
    }
  };

  const handleReindexStale = async () => {
    if (!currentModel || staleCount === 0) return;
    setReindexing(true);
    try {
      // Re-queue all indexed docs with mismatched model via config save (triggers batch update)
      // We just re-save the current config which triggers the re-queue logic
      const configRes = await fetch('/api/config');
      const config = await configRes.json();
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeddingProvider: config.embeddingProvider,
          embeddingModel: config.embeddingModel,
          openaiApiKey: config.openaiApiKey,
          claudeApiKey: config.claudeApiKey,
        }),
      });
    } catch (error) {
      console.error('Failed to re-index stale documents:', error);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">{caseName}</h2>
          <span className="text-sm text-gray-500">
            {totalDocuments} {totalDocuments === 1 ? 'document' : 'documents'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {queuedCount > 0 && (
            <button
              onClick={handleClearQueue}
              disabled={clearing}
              className="text-xs font-medium px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 border border-red-300 rounded transition-colors disabled:opacity-50"
            >
              {clearing ? 'Stopping...' : `Stop & Clear Queue (${queuedCount})`}
            </button>
          )}
          {modelLabel && (
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
                staleCount > 0
                  ? 'text-yellow-700 bg-yellow-50 border-yellow-300'
                  : 'text-blue-700 bg-blue-50 border-blue-200'
              }`}
            >
              {modelLabel}
            </span>
          )}
          <Link
            href="/admin"
            className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
          >
            Change Model
          </Link>
        </div>
      </div>

      {/* Mismatch banner */}
      {staleCount > 0 && (
        <div className="flex items-center justify-between px-6 py-2 bg-yellow-50 border-t border-yellow-200 text-sm">
          <div className="flex items-center gap-2 text-yellow-800">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span>
              <strong>{staleCount}</strong> {staleCount === 1 ? 'document was' : 'documents were'} indexed
              with a different model. Search results may be inaccurate.
            </span>
          </div>
          <button
            onClick={handleReindexStale}
            disabled={reindexing}
            className="text-xs font-medium px-3 py-1 bg-yellow-200 hover:bg-yellow-300 text-yellow-900 rounded transition-colors disabled:opacity-50 flex-shrink-0 ml-4"
          >
            {reindexing ? 'Re-indexing...' : `Re-index ${staleCount}`}
          </button>
        </div>
      )}
    </div>
  );
}
