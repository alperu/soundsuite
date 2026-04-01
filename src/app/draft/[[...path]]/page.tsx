'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { getPreference, setPreference } from '@/lib/indexed-db';
import { usePersistedState } from '@/hooks/use-persisted-state';
import DraftSettingsPanel from '@/components/draft/draft-settings-panel';
import DraftChatPanel from '@/components/draft/draft-chat-panel';
import { DraftContextMenu } from '@/components/draft/draft-context-menu';
import { TOCContextMenu } from '@/components/draft/toc-context-menu';
import type { DraftSummary, DraftFull } from '@/lib/draft/draft-types';
import { useDraftStream } from '@/hooks/use-draft-stream';
import { AI_PROVIDERS, type AIProviderKey } from '@/lib/ai/models';

const DraftEditor = dynamic(() => import('@/components/draft/draft-editor'), {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading editor...</div>,
});

import DraftToolbar from '@/components/draft/draft-toolbar';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEFT_MIN = 220;
const LEFT_MAX = 450;
const LEFT_DEFAULT = 280;
const RIGHT_MIN = 280;
const RIGHT_MAX = 500;
const RIGHT_DEFAULT = 360;

const LS_LEFT_WIDTH = 'draft-left-width';
const LS_RIGHT_WIDTH = 'draft-right-width';
const PREF_LAST_STATE = 'draft.lastState';
const PREF_CASE_ID = 'draft.selectedCaseId';

interface LastState {
  caseId: string;
  draftId: string | null;
  draftSlug: string | null;
  rightTab: 'chat' | 'workflows';
}

// ---------------------------------------------------------------------------
// Provider selector helper
// ---------------------------------------------------------------------------

const PROVIDER_KEYS = Object.keys(AI_PROVIDERS) as AIProviderKey[];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DraftPage() {
  const router = useRouter();
  const params = useParams<{ path?: string[] }>();
  const urlCaseId = params.path?.[0] || '';
  const urlSlug = params.path?.[1] || '';

  // Panel widths
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const isResizingLeft = useRef(false);
  const isResizingRight = useRef(false);

  // Case & draft
  const [selectedCaseId, setSelectedCaseId] = useState(urlCaseId);
  const [activeDraft, setActiveDraft] = useState<DraftFull | null>(null);
  const [linkedCaseIds, setLinkedCaseIds] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef('');

  // Editor
  const editorRef = useRef<any>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const [trackChanges, setTrackChanges] = usePersistedState<boolean>('draft.editor.trackChanges', false);
  const [editorSelection, setEditorSelection] = useState({ selectedText: '', hasSelection: false });

  // Font family (persisted)
  const [fontFamily, setFontFamily] = usePersistedState<string>('draft.editor.fontFamily', '');

  // Formatting marks & page view (persisted)
  const [showMarks, setShowMarks] = usePersistedState<boolean>('draft.editor.showMarks', false);
  const [pageView, setPageView] = usePersistedState<boolean>('draft.editor.pageView', false);
  const [pageSettings, setPageSettings] = useState<{ pageSize: 'letter' | 'a4' | 'legal'; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number }>({ pageSize: 'letter', marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96 });

  // Zoom (persisted to localStorage)
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    try {
      const z = Number(localStorage.getItem('draft-zoom-level'));
      if (z >= 0.5 && z <= 2) setZoom(z);
    } catch {}
  }, []);
  const handleZoomChange = useCallback((z: number) => {
    const clamped = Math.round(Math.min(2, Math.max(0.5, z)) * 100) / 100;
    setZoom(clamped);
    try { localStorage.setItem('draft-zoom-level', String(clamped)); } catch {}
  }, []);

  // Load page settings from config
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        if (cfg.draftPageSize || cfg.draftMarginTop) {
          setPageSettings({
            pageSize: (cfg.draftPageSize || 'letter') as 'letter' | 'a4' | 'legal',
            marginTop: Number(cfg.draftMarginTop) || 96,
            marginBottom: Number(cfg.draftMarginBottom) || 96,
            marginLeft: Number(cfg.draftMarginLeft) || 96,
            marginRight: Number(cfg.draftMarginRight) || 96,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Version preview
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // TOC context menu
  const [tocContextMenu, setTocContextMenu] = useState<{
    x: number; y: number;
    attrs: { tocStyle: string; showNumbers: boolean; maxDepth: number; fontFamily?: string | null };
  } | null>(null);

  // AI transform stream
  const transform = useDraftStream();

  // AI provider (persisted)
  const [provider, setProvider] = usePersistedState<AIProviderKey>('draft.transform.provider', 'ollama');
  const [model, setModel] = usePersistedState<string>('draft.transform.model', '');

  // ---- Persist & restore ----

  useEffect(() => {
    try {
      const lw = Number(localStorage.getItem(LS_LEFT_WIDTH));
      if (lw >= LEFT_MIN && lw <= LEFT_MAX) setLeftWidth(lw);
      const rw = Number(localStorage.getItem(LS_RIGHT_WIDTH));
      if (rw >= RIGHT_MIN && rw <= RIGHT_MAX) setRightWidth(rw);
    } catch {}
  }, []);

  // URL-based restore: when URL has /draft/{caseId}/{slug}, load that draft
  useEffect(() => {
    if (!urlCaseId || !urlSlug) return;
    // Fetch drafts for this case and find the one matching the slug
    fetch(`/api/drafts?caseId=${urlCaseId}`)
      .then(r => r.json())
      .then(data => {
        const drafts = data.drafts || data || [];
        const match = drafts.find((d: any) => d.slug === urlSlug);
        if (match) {
          loadDraft(match.id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCaseId, urlSlug]);

  // Session restore (only when URL is bare /draft)
  useEffect(() => {
    if (urlCaseId) return;
    getPreference<LastState>(PREF_LAST_STATE).then(state => {
      if (!state) return;
      if (state.caseId) {
        setSelectedCaseId(state.caseId);
        if (state.draftId) {
          loadDraft(state.draftId);
          // Restore URL so refresh works again
          if (state.draftSlug) {
            router.replace(`/draft/${state.caseId}/${state.draftSlug}`, { scroll: false });
          } else {
            router.replace(`/draft/${state.caseId}`, { scroll: false });
          }
        } else {
          router.replace(`/draft/${state.caseId}`, { scroll: false });
        }
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist session state
  useEffect(() => {
    if (selectedCaseId) {
      const state: LastState = {
        caseId: selectedCaseId,
        draftId: activeDraft?.id || null,
        draftSlug: activeDraft?.slug || null,
        rightTab: 'chat',
      };
      setPreference(PREF_LAST_STATE, state).catch(() => {});
      setPreference(PREF_CASE_ID, selectedCaseId).catch(() => {});
    }
  }, [selectedCaseId, activeDraft?.id]);

  // ---- Load draft ----

  const loadDraft = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/drafts/${id}`);
      if (res.ok) {
        const draft = await res.json();
        setActiveDraft(draft);
        lastSavedContent.current = draft.content || '';
        setSaveStatus('saved');
        // Load linked cases
        setLinkedCaseIds(draft.linkedCases?.map((c: any) => c.id) || []);
      }
    } catch {}
  }, []);

  // ---- Auto-save ----

  // Reset editor instance when switching drafts
  useEffect(() => {
    setEditorInstance(null);
  }, [activeDraft?.id]);

  const activeDraftIdRef = useRef(activeDraft?.id);
  activeDraftIdRef.current = activeDraft?.id;

  const handleEditorUpdate = useCallback((json: string) => {
    if (!activeDraftIdRef.current) return;
    if (json === lastSavedContent.current) return;
    setSaveStatus('unsaved');

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await fetch(`/api/drafts/${activeDraftIdRef.current}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: json }),
        });
        lastSavedContent.current = json;
        setSaveStatus('saved');
      } catch {
        setSaveStatus('unsaved');
      }
    }, 1500);
  }, []); // stable — uses ref for draft ID

  // ---- Selection change ----

  const handleSelectionChange = useCallback((sel: { selectedText: string; hasSelection: boolean }) => {
    setEditorSelection(sel);
    // Signal editor is ready on first callback (replaces polling interval)
    if (!editorInstance && editorRef.current?.editor) {
      setEditorInstance(editorRef.current.editor);
    }
  }, [editorInstance]);

  // ---- Context menu actions ----

  const handleContextMenuAction = useCallback(async (action: string, options?: { tone?: string }) => {
    setContextMenu(null);
    if (!editorRef.current) return;

    const sel = editorRef.current.getSelection();
    if (!sel.hasSelection || !sel.selectedText) return;

    const result = await transform.send('/api/draft/transform', {
      action,
      selectedText: sel.selectedText,
      tone: options?.tone,
      provider,
      model,
    });

    // Result handled via effect below
  }, [provider, model, transform]);

  // Apply transform result to editor
  useEffect(() => {
    if (transform.result?.text && editorRef.current) {
      editorRef.current.replaceSelection(transform.result.text);
    }
  }, [transform.result]);

  // Listen for TOC context menu events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        setTocContextMenu({ x: detail.x, y: detail.y, attrs: detail.attrs });
        setContextMenu(null); // close regular menu if open
      }
    };
    document.addEventListener('toc-contextmenu', handler);
    return () => document.removeEventListener('toc-contextmenu', handler);
  }, []);

  // ---- Resize handlers ----

  const handleLeftResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingLeft.current = true;
    const startX = e.clientX;
    const startWidth = leftWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isResizingLeft.current) return;
      setLeftWidth(Math.min(LEFT_MAX, Math.max(LEFT_MIN, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      isResizingLeft.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setLeftWidth(prev => {
        try { localStorage.setItem(LS_LEFT_WIDTH, String(prev)); } catch {}
        return prev;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  const handleRightResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRight.current = true;
    const startX = e.clientX;
    const startWidth = rightWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isResizingRight.current) return;
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, startWidth - (ev.clientX - startX))));
    };
    const onUp = () => {
      isResizingRight.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRightWidth(prev => {
        try { localStorage.setItem(LS_RIGHT_WIDTH, String(prev)); } catch {}
        return prev;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  // ---- Case change ----

  const handleCaseChange = useCallback((caseId: string) => {
    setSelectedCaseId(caseId);
    setActiveDraft(null);
    router.replace(`/draft/${caseId}`, { scroll: false });
  }, [router]);

  // ---- Draft select ----

  const handleDraftSelect = useCallback((draft: DraftSummary) => {
    loadDraft(draft.id);
    router.replace(`/draft/${selectedCaseId}/${draft.slug}`, { scroll: false });
  }, [loadDraft, selectedCaseId, router]);

  const handleDraftCreated = useCallback((draft: DraftSummary) => {
    loadDraft(draft.id);
    router.replace(`/draft/${selectedCaseId}/${draft.slug}`, { scroll: false });
  }, [loadDraft, selectedCaseId, router]);

  // ---- Chat actions ----

  const handleInsertText = useCallback((text: string) => {
    editorRef.current?.insertAtCursor(text);
  }, []);

  const handleReplaceSelection = useCallback((text: string) => {
    editorRef.current?.replaceSelection(text);
  }, []);

  // ---- Parse initial content ----

  // Memoize context menu handler to prevent editor re-renders
  const handleEditorContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Memoize editorContent to prevent new reference every render (fixes content sync loop)
  const editorContent = useMemo(() => {
    const raw = previewContent ?? activeDraft?.content ?? '';
    if (raw && typeof raw === 'string' && raw.startsWith('{')) {
      try { return JSON.parse(raw); } catch {}
    }
    return raw;
  }, [previewContent, activeDraft?.content]);

  return (
    <div className="flex h-full overflow-hidden bg-white">
      {/* Left Panel - Settings */}
      <div style={{ width: leftWidth }} className="shrink-0 border-r border-gray-200 flex flex-col overflow-hidden">
        <DraftSettingsPanel
          selectedCaseId={selectedCaseId}
          onCaseChange={handleCaseChange}
          activeDraftId={activeDraft?.id || null}
          onDraftSelect={handleDraftSelect}
          onDraftCreated={handleDraftCreated}
          linkedCaseIds={linkedCaseIds}
          onLinkedCasesChange={setLinkedCaseIds}
        />
      </div>

      {/* Left resize handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors shrink-0"
        onMouseDown={handleLeftResizeStart}
      />

      {/* Middle Panel - Editor */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Provider/Model selector bar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-gray-50 text-xs shrink-0">
          <label className="text-gray-500">AI:</label>
          <select
            value={provider}
            onChange={e => {
              const p = e.target.value as AIProviderKey;
              setProvider(p);
              setModel(AI_PROVIDERS[p].models[0]?.id || '');
            }}
            className="px-1.5 py-0.5 border border-gray-300 rounded text-xs bg-white"
          >
            {PROVIDER_KEYS.map(k => (
              <option key={k} value={k}>{AI_PROVIDERS[k].name}</option>
            ))}
          </select>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="px-1.5 py-0.5 border border-gray-300 rounded text-xs bg-white"
          >
            {(AI_PROVIDERS[provider]?.models || []).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          {activeDraft && (
            <span className="ml-auto text-gray-500">
              {activeDraft.documentType} — {activeDraft.title}
            </span>
          )}
        </div>

        {/* Toolbar */}
        {activeDraft && (
          <DraftToolbar
            editor={editorInstance || null}
            saveStatus={saveStatus}
            trackChanges={trackChanges}
            onToggleTrackChanges={() => setTrackChanges(t => !t)}
            fontFamily={fontFamily}
            onFontFamilyChange={setFontFamily}
            caseId={selectedCaseId}
            onImportComplete={() => {
              const cid = selectedCaseId;
              setSelectedCaseId('');
              setTimeout(() => setSelectedCaseId(cid), 50);
            }}
            showMarks={showMarks}
            onToggleShowMarks={() => setShowMarks(v => !v)}
            pageView={pageView}
            onTogglePageView={() => setPageView(v => !v)}
            zoom={zoom}
            onZoomChange={handleZoomChange}
            draftId={activeDraft?.id}
            provider={provider}
            model={model}
          />
        )}

        {/* Preview banner */}
        {previewContent !== null && (
          <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 flex items-center gap-2 shrink-0">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span className="font-medium">Previewing older version</span>
            <span className="text-amber-500">(read-only)</span>
            <button
              onClick={() => setPreviewContent(null)}
              className="ml-auto px-2 py-0.5 text-[11px] text-gray-600 border border-gray-300 rounded hover:bg-gray-100"
            >
              Back to current
            </button>
          </div>
        )}

        {/* Editor area */}
        {activeDraft ? (
          <div className="flex-1 overflow-y-auto relative">
            <DraftEditor
              ref={editorRef}
              content={editorContent}
              onUpdate={handleEditorUpdate}
              onSelectionChange={handleSelectionChange}
              showMarks={showMarks}
              pageView={pageView}
              pageSettings={pageSettings}
              zoom={zoom}
              onZoomChange={handleZoomChange}
              onContextMenu={handleEditorContextMenu}
            />
            {/* Transform loading overlay */}
            {transform.isStreaming && (
              <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10">
                <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-4 max-w-sm">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Transforming text...
                  </div>
                  {transform.tokens && (
                    <div className="mt-2 text-xs text-gray-500 max-h-32 overflow-y-auto">
                      {transform.tokens}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            {selectedCaseId
              ? 'Select or create a draft to start editing'
              : 'Select a case to get started'}
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors shrink-0"
        onMouseDown={handleRightResizeStart}
      />

      {/* Right Panel - Chat */}
      <div style={{ width: rightWidth }} className="shrink-0 border-l border-gray-200 flex flex-col overflow-hidden">
        <DraftChatPanel
          caseId={selectedCaseId}
          caseIds={linkedCaseIds}
          documentContent={editorRef.current?.getMarkdown?.() || ''}
          selectedText={editorSelection.selectedText}
          hasSelection={editorSelection.hasSelection}
          onInsertText={handleInsertText}
          onReplaceSelection={handleReplaceSelection}
          draftId={activeDraft?.id}
          currentVersion={activeDraft?.version}
          onDraftRestore={() => { if (activeDraft) loadDraft(activeDraft.id); }}
          onPreviewVersion={setPreviewContent}
        />
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <DraftContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={handleContextMenuAction}
          hasSelection={editorSelection.hasSelection}
        />
      )}

      {/* TOC Context Menu */}
      {tocContextMenu && (
        <TOCContextMenu
          x={tocContextMenu.x}
          y={tocContextMenu.y}
          attrs={tocContextMenu.attrs}
          onClose={() => setTocContextMenu(null)}
          onUpdateAttrs={(attrs) => {
            const editor = editorRef.current?.editor;
            if (editor) {
              editor.chain().focus().updateAttributes('tableOfContents', attrs).run();
            }
            setTocContextMenu(prev => prev ? { ...prev, attrs: { ...prev.attrs, ...attrs } } : null);
          }}
          onRemove={() => {
            const editor = editorRef.current?.editor;
            if (editor) {
              // Find and delete the TOC node
              editor.state.doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'tableOfContents') {
                  editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
                  return false;
                }
              });
            }
            setTocContextMenu(null);
          }}
        />
      )}
    </div>
  );
}
