'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocEntry {
  id: string;
  fileName: string;
  pageCount: number | null;
  status: string;
}

interface ImageInsertModalProps {
  caseId: string;
  draftId: string;
  provider: string;
  model: string;
  onInsert: (imageUrl: string, alt: string) => void;
  onClose: () => void;
}

type Step = 'source' | 'doclist' | 'page' | 'describe';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ImageInsertModal({
  caseId,
  draftId,
  provider,
  model,
  onInsert,
  onClose,
}: ImageInsertModalProps) {
  const [step, setStep] = useState<Step>('source');

  // Document list
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docFilter, setDocFilter] = useState('');

  // Selected document + page
  const [selectedDoc, setSelectedDoc] = useState<DocEntry | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // Image data (either from page capture, upload, or URL)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageSource, setImageSource] = useState<'page' | 'upload' | 'url'>('page');

  // Describe step
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  // ---------------------------------------------------------------------------
  // Fetch documents
  // ---------------------------------------------------------------------------

  const fetchDocs = useCallback(async () => {
    if (!caseId) return;
    setDocsLoading(true);
    try {
      const res = await fetch(`/api/documents?caseId=${caseId}`);
      if (res.ok) {
        const data = await res.json();
        const list = (data.documents || data || []).filter(
          (d: any) => d.status === 'INDEXED' && d.pageCount && d.pageCount > 0
        );
        setDocs(list);
      }
    } catch {}
    setDocsLoading(false);
  }, [caseId]);

  // ---------------------------------------------------------------------------
  // Fetch page metadata
  // ---------------------------------------------------------------------------

  const fetchPageMeta = useCallback(async (docId: string) => {
    try {
      const res = await fetch(`/api/documents/${docId}/page-metadata`);
      if (res.ok) {
        const data = await res.json();
        setNumPages(data.numPages || 0);
      }
    } catch {}
  }, []);

  // ---------------------------------------------------------------------------
  // Capture page image as data URL
  // ---------------------------------------------------------------------------

  const capturePageImage = useCallback(async (docId: string, page: number) => {
    try {
      const res = await fetch(`/api/documents/${docId}/page-image/${page}?scale=2`);
      if (res.ok) {
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => setImageDataUrl(reader.result as string);
        reader.readAsDataURL(blob);
      }
    } catch {}
  }, []);

  // ---------------------------------------------------------------------------
  // Handle "From Case Documents" flow
  // ---------------------------------------------------------------------------

  const handleFromDocs = () => {
    setStep('doclist');
    fetchDocs();
  };

  const handleSelectDoc = (doc: DocEntry) => {
    setSelectedDoc(doc);
    setCurrentPage(1);
    setStep('page');
    fetchPageMeta(doc.id);
  };

  const handleSelectPage = () => {
    if (!selectedDoc) return;
    setImageSource('page');
    capturePageImage(selectedDoc.id, currentPage);
    setStep('describe');
  };

  // ---------------------------------------------------------------------------
  // Handle upload
  // ---------------------------------------------------------------------------

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setImageDataUrl(reader.result as string);
      setImageSource('upload');
      setStep('describe');
    };
    reader.readAsDataURL(file);
  };

  // ---------------------------------------------------------------------------
  // Handle URL
  // ---------------------------------------------------------------------------

  const [urlInput, setUrlInput] = useState('');

  const handleUrlSubmit = () => {
    if (!urlInput.trim()) return;
    setImageDataUrl(urlInput.trim());
    setImageSource('url');
    setStep('describe');
  };

  // ---------------------------------------------------------------------------
  // AI Description
  // ---------------------------------------------------------------------------

  const handleAiDescribe = async () => {
    setAiLoading(true);
    setAiError(null);
    setDescription('');

    try {
      const body: Record<string, any> = { provider, model, caseId };

      if (imageSource === 'page' && selectedDoc) {
        body.documentId = selectedDoc.id;
        body.pageNum = currentPage;
      } else if (imageDataUrl) {
        body.imageBase64 = imageDataUrl;
      }

      const res = await fetch('/api/draft/describe-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'AI description failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let finalText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'token') {
              finalText += event.text;
              setDescription(finalText);
            } else if (event.type === 'result') {
              finalText = event.text || finalText;
              setDescription(finalText);
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }
    } catch (err: any) {
      setAiError(err.message || 'Failed to generate description');
    }
    setAiLoading(false);
  };

  // ---------------------------------------------------------------------------
  // Insert
  // ---------------------------------------------------------------------------

  const handleInsert = async () => {
    if (!imageDataUrl) return;
    setUploading(true);

    try {
      let finalUrl = imageDataUrl;

      // If it's a data URL or blob, upload to server
      if (imageDataUrl.startsWith('data:')) {
        const blob = await (await fetch(imageDataUrl)).blob();
        const form = new FormData();
        form.append('file', blob, 'exhibit.png');
        form.append('caseId', caseId);

        const res = await fetch(`/api/drafts/${draftId}/images`, {
          method: 'POST',
          body: form,
        });

        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();
        finalUrl = data.url;
      } else if (imageDataUrl.startsWith('/api/')) {
        // Page image URL — download and re-upload
        const blob = await (await fetch(imageDataUrl)).blob();
        const form = new FormData();
        form.append('file', blob, 'exhibit.png');
        form.append('caseId', caseId);

        const res = await fetch(`/api/drafts/${draftId}/images`, {
          method: 'POST',
          body: form,
        });

        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();
        finalUrl = data.url;
      }
      // If it's an external URL, use it directly

      const alt = [label, description].filter(Boolean).join(' — ') || 'Exhibit image';
      onInsert(finalUrl, alt);
      onClose();
    } catch (err: any) {
      setAiError(err.message || 'Insert failed');
    }
    setUploading(false);
  };

  // ---------------------------------------------------------------------------
  // Filtered docs
  // ---------------------------------------------------------------------------

  const filteredDocs = docs.filter(d =>
    d.fileName.toLowerCase().includes(docFilter.toLowerCase())
  );

  // Page image URL for display
  const pageImageUrl = selectedDoc
    ? `/api/documents/${selectedDoc.id}/page-image/${currentPage}?scale=1.5`
    : '';

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={modalRef}
        className="bg-white rounded-xl shadow-2xl border border-gray-200 w-[700px] max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">
            {step === 'source' && 'Insert Image'}
            {step === 'doclist' && 'Select Document'}
            {step === 'page' && `Select Page — ${selectedDoc?.fileName || ''}`}
            {step === 'describe' && 'Exhibit Details'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* ---- Step: Source ---- */}
          {step === 'source' && (
            <div className="p-6 space-y-3">
              {/* From Case Documents */}
              <button
                onClick={handleFromDocs}
                className="w-full flex items-center gap-4 p-4 border border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50/50 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-800">From Case Documents</div>
                  <div className="text-xs text-gray-500">Browse PDFs and select a specific page</div>
                </div>
              </button>

              {/* Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center gap-4 p-4 border border-gray-200 rounded-lg hover:border-green-400 hover:bg-green-50/50 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-800">Upload from Computer</div>
                  <div className="text-xs text-gray-500">Select an image file from your device</div>
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />

              {/* URL */}
              <div className="flex items-center gap-4 p-4 border border-gray-200 rounded-lg">
                <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-800 mb-1">Paste Image URL</div>
                  <div className="flex gap-1.5">
                    <input
                      type="url"
                      value={urlInput}
                      onChange={e => setUrlInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleUrlSubmit(); }}
                      placeholder="https://..."
                      className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-400"
                    />
                    <button
                      onClick={handleUrlSubmit}
                      disabled={!urlInput.trim()}
                      className="px-3 py-1 text-xs font-medium text-white bg-purple-600 rounded hover:bg-purple-700 disabled:opacity-40"
                    >
                      Go
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ---- Step: Document List ---- */}
          {step === 'doclist' && (
            <div className="p-4">
              <input
                type="text"
                value={docFilter}
                onChange={e => setDocFilter(e.target.value)}
                placeholder="Filter documents..."
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg mb-3 focus:outline-none focus:ring-1 focus:ring-blue-400"
                autoFocus
              />
              {docsLoading ? (
                <div className="text-sm text-gray-400 text-center py-8">Loading documents...</div>
              ) : filteredDocs.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-8">
                  {docs.length === 0 ? 'No indexed documents in this case.' : 'No documents match your filter.'}
                </div>
              ) : (
                <div className="space-y-1 max-h-[50vh] overflow-y-auto">
                  {filteredDocs.map(doc => (
                    <button
                      key={doc.id}
                      onClick={() => handleSelectDoc(doc)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-blue-50 transition-colors text-left"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-800 truncate">{doc.fileName}</div>
                        <div className="text-[11px] text-gray-400">{doc.pageCount} pages</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- Step: Page Navigator ---- */}
          {step === 'page' && selectedDoc && (
            <div className="flex flex-col">
              {/* Page controls */}
              <div className="flex items-center justify-center gap-3 px-4 py-2 border-b border-gray-100">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="px-2 py-1 text-sm rounded hover:bg-gray-100 disabled:opacity-30"
                >
                  &larr; Prev
                </button>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-gray-500">Page</span>
                  <input
                    type="number"
                    value={currentPage}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (v >= 1 && v <= numPages) setCurrentPage(v);
                    }}
                    min={1}
                    max={numPages}
                    className="w-14 px-1.5 py-0.5 text-sm text-center border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <span className="text-sm text-gray-500">of {numPages}</span>
                </div>
                <button
                  onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
                  disabled={currentPage >= numPages}
                  className="px-2 py-1 text-sm rounded hover:bg-gray-100 disabled:opacity-30"
                >
                  Next &rarr;
                </button>
              </div>

              {/* Page preview */}
              <div className="flex items-center justify-center p-4 bg-gray-50 min-h-[400px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pageImageUrl}
                  alt={`Page ${currentPage}`}
                  className="max-h-[400px] max-w-full shadow-lg border border-gray-200 rounded"
                />
              </div>

              {/* Thumbnail strip */}
              <div className="flex gap-1.5 px-4 py-2 overflow-x-auto border-t border-gray-100 bg-gray-50">
                {Array.from({ length: Math.min(numPages, 20) }, (_, i) => i + 1).map(page => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`shrink-0 rounded border-2 transition-colors overflow-hidden ${
                      page === currentPage ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/documents/${selectedDoc.id}/page-image/${page}?scale=0.3`}
                      alt={`Page ${page}`}
                      className="h-16 w-auto"
                      loading="lazy"
                    />
                  </button>
                ))}
                {numPages > 20 && (
                  <div className="shrink-0 flex items-center px-2 text-xs text-gray-400">
                    +{numPages - 20} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---- Step: Describe + Insert ---- */}
          {step === 'describe' && (
            <div className="p-5 space-y-4">
              {/* Image preview */}
              <div className="flex justify-center bg-gray-50 rounded-lg p-3 border border-gray-100">
                {imageDataUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={imageDataUrl}
                    alt="Preview"
                    className="max-h-[250px] max-w-full rounded shadow"
                  />
                )}
              </div>

              {/* Exhibit label */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Exhibit Label</label>
                <input
                  type="text"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. Exhibit A"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Describe this exhibit..."
                  rows={4}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded resize-y focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              {/* AI Generate */}
              <button
                onClick={handleAiDescribe}
                disabled={aiLoading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-700 border border-indigo-300 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
              >
                {aiLoading ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a10 10 0 1010 10A10 10 0 0012 2z" /><path d="M12 16v-4" /><path d="M12 8h.01" />
                  </svg>
                )}
                {aiLoading ? 'Generating...' : 'Generate Description with AI'}
              </button>

              {aiError && (
                <div className="text-xs text-red-500 bg-red-50 px-3 py-1.5 rounded">{aiError}</div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 shrink-0 bg-gray-50">
          <button
            onClick={() => {
              if (step === 'doclist') setStep('source');
              else if (step === 'page') setStep('doclist');
              else if (step === 'describe') {
                if (imageSource === 'page') setStep('page');
                else setStep('source');
              }
              else onClose();
            }}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
          >
            {step === 'source' ? 'Cancel' : '← Back'}
          </button>

          <div className="flex gap-2">
            {step === 'page' && (
              <button
                onClick={handleSelectPage}
                className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                Select Page
              </button>
            )}
            {step === 'describe' && (
              <button
                onClick={handleInsert}
                disabled={uploading || !imageDataUrl}
                className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading...' : 'Insert Exhibit'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
