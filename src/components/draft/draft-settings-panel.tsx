'use client';

import { useState, useEffect, useCallback } from 'react';
import { DOCUMENT_TYPES } from '@/lib/draft/draft-types';
import type { DraftSummary } from '@/lib/draft/draft-types';

interface Case {
  id: string;
  name: string;
  caseNumber?: string;
}

interface DraftSettingsPanelProps {
  selectedCaseId: string;
  onCaseChange: (caseId: string) => void;
  activeDraftId: string | null;
  onDraftSelect: (draft: DraftSummary) => void;
  onDraftCreated: (draft: DraftSummary) => void;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  review: 'bg-blue-100 text-blue-700',
  final: 'bg-green-100 text-green-700',
};

export default function DraftSettingsPanel({
  selectedCaseId,
  onCaseChange,
  activeDraftId,
  onDraftSelect,
  onDraftCreated,
}: DraftSettingsPanelProps) {
  const [cases, setCases] = useState<Case[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [caseSearch, setCaseSearch] = useState('');
  const [showCaseDropdown, setShowCaseDropdown] = useState(false);

  // New draft form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState<string>(DOCUMENT_TYPES[0]);
  const [creating, setCreating] = useState(false);

  // Load cases
  useEffect(() => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => setCases(Array.isArray(data) ? data : data.cases || []))
      .catch(() => {});
  }, []);

  // Load drafts when case changes
  useEffect(() => {
    if (!selectedCaseId) {
      setDrafts([]);
      return;
    }
    setLoading(true);
    fetch(`/api/drafts?caseId=${selectedCaseId}`)
      .then(r => r.json())
      .then(data => setDrafts(Array.isArray(data) ? data : []))
      .catch(() => setDrafts([]))
      .finally(() => setLoading(false));
  }, [selectedCaseId]);

  const selectedCase = cases.find(c => c.id === selectedCaseId);

  const filteredCases = caseSearch.trim()
    ? cases.filter(c =>
        c.name.toLowerCase().includes(caseSearch.toLowerCase()) ||
        (c.caseNumber || '').toLowerCase().includes(caseSearch.toLowerCase())
      ).slice(0, 30)
    : cases.slice(0, 30);

  const handleCreate = useCallback(async () => {
    if (!selectedCaseId || !newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: selectedCaseId,
          title: newTitle.trim(),
          documentType: newType,
        }),
      });
      if (res.ok) {
        const draft = await res.json();
        setDrafts(prev => [draft, ...prev]);
        onDraftCreated(draft);
        setNewTitle('');
        setShowNewForm(false);
      }
    } catch {}
    setCreating(false);
  }, [selectedCaseId, newTitle, newType, onDraftCreated]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700">Draft Settings</h2>
      </div>

      {/* Case Selector */}
      <div className="px-3 py-2 border-b border-gray-200">
        <label className="text-xs text-gray-500 font-medium mb-1 block">Court Case</label>
        <div className="relative">
          <button
            onClick={() => setShowCaseDropdown(!showCaseDropdown)}
            className="w-full text-left px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white hover:border-gray-400 truncate"
          >
            {selectedCase
              ? `${selectedCase.caseNumber || ''} ${selectedCase.name}`.trim()
              : 'Select a case...'}
          </button>
          {showCaseDropdown && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
              <div className="p-1.5">
                <input
                  type="text"
                  value={caseSearch}
                  onChange={e => setCaseSearch(e.target.value)}
                  placeholder="Search cases..."
                  className="w-full px-2 py-1 text-sm border border-gray-200 rounded"
                  autoFocus
                />
              </div>
              {filteredCases.map(c => (
                <button
                  key={c.id}
                  onClick={() => {
                    onCaseChange(c.id);
                    setShowCaseDropdown(false);
                    setCaseSearch('');
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 truncate ${
                    c.id === selectedCaseId ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                  }`}
                >
                  <span className="font-medium">{c.caseNumber || ''}</span>{' '}
                  {c.name}
                </button>
              ))}
              {filteredCases.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-400">No cases found</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* New Document Button */}
      <div className="px-3 py-2 border-b border-gray-200">
        {!showNewForm ? (
          <button
            onClick={() => setShowNewForm(true)}
            disabled={!selectedCaseId}
            className="w-full px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + New Document
          </button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              placeholder="Document title..."
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md"
              autoFocus
            />
            <select
              value={newType}
              onChange={e => setNewType(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
            >
              {DOCUMENT_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <button
                onClick={handleCreate}
                disabled={creating || !newTitle.trim()}
                className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowNewForm(false); setNewTitle(''); }}
                className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Draft List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-4 text-xs text-gray-400">Loading drafts...</div>
        ) : !selectedCaseId ? (
          <div className="px-3 py-4 text-xs text-gray-400">Select a case to see drafts</div>
        ) : drafts.length === 0 ? (
          <div className="px-3 py-4 text-xs text-gray-400">No drafts yet</div>
        ) : (
          <div className="py-1">
            {drafts.map(d => (
              <button
                key={d.id}
                onClick={() => onDraftSelect(d)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 ${
                  d.id === activeDraftId ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-800 truncate flex-1">
                    {d.title}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'}`}>
                    {d.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] text-gray-500">{d.documentType}</span>
                  <span className="text-[10px] text-gray-400">v{d.version}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
