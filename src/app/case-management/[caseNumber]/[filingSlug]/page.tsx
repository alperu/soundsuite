'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { formatFilingLabel } from '@/lib/filings/format-filing-label';
import { SelectedEntityProvider } from '@/components/case/selected-entity-context';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { ExtractModal } from '@/components/personas/extract-modal';

const FILING_TYPES = [
  'Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit',
  'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree',
  "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Other',
];

interface DocumentRecord {
  id: string;
  fileName: string;
  filePath: string;
  status: string;
  documentType: string | null;
  exhibitLabel: string | null;
  pageCount: number | null;
  detectedExhibits: number;
  documentSummary: string | null;
  createdAt: string;
}

interface FilingRecord {
  id: string;
  filingType: string;
  title: string;
  slug: string;
  filingDate: string | null;
  description: string | null;
  volumeNumber: number | null;
  isSupplemental?: boolean;
  supplementalOrder?: number | null;
  documents: DocumentRecord[];
}

export default function FilingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const caseNumberParam = decodeURIComponent(params.caseNumber as string);
  const filingSlugParam = decodeURIComponent(params.filingSlug as string);

  const [filing, setFiling] = useState<FilingRecord | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Edit filing dialog
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editType, setEditType] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editVolume, setEditVolume] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Add document dialog
  const [showAddDocDialog, setShowAddDocDialog] = useState(false);
  const [addDocPath, setAddDocPath] = useState('');
  const [addDocLoading, setAddDocLoading] = useState(false);
  const [addDocError, setAddDocError] = useState('');

  // Reparse state
  const [reparseLoading, setReparseLoading] = useState(false);

  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);
  const [dropLoading, setDropLoading] = useState(false);
  const [dropError, setDropError] = useState('');

  // Motion context menu + Persona extraction modal
  const [motionMenu, setMotionMenu] = useState<{ x: number; y: number } | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractToast, setExtractToast] = useState<string | null>(null);

  // Copy-to-clipboard state
  const [copied, setCopied] = useState(false);

  const fetchFiling = () => {
    setLoading(true);
    setNotFound(false);
    fetch(`/api/cases?caseNumber=${encodeURIComponent(caseNumberParam)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.case) { setNotFound(true); setLoading(false); return; }
        setCaseId(data.case.id);
        return fetch(`/api/cases/${data.case.id}/filings`).then(r => r.json()).then(fd => {
          const match = fd.filings?.find((f: FilingRecord) => f.slug === filingSlugParam);
          if (match) setFiling(match);
          else setNotFound(true);
          setLoading(false);
        });
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchFiling(); }, [caseNumberParam, filingSlugParam]);

  // Notify the layout's right-hand TagPanel that we're viewing a Filing (treated as Motion for v1).
  useEffect(() => {
    if (!filing) return;
    window.dispatchEvent(new CustomEvent('selected-entity-changed', {
      detail: { kind: 'motion', id: filing.id, label: formatFilingLabel(filing) },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent('selected-entity-changed', { detail: null }));
    };
  }, [filing]);

  const handleEditSave = async () => {
    if (!caseId || !filing) return;
    setEditLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/filings/${filing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          filingType: editType,
          description: editDescription.trim() || null,
          volumeNumber: editVolume.trim() ? parseInt(editVolume, 10) : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setShowEditDialog(false);
        window.dispatchEvent(new Event('filings-changed'));
        // If slug changed, navigate to new URL
        if (data.filing?.slug && data.filing.slug !== filingSlugParam) {
          router.push(`/case-management/${encodeURIComponent(caseNumberParam)}/${encodeURIComponent(data.filing.slug)}`);
        } else {
          fetchFiling();
        }
      }
    } catch { /* ignore */ }
    finally { setEditLoading(false); }
  };

  const handleDelete = async () => {
    if (!caseId || !filing) return;
    if (!confirm(`Delete filing "${filing.title}"? Documents will be unassigned.`)) return;
    const res = await fetch(`/api/cases/${caseId}/filings/${filing.id}`, { method: 'DELETE' });
    if (res.ok) {
      window.dispatchEvent(new Event('filings-changed'));
      router.push(`/case-management/${encodeURIComponent(caseNumberParam)}`);
    }
  };

  const addPathsToFiling = async (paths: string[]): Promise<string | null> => {
    if (!caseId || !filing || paths.length === 0) return 'No paths provided';
    const parseRes = await fetch(`/api/cases/${caseId}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: paths, filingId: filing.id }),
    });
    if (!parseRes.ok) {
      const err = await parseRes.json().catch(() => ({}));
      return err.error || 'Failed to add document';
    }
    const parseData = await parseRes.json();
    const results = parseData.results || [];
    const skipped = results.filter((r: { status: string; documentId?: string }) => !r.documentId && r.status === 'skipped');
    if (skipped.length === results.length && skipped.length > 0) {
      return skipped[0]?.error || 'No document was created';
    }
    fetchFiling();
    window.dispatchEvent(new Event('filings-changed'));
    return null;
  };

  const handleAddDocument = async () => {
    if (!caseId || !filing || !addDocPath.trim()) return;
    setAddDocLoading(true);
    setAddDocError('');
    try {
      const err = await addPathsToFiling([addDocPath.trim()]);
      if (err) { setAddDocError(err); return; }
      setShowAddDocDialog(false);
      setAddDocPath('');
    } catch { setAddDocError('Network error'); }
    finally { setAddDocLoading(false); }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!caseId || !filing) return;

    // Fastest path: drag came from another filing in the sidebar — we have
    // document IDs, just reassign filingId. No parse, no upload.
    const docIdsRaw = e.dataTransfer.getData('application/x-court-lens-doc-ids');
    if (docIdsRaw) {
      try {
        const docIds = JSON.parse(docIdsRaw) as string[];
        setDropLoading(true);
        setDropError('');
        for (const docId of docIds) {
          await fetch(`/api/documents/${docId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filingId: filing.id, exhibitLabel: null }),
          });
        }
        fetchFiling();
        window.dispatchEvent(new Event('filings-changed'));
      } catch (err) {
        setDropError(err instanceof Error ? err.message : 'Reassign failed');
      } finally {
        setDropLoading(false);
      }
      return;
    }

    // Fast path: drag came from the in-app case file tree — we already know
    // the server-side absolute paths, no upload needed.
    const internal = e.dataTransfer.getData('application/x-court-lens-paths');
    if (internal) {
      try {
        const paths = JSON.parse(internal) as string[];
        const pdfPaths = paths.filter(p => p.toLowerCase().endsWith('.pdf'));
        if (pdfPaths.length === 0) {
          setDropError('No PDF paths in drop');
          setTimeout(() => setDropError(''), 4000);
          return;
        }
        setDropLoading(true);
        setDropError('');
        const err = await addPathsToFiling(pdfPaths);
        if (err) setDropError(err);
        return;
      } catch {
        // fall through to OS file drop handling
      } finally { setDropLoading(false); }
    }

    // OS file drop from Finder/Explorer — browsers don't expose the absolute
    // path, so upload the bytes.
    const files = Array.from(e.dataTransfer.files || []).filter(
      f => f.name.toLowerCase().endsWith('.pdf')
    );
    if (files.length === 0) {
      setDropError('Drop one or more PDF files');
      setTimeout(() => setDropError(''), 4000);
      return;
    }
    setDropLoading(true);
    setDropError('');
    try {
      const form = new FormData();
      form.append('filingId', filing.id);
      for (const f of files) form.append('file', f, f.name);
      const res = await fetch(`/api/cases/${caseId}/upload`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDropError(err.error || 'Upload failed');
        return;
      }
      const data = await res.json();
      const failed = (data.results || []).filter((r: { status: string }) => r.status === 'error' || r.status === 'skipped');
      if (failed.length > 0 && data.uploaded === 0) {
        setDropError(failed[0]?.error || 'No files were added');
      }
      fetchFiling();
      window.dispatchEvent(new Event('filings-changed'));
    } catch { setDropError('Network error'); }
    finally { setDropLoading(false); }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget === e.target) setDragOver(false);
  };

  const handleDemoteExhibit = async (docId: string) => {
    const res = await fetch(`/api/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exhibitLabel: null }),
    });
    if (res.ok) {
      fetchFiling();
      window.dispatchEvent(new Event('filings-changed'));
    }
  };

  const handleReparse = async () => {
    if (!caseId || !filing) return;
    setReparseLoading(true);
    try {
      // Reset all documents in this filing to QUEUED status
      const docIds = filing.documents.map(d => d.id);
      for (const docId of docIds) {
        await fetch(`/api/documents/${docId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'QUEUED' }),
        });
      }
      fetchFiling();
    } catch { /* ignore */ }
    finally { setReparseLoading(false); }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      QUEUED: 'bg-gray-200 text-gray-700',
      PROCESSING: 'bg-yellow-100 text-yellow-800',
      INDEXED: 'bg-green-100 text-green-800',
      ERROR: 'bg-red-100 text-red-800',
    };
    return colors[status] || 'bg-gray-100 text-gray-600';
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (notFound || !filing) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 text-lg">Filing not found</p>
          <button onClick={() => router.push(`/case-management/${encodeURIComponent(caseNumberParam)}`)}
            className="mt-2 text-blue-600 text-sm hover:underline">Back to case</button>
        </div>
      </div>
    );
  }

  const mainDocs = filing.documents.filter(d => !d.exhibitLabel);
  const exhibits = filing.documents.filter(d => d.exhibitLabel);
  const label = formatFilingLabel(filing);

  const handleCopyLabel = () => {
    navigator.clipboard.writeText(label).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <SelectedEntityProvider entityKind="motion" entityId={filing.id} entityLabel={label}>
    <div
      className={`flex-1 overflow-y-auto relative ${dragOver ? 'ring-4 ring-blue-400 ring-inset' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-blue-50/80 pointer-events-none">
          <div className="text-blue-700 font-medium text-sm">Drop PDFs to add them to this filing</div>
        </div>
      )}
      {(dropLoading || dropError) && (
        <div className={`px-4 py-2 text-xs ${dropError ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
          {dropLoading ? 'Adding dropped files…' : dropError}
        </div>
      )}
      {/* Header with toolbar */}
      <div className="p-4 border-b border-gray-200">
        <button onClick={() => router.push(`/case-management/${encodeURIComponent(caseNumberParam)}`)}
          className="text-sm text-blue-600 hover:underline mb-2 inline-block">&larr; Back to case files</button>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded-full flex-shrink-0">{filing.filingType}</span>
            <h2
              onClick={handleCopyLabel}
              onContextMenu={(e) => { e.preventDefault(); setMotionMenu({ x: e.clientX, y: e.clientY }); }}
              title="Copy to clipboard · Right-click for actions"
              className="text-lg font-semibold text-gray-900 truncate cursor-pointer hover:text-blue-700"
            >{label}</h2>
            <button
              onClick={handleCopyLabel}
              title={copied ? 'Copied' : 'Copy to clipboard'}
              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors flex-shrink-0"
            >
              {copied ? (
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              )}
            </button>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
            <button onClick={() => { setEditType(filing.filingType); setEditTitle(filing.title); setEditDescription(filing.description || ''); setEditVolume(filing.volumeNumber != null ? String(filing.volumeNumber) : ''); setShowEditDialog(true); }}
              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Edit Filing">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button onClick={() => { setAddDocPath(''); setAddDocError(''); setShowAddDocDialog(true); }}
              className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors" title="Add Document">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </button>
            <button onClick={() => setExtractOpen(true)} disabled={filing.documents.length === 0}
              className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors disabled:opacity-30" title="Extract Persona (right-click motion title for menu)">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            </button>
            <button onClick={handleReparse} disabled={reparseLoading || filing.documents.length === 0}
              className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors disabled:opacity-30" title="Reparse All Documents">
              <svg className={`w-4 h-4 ${reparseLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            </button>
            <button onClick={handleDelete}
              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete Filing">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
        </div>
        {filing.filingDate && (
          <p className="text-xs text-gray-500 mt-1">Filed: {new Date(filing.filingDate).toLocaleDateString()}</p>
        )}
        {filing.description && (
          <p className="text-sm text-gray-600 mt-2">{filing.description}</p>
        )}
      </div>

      {/* Main documents */}
      <div className="p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-2">Documents ({mainDocs.length})</h3>
        {mainDocs.length === 0 && exhibits.length === 0 ? (
          <p className="text-sm text-gray-400">No documents assigned to this filing</p>
        ) : mainDocs.length === 0 ? (
          <p className="text-sm text-gray-400">All documents are filed as exhibits below</p>
        ) : (
          <div className="space-y-3">
            {mainDocs.map(doc => (
              <div key={doc.id} className="border border-gray-100 rounded-lg p-3 hover:border-gray-200 transition-colors">
                <div className="flex items-center gap-3">
                  <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-gray-800 flex-1 truncate font-medium">{doc.fileName}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${getStatusBadge(doc.status)}`}>{doc.status}</span>
                  {doc.detectedExhibits > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">{doc.detectedExhibits} exhibits</span>
                  )}
                </div>
                {doc.status === 'INDEXED' && doc.documentSummary && (
                  <p className="mt-2 text-xs text-gray-500 line-clamp-3">{doc.documentSummary}</p>
                )}
                {doc.status === 'INDEXED' && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => router.push(`/case-explorer?doc=${encodeURIComponent(doc.filePath)}`)}
                      className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                      View in Court Viewer
                    </button>
                    {doc.pageCount && <span className="text-xs text-gray-400">{doc.pageCount} pages</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Exhibits */}
      <div className="p-4 border-t border-gray-100">
        <h3 className="text-sm font-medium text-gray-700 mb-2">Exhibits ({exhibits.length})</h3>
        {exhibits.length === 0 ? (
          <p className="text-sm text-gray-400">No exhibits attached</p>
        ) : (
          <div className="space-y-3">
            {exhibits.map(doc => (
              <div key={doc.id} className="border border-gray-100 rounded-lg p-3 hover:border-gray-200 transition-colors">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded flex-shrink-0">{doc.exhibitLabel}</span>
                  <span className="text-sm text-gray-800 flex-1 truncate">{doc.fileName}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${getStatusBadge(doc.status)}`}>{doc.status}</span>
                  <button onClick={() => handleDemoteExhibit(doc.id)}
                    className="text-xs text-gray-400 hover:text-blue-600 hover:underline flex-shrink-0"
                    title="This is not an exhibit — move it to Documents">
                    Not an exhibit
                  </button>
                </div>
                {doc.status === 'INDEXED' && doc.documentSummary && (
                  <p className="mt-2 text-xs text-gray-500 line-clamp-3">{doc.documentSummary}</p>
                )}
                {doc.status === 'INDEXED' && (
                  <button
                    onClick={() => router.push(`/case-explorer?doc=${encodeURIComponent(doc.filePath)}`)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    View in Court Viewer
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Edit Filing Dialog */}
      {showEditDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit Filing</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">Filing Type</label>
            <select value={editType} onChange={e => setEditType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4">
              {FILING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && editTitle.trim()) handleEditSave(); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" autoFocus />
            {(editType === "Clerk's Record" || editType === "Reporter's Record") && (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Volume Number</label>
                <input type="number" min="1" value={editVolume} onChange={e => setEditVolume(e.target.value)}
                  placeholder="e.g. 2"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" />
              </>
            )}
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 resize-none" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEditDialog(false)}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button onClick={handleEditSave} disabled={!editTitle.trim() || editLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {editLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Document Dialog */}
      {showAddDocDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAddDocDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Document to Filing</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">File Path</label>
            <input type="text" value={addDocPath} onChange={e => setAddDocPath(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && addDocPath.trim()) handleAddDocument(); }}
              placeholder="/path/to/document.pdf"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" autoFocus />
            {addDocError && <p className="text-sm text-red-600 mb-4">{addDocError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAddDocDialog(false)}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button onClick={handleAddDocument} disabled={!addDocPath.trim() || addDocLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {addDocLoading ? 'Adding...' : 'Add & Parse'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Motion right-click context menu */}
      {motionMenu && (
        <ContextMenu
          x={motionMenu.x}
          y={motionMenu.y}
          items={[
            {
              label: 'Extract Persona',
              onClick: () => { setExtractOpen(true); setMotionMenu(null); },
              disabled: filing.documents.length === 0,
            } as ContextMenuItem,
            {
              label: 'Copy title',
              onClick: () => { handleCopyLabel(); setMotionMenu(null); },
            } as ContextMenuItem,
          ]}
          onClose={() => setMotionMenu(null)}
        />
      )}

      {/* Persona extraction modal — scoped to this motion */}
      <ExtractModal
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onConfirmed={(r) => {
          setExtractOpen(false);
          setExtractToast(`Created ${r.created} · merged ${r.updated} · bindings ${r.rolesAdded}`);
          setTimeout(() => setExtractToast(null), 4500);
        }}
        defaultMotionId={filing.id}
        defaultMotionLabel={label}
      />

      {extractToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-purple-700 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          {extractToast}
        </div>
      )}
    </div>
    </SelectedEntityProvider>
  );
}
