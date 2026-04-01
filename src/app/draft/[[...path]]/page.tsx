'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { getPreference, setPreference } from '@/lib/indexed-db';
import DraftSettingsPanel from '@/components/draft/draft-settings-panel';
import DraftChatPanel from '@/components/draft/draft-chat-panel';
import { DraftContextMenu } from '@/components/draft/draft-context-menu';
import type { DraftSummary, DraftFull } from '@/lib/draft/draft-types';
import { useDraftStream } from '@/hooks/use-draft-stream';
import { AI_PROVIDERS, type AIProviderKey } from '@/lib/ai/models';

const DraftEditor = dynamic(() => import('@/components/draft/draft-editor'), {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading editor...</div>,
});

const DraftToolbar = dynamic(() => import('@/components/draft/draft-toolbar'), { ssr: false });

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
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef('');

  // Editor
  const editorRef = useRef<any>(null);
  const [trackChanges, setTrackChanges] = useState(false);
  const [editorSelection, setEditorSelection] = useState({ selectedText: '', hasSelection: false });

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // AI transform stream
  const transform = useDraftStream();

  // AI provider (defaults)
  const [provider, setProvider] = useState<AIProviderKey>('ollama');
  const [model, setModel] = useState('');

  // ---- Persist & restore ----

  useEffect(() => {
    try {
      const lw = Number(localStorage.getItem(LS_LEFT_WIDTH));
      if (lw >= LEFT_MIN && lw <= LEFT_MAX) setLeftWidth(lw);
      const rw = Number(localStorage.getItem(LS_RIGHT_WIDTH));
      if (rw >= RIGHT_MIN && rw <= RIGHT_MAX) setRightWidth(rw);
    } catch {}
  }, []);

  // Session restore (only when URL is bare /draft)
  useEffect(() => {
    if (urlCaseId) return;
    getPreference<LastState>(PREF_LAST_STATE).then(state => {
      if (!state) return;
      if (state.caseId) {
        setSelectedCaseId(state.caseId);
        if (state.draftId) {
          loadDraft(state.draftId);
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
      }
    } catch {}
  }, []);

  // ---- Auto-save ----

  const handleEditorUpdate = useCallback((json: string) => {
    if (!activeDraft) return;
    if (json === lastSavedContent.current) return;
    setSaveStatus('unsaved');

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await fetch(`/api/drafts/${activeDraft.id}`, {
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
  }, [activeDraft]);

  // ---- Selection change ----

  const handleSelectionChange = useCallback((sel: { selectedText: string; hasSelection: boolean }) => {
    setEditorSelection(sel);
  }, []);

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

  const editorContent = activeDraft?.content || '';

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
            editor={editorRef.current?.editor || null}
            saveStatus={saveStatus}
            trackChanges={trackChanges}
            onToggleTrackChanges={() => setTrackChanges(t => !t)}
          />
        )}

        {/* Editor area */}
        {activeDraft ? (
          <div className="flex-1 overflow-y-auto relative">
            <DraftEditor
              ref={editorRef}
              content={editorContent}
              onUpdate={handleEditorUpdate}
              onSelectionChange={handleSelectionChange}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
              }}
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
          documentContent={editorRef.current?.getMarkdown?.() || ''}
          selectedText={editorSelection.selectedText}
          hasSelection={editorSelection.hasSelection}
          onInsertText={handleInsertText}
          onReplaceSelection={handleReplaceSelection}
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
    </div>
  );
}
