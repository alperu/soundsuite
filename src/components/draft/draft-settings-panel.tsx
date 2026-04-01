'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { DOCUMENT_TYPES, DRAFT_STATUSES } from '@/lib/draft/draft-types';
import type { DraftSummary } from '@/lib/draft/draft-types';

interface Case {
  id: string;
  name: string;
  caseNumber?: string;
  jurisdiction?: string;
  state?: string;
  county?: string;
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

interface ContextMenuState {
  x: number;
  y: number;
  draft: DraftSummary;
}

interface SubmenuState {
  type: 'documentType' | 'status';
}

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

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [submenu, setSubmenu] = useState<SubmenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [submenuFlipLeft, setSubmenuFlipLeft] = useState(false);

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Case edit
  const [showCaseEdit, setShowCaseEdit] = useState(false);
  const [caseEditData, setCaseEditData] = useState({
    name: '',
    caseNumber: '',
    jurisdiction: '',
    state: '',
    county: '',
  });
  const [savingCase, setSavingCase] = useState(false);

  // Load cases
  useEffect(() => {
    fetch('/api/cases')
      .then(r => r.json())
      .then(data => setCases(Array.isArray(data) ? data : data.cases || []))
      .catch(() => {});
  }, []);

  // Load drafts when case changes
  const loadDrafts = useCallback(() => {
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

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

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

  // --- Context menu handlers ---

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setSubmenu(null);
  }, []);

  // Close context menu on click outside, escape, scroll
  useEffect(() => {
    if (!contextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        (!submenuRef.current || !submenuRef.current.contains(e.target as Node))
      ) {
        closeContextMenu();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    const handleScroll = () => closeContextMenu();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [contextMenu, closeContextMenu]);

  // Viewport flip for context menu
  useEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) menuRef.current.style.left = `${contextMenu.x - rect.width}px`;
    if (rect.bottom > vh) menuRef.current.style.top = `${contextMenu.y - rect.height}px`;
  }, [contextMenu]);

  // Viewport flip for submenu
  useEffect(() => {
    if (!submenu || !submenuRef.current || !menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const subRect = submenuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    setSubmenuFlipLeft(menuRect.right + subRect.width > vw);
  }, [submenu]);

  const handleContextMenu = (e: React.MouseEvent, draft: DraftSummary) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, draft });
    setSubmenu(null);
  };

  const handleRename = (draft: DraftSummary) => {
    closeContextMenu();
    setRenamingId(draft.id);
    setRenameValue(draft.title);
    setTimeout(() => renameInputRef.current?.select(), 50);
  };

  const submitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/drafts/${renamingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: renameValue.trim() }),
      });
      if (res.ok) {
        const updated = await res.json();
        setDrafts(prev => prev.map(d => d.id === renamingId ? { ...d, title: updated.title } : d));
      }
    } catch {}
    setRenamingId(null);
  };

  const handleChangeType = async (draft: DraftSummary, docType: string) => {
    closeContextMenu();
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType: docType }),
      });
      if (res.ok) {
        setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, documentType: docType } : d));
      }
    } catch {}
  };

  const handleChangeStatus = async (draft: DraftSummary, status: string) => {
    closeContextMenu();
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, status } : d));
      }
    } catch {}
  };

  const handleDuplicate = async (draft: DraftSummary) => {
    closeContextMenu();
    try {
      // Create the duplicate
      const createRes = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: draft.caseId,
          title: draft.title + ' (copy)',
          documentType: draft.documentType,
        }),
      });
      if (!createRes.ok) return;
      const newDraft = await createRes.json();

      // Fetch original content
      const origRes = await fetch(`/api/drafts/${draft.id}`);
      if (origRes.ok) {
        const origData = await origRes.json();
        if (origData.content) {
          await fetch(`/api/drafts/${newDraft.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: origData.content }),
          });
        }
      }

      loadDrafts();
    } catch {}
  };

  const handleDelete = async (draft: DraftSummary) => {
    closeContextMenu();
    if (!window.confirm(`Delete "${draft.title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, { method: 'DELETE' });
      if (res.ok) {
        setDrafts(prev => prev.filter(d => d.id !== draft.id));
      }
    } catch {}
  };

  const handleVersionHistory = (draft: DraftSummary) => {
    closeContextMenu();
    alert(`"${draft.title}" has ${draft.version} version(s).`);
  };

  // --- Case edit handlers ---

  const openCaseEdit = () => {
    if (!selectedCase) return;
    setCaseEditData({
      name: selectedCase.name || '',
      caseNumber: selectedCase.caseNumber || '',
      jurisdiction: selectedCase.jurisdiction || '',
      state: selectedCase.state || '',
      county: selectedCase.county || '',
    });
    setShowCaseEdit(true);
  };

  const saveCaseEdit = async () => {
    if (!selectedCaseId) return;
    setSavingCase(true);
    try {
      const res = await fetch(`/api/cases/${selectedCaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(caseEditData),
      });
      if (res.ok) {
        const data = await res.json();
        const updated = data.case || data;
        setCases(prev =>
          prev.map(c =>
            c.id === selectedCaseId
              ? { ...c, name: updated.name, caseNumber: updated.caseNumber, jurisdiction: updated.jurisdiction, state: updated.state, county: updated.county }
              : c
          )
        );
        setShowCaseEdit(false);
      }
    } catch {}
    setSavingCase(false);
  };

  // --- Shared styles ---
  const itemBase = 'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2';
  const enabledClass = 'text-gray-700 hover:bg-blue-50';

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
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowCaseDropdown(!showCaseDropdown)}
              className="flex-1 text-left px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white hover:border-gray-400 truncate"
            >
              {selectedCase
                ? `${selectedCase.caseNumber || ''} ${selectedCase.name}`.trim()
                : 'Select a case...'}
            </button>
            {selectedCase && (
              <button
                onClick={openCaseEdit}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                title="Edit case info"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
            )}
          </div>
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

      {/* Case Edit Form */}
      {showCaseEdit && selectedCase && (
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600">Edit Case Info</span>
            <button
              onClick={() => setShowCaseEdit(false)}
              className="text-gray-400 hover:text-gray-600 text-xs"
            >
              Cancel
            </button>
          </div>
          <div>
            <label className="text-[11px] text-gray-500">Case Name</label>
            <input
              type="text"
              value={caseEditData.name}
              onChange={e => setCaseEditData(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
            />
          </div>
          <div>
            <label className="text-[11px] text-gray-500">Case Number</label>
            <input
              type="text"
              value={caseEditData.caseNumber}
              onChange={e => setCaseEditData(prev => ({ ...prev, caseNumber: e.target.value }))}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
            />
          </div>
          <div>
            <label className="text-[11px] text-gray-500">Jurisdiction</label>
            <input
              type="text"
              value={caseEditData.jurisdiction}
              onChange={e => setCaseEditData(prev => ({ ...prev, jurisdiction: e.target.value }))}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[11px] text-gray-500">State</label>
              <input
                type="text"
                value={caseEditData.state}
                onChange={e => setCaseEditData(prev => ({ ...prev, state: e.target.value }))}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
              />
            </div>
            <div className="flex-1">
              <label className="text-[11px] text-gray-500">County</label>
              <input
                type="text"
                value={caseEditData.county}
                onChange={e => setCaseEditData(prev => ({ ...prev, county: e.target.value }))}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
              />
            </div>
          </div>
          <button
            onClick={saveCaseEdit}
            disabled={savingCase || !caseEditData.name.trim()}
            className="w-full px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
          >
            {savingCase ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}

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
                onContextMenu={e => handleContextMenu(e, d)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 ${
                  d.id === activeDraftId ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {renamingId === d.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={submitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') submitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      className="text-sm font-medium text-gray-800 flex-1 px-1 py-0 border border-blue-400 rounded outline-none bg-white"
                      autoFocus
                    />
                  ) : (
                    <span className="text-sm font-medium text-gray-800 truncate flex-1">
                      {d.title}
                    </span>
                  )}
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

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {/* Rename */}
          <button
            className={`${itemBase} ${enabledClass}`}
            onClick={() => handleRename(contextMenu.draft)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
            Rename
          </button>

          {/* Change Type - submenu */}
          <div
            className="relative"
            onMouseEnter={() => setSubmenu({ type: 'documentType' })}
            onMouseLeave={() => { if (submenu?.type === 'documentType') setSubmenu(null); }}
          >
            <button className={`${itemBase} ${enabledClass} justify-between`}>
              <span className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Change Type
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {submenu?.type === 'documentType' && (
              <div
                ref={submenuRef}
                className={`absolute top-0 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[140px] ${
                  submenuFlipLeft ? 'right-full mr-1' : 'left-full ml-1'
                }`}
              >
                {DOCUMENT_TYPES.map(t => (
                  <button
                    key={t}
                    className={`${itemBase} ${
                      contextMenu.draft.documentType === t
                        ? 'text-blue-600 bg-blue-50 font-medium'
                        : enabledClass
                    }`}
                    onClick={() => handleChangeType(contextMenu.draft, t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Change Status - submenu */}
          <div
            className="relative"
            onMouseEnter={() => setSubmenu({ type: 'status' })}
            onMouseLeave={() => { if (submenu?.type === 'status') setSubmenu(null); }}
          >
            <button className={`${itemBase} ${enabledClass} justify-between`}>
              <span className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Change Status
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {submenu?.type === 'status' && (
              <div
                ref={submenuRef}
                className={`absolute top-0 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[120px] ${
                  submenuFlipLeft ? 'right-full mr-1' : 'left-full ml-1'
                }`}
              >
                {DRAFT_STATUSES.map(s => (
                  <button
                    key={s}
                    className={`${itemBase} ${
                      contextMenu.draft.status === s
                        ? 'text-blue-600 bg-blue-50 font-medium'
                        : enabledClass
                    }`}
                    onClick={() => handleChangeStatus(contextMenu.draft, s)}
                  >
                    <span className={`inline-block w-2 h-2 rounded-full mr-1 ${
                      s === 'draft' ? 'bg-yellow-400' : s === 'review' ? 'bg-blue-400' : 'bg-green-400'
                    }`} />
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Separator */}
          <div className="border-t border-gray-100 my-1" />

          {/* Duplicate */}
          <button
            className={`${itemBase} ${enabledClass}`}
            onClick={() => handleDuplicate(contextMenu.draft)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Duplicate
          </button>

          {/* Version History */}
          <button
            className={`${itemBase} ${enabledClass}`}
            onClick={() => handleVersionHistory(contextMenu.draft)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Version History
          </button>

          {/* Separator */}
          <div className="border-t border-gray-100 my-1" />

          {/* Delete */}
          <button
            className={`${itemBase} text-red-600 hover:bg-red-50`}
            onClick={() => handleDelete(contextMenu.draft)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
