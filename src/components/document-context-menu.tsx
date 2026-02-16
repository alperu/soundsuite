'use client';

import { useState, useCallback } from 'react';
import type { ContextMenuItem } from '@/components/context-menu';

export const FILING_TYPES = [
  'Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit',
  'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree',
  "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Other',
];

export interface DocumentTarget {
  /** File path(s) for the document(s) being acted on */
  filePaths: string[];
  /** Case ID the documents belong to */
  caseId: string;
}

export interface FilingRecord {
  id: string;
  filingType: string;
  title: string;
  slug: string;
}

export interface DocumentContextMenuActions {
  onAddNewFiling: (target: DocumentTarget) => void;
  onAddToExistingFiling: (target: DocumentTarget) => void;
  onIndex: (target: DocumentTarget) => void;
}

/**
 * Build the three shared context menu items for document actions.
 * These are: Add New Filing, Add to Existing Filing, Index.
 */
export function getSharedDocumentMenuItems(
  target: DocumentTarget,
  actions: DocumentContextMenuActions,
  options?: { indexDisabled?: boolean; indexLabel?: string }
): ContextMenuItem[] {
  return [
    {
      label: 'Add New Filing',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      ),
      onClick: () => actions.onAddNewFiling(target),
    },
    {
      label: 'Add to Existing Filing',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      onClick: () => actions.onAddToExistingFiling(target),
    },
    {
      label: options?.indexLabel || 'Index',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      onClick: () => actions.onIndex(target),
      disabled: options?.indexDisabled,
    },
  ];
}

// ── Filing Dialog ──────────────────────────────────────────────

interface FilingDialogProps {
  open: boolean;
  onClose: () => void;
  /** The file name(s) shown in the dialog subtitle */
  fileNames: string[];
  /** Case ID for API calls */
  caseId: string;
  /** If true, start in "create new" mode; otherwise "existing" mode */
  createMode: boolean;
  /** Called when a filing is selected/created and document should be assigned */
  onSubmit: (params: { filingId: string; isNew: boolean }) => void;
  loading?: boolean;
  error?: string;
}

export function FilingDialog({
  open, onClose, fileNames, caseId, createMode: initialCreateMode,
  onSubmit, loading, error,
}: FilingDialogProps) {
  const [createNewFiling, setCreateNewFiling] = useState(initialCreateMode);
  const [filings, setFilings] = useState<FilingRecord[]>([]);
  const [filingsLoaded, setFilingsLoaded] = useState(false);
  const [selectedFilingId, setSelectedFilingId] = useState('');
  const [newFilingType, setNewFilingType] = useState('Motion');
  const [newFilingTitle, setNewFilingTitle] = useState('');
  const [newVolumeNumber, setNewVolumeNumber] = useState('');
  const [localError, setLocalError] = useState('');
  const [localLoading, setLocalLoading] = useState(false);

  // Load filings list when switching to existing mode
  const loadFilings = useCallback(async () => {
    if (filingsLoaded) return;
    try {
      const res = await fetch(`/api/cases/${caseId}/filings`);
      if (res.ok) {
        const data = await res.json();
        setFilings(data.filings || []);
      }
    } catch { /* silent */ }
    setFilingsLoaded(true);
  }, [caseId, filingsLoaded]);

  // Load filings on open
  useState(() => {
    if (open && !initialCreateMode) loadFilings();
  });

  if (!open) return null;

  const handleSubmit = async () => {
    setLocalError('');

    if (createNewFiling) {
      if (!newFilingTitle.trim()) {
        setLocalError('Title is required');
        return;
      }
      setLocalLoading(true);
      try {
        const res = await fetch(`/api/cases/${caseId}/filings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filingType: newFilingType,
            title: newFilingTitle.trim(),
            volumeNumber: newVolumeNumber.trim() ? parseInt(newVolumeNumber, 10) : null,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setLocalError(d.error || 'Failed to create filing');
          return;
        }
        const data = await res.json();
        onSubmit({ filingId: data.filing.id, isNew: true });
      } catch {
        setLocalError('Network error');
      } finally {
        setLocalLoading(false);
      }
    } else {
      if (!selectedFilingId) {
        setLocalError('Select a filing');
        return;
      }
      onSubmit({ filingId: selectedFilingId, isNew: false });
    }
  };

  const displayError = error || localError;
  const isLoading = loading || localLoading;
  const subtitle = fileNames.length === 1
    ? fileNames[0]
    : `${fileNames.length} documents`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {createNewFiling ? 'Add New Filing' : 'Add to Existing Filing'}
        </h3>
        <p className="text-xs text-gray-500 mb-4 truncate">{subtitle}</p>

        {createNewFiling ? (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1">Filing Type</label>
            <select
              value={newFilingType}
              onChange={e => setNewFilingType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {FILING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={newFilingTitle}
              onChange={e => setNewFilingTitle(e.target.value)}
              placeholder="e.g. Motion to Compel Discovery"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {(newFilingType === "Clerk's Record" || newFilingType === "Reporter's Record") && (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Volume Number</label>
                <input
                  type="number"
                  min="1"
                  value={newVolumeNumber}
                  onChange={e => setNewVolumeNumber(e.target.value)}
                  placeholder="e.g. 2"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </>
            )}
            <button
              onClick={() => { setCreateNewFiling(false); loadFilings(); }}
              className="text-sm text-gray-500 hover:underline mb-3"
            >
              &larr; Add to existing filing instead
            </button>
          </>
        ) : (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-2">Select existing filing</label>
            {filings.length === 0 ? (
              <p className="text-sm text-gray-400 mb-3">No filings yet for this case</p>
            ) : (
              <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg mb-3">
                {filings.map(f => (
                  <div
                    key={f.id}
                    onClick={() => setSelectedFilingId(f.id)}
                    className={`p-2 cursor-pointer text-sm ${selectedFilingId === f.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50 text-gray-700'}`}
                  >
                    <span className="text-xs text-gray-400 mr-2">{f.filingType}</span>{f.title}
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setCreateNewFiling(true)}
              className="text-sm text-blue-600 hover:underline mb-3"
            >
              + Create new filing instead
            </button>
          </>
        )}

        {displayError && <p className="text-sm text-red-600 mb-3">{displayError}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || (!createNewFiling && !selectedFilingId)}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Adding...' : createNewFiling ? 'Create Filing' : 'Add to Filing'}
          </button>
        </div>
      </div>
    </div>
  );
}
