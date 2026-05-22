'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { deepSearchRunner } from '@/lib/search/deep-search-runner';
import { useRouter } from 'next/navigation';
import { AI_PROVIDERS, AI_PROVIDER_KEYS, AIProviderKey, AIModelDef } from '@/lib/ai/models';
import { getPreference, setPreference } from '@/lib/indexed-db';
import { SearchableCombo } from './searchable-combo';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Module-scope plugin array — a fresh `[remarkGfm]` literal on every render
// defeats ReactMarkdown's internal memoization and forces a full re-parse.
const REMARK_PLUGINS = [remarkGfm];
import { CopyButton } from './copy-button';
import { MCPParamForm } from './mcp/mcp-param-form';
import { MCPResultRenderer } from './mcp/mcp-result-renderer';
import { MCPCategoryBadge } from './mcp/mcp-category-badge';
import { MCPHealthIndicator } from './mcp/mcp-health-indicator';
import { ResizableDivider } from './search/resizable-divider';
import { useResizableColumns } from '@/hooks/use-resizable-columns';
import { AIThinkingLog, type AIProgressEntry } from './search/ai-thinking-log';
import { WorkflowsPanel } from './search/workflows-panel';
import { HistoryPanel } from './search/history-panel';
import { ChatAttachmentsStrip } from './chat-attachments';
import {
  HaystackFilterInput,
  type HaystackFilterInputHandle,
} from './search/haystack-filter-input';
import { SampleQueryPanel } from './search/sample-query-panel';
import { TokenNameSuggestions } from './search/token-name-suggestions';
import {
  ActiveTokenSuggestions,
  type ActiveToken,
  type PickedSuggestion,
} from './search/active-token-suggestions';
import type { SampleQuery } from '@/lib/search/sample-queries';
import {
  buildHaystackFilter,
  type FilterChip,
} from '@/lib/search/haystack-query-builder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchMode = 'ai' | 'direct' | 'analysis';
type DirectSubMode = 'semantic' | 'pattern';

interface Case { id: string; name: string }

interface SearchResult {
  text: string;
  document: string;
  page: number;
  score?: number;
  match?: string;
}

interface AISearchResult {
  answer: string;
  sources: Array<{
    text: string;
    document: string;
    page: number;
    score: number;
    citation?: string;
    citationShort?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    filingSlug?: string;
    annotations?: string;
  }>;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface DeepSearchProgress {
  step: 'decomposing' | 'searching' | 'pattern_searching' | 'merging' | 'reranking' | 'generating' | 'done' | 'warning';
  message: string;
  subQueryIndex?: number;
  subQueryTotal?: number;
  subQueries?: string[];
  intent?: string;
  searchStats?: Partial<{
    totalRetrieved: number;
    uniqueAfterDedup: number;
    finalAfterRerank: number;
    subQueryCount: number;
  }>;
  warnings?: Array<{ source: string; host?: string; message: string; count?: number }>;
}

interface AIConversationTurn {
  query: string;
  result: AISearchResult;
  searchTime: number | null;
}

interface DeepSearchTurn {
  query: string;
  result: DeepSearchResult;
  searchTime: number | null;
}

interface DeepSearchResult {
  report: string;
  sources: Array<{
    text: string;
    document: string;
    page: number;
    score: number;
    citation?: string;
    citationShort?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    filingSlug?: string;
    annotations?: string;
    matchedSubQueries: string[];
  }>;
  subQueries: string[];
  intent: string;
  searchStats: {
    totalRetrieved: number;
    uniqueAfterDedup: number;
    finalAfterRerank: number;
    subQueryCount: number;
  };
  model: string;
  provider: string;
}

interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  ready: boolean;
  readyReasons: string[];
  totalExecutions: number;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

interface EmbeddingInfo {
  embeddingProvider: string;
  embeddingModel: string;
  ollamaModel?: string;
}

interface SearchInterfaceProps {
  cases: Case[];
  configuredProviders: Record<string, boolean>;
  tools: ToolInfo[];
  documents: Array<{ id: string; fileName: string }>;
  embeddingInfo?: EmbeddingInfo;
  ollamaCompletionModel?: string;
  initialMode?: SearchMode;
  initialDeepMode?: boolean;
  initialCompareMode?: boolean;
  initialToolName?: string | null;
  toolSlugMap?: Record<string, string>;
  hasExplicitPath?: boolean;
}

// ---------------------------------------------------------------------------
// usePersistedState — useState backed by IndexedDB preferences
// ---------------------------------------------------------------------------

function usePersistedState<T>(key: string, initialValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initialValue);
  const initialized = useRef(false);

  useEffect(() => {
    getPreference<T>(key).then(stored => {
      if (stored !== null) setValue(stored);
      initialized.current = true;
    }).catch(() => { initialized.current = true; });
  }, [key]);

  const setAndPersist = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      if (initialized.current) setPreference(key, next).catch(() => {});
      return next;
    });
  }, [key]);

  return [value, setAndPersist];
}

// ---------------------------------------------------------------------------
// Provider/model definitions — derived from the shared registry
// ---------------------------------------------------------------------------

const PROVIDERS = AI_PROVIDER_KEYS.map(key => ({
  key,
  name: AI_PROVIDERS[key].name,
  models: AI_PROVIDERS[key].models,
}));

const CATEGORY_ORDER = ['search', 'contradiction', 'argument', 'timeline', 'entity', 'review'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModels(
  providerKey: string,
  ollamaCompletionModel?: string,
  dynamicOllamaModels?: AIModelDef[] | null,
): AIModelDef[] {
  // For Ollama, prefer dynamic models fetched from the running instance
  if (providerKey === 'ollama' && dynamicOllamaModels && dynamicOllamaModels.length > 0) {
    return dynamicOllamaModels;
  }
  const base = PROVIDERS.find(p => p.key === providerKey)?.models ?? [];
  if (providerKey === 'ollama' && ollamaCompletionModel) {
    if (!base.some(m => m.id === ollamaCompletionModel)) {
      return [{ id: ollamaCompletionModel, label: `${ollamaCompletionModel} (configured)` }, ...base];
    }
  }
  return [...base];
}

function getModelLabel(providerKey: string, modelId: string) {
  const m = PROVIDERS.find(p => p.key === providerKey)?.models.find(m => m.id === modelId);
  return m?.label ?? modelId;
}

function getProviderName(providerKey: string) {
  return PROVIDERS.find(p => p.key === providerKey)?.name ?? providerKey;
}

/** Build a case-explorer URL for a source citation. Returns null if not enough data. */
function getExplorerUrl(source: { caseNumber?: string; filingType?: string; filingSlug?: string; page: number }): string | null {
  if (!source.caseNumber || !source.filingType || !source.filingSlug) return null;
  return `/case-explorer/${encodeURIComponent(source.caseNumber)}/${encodeURIComponent(source.filingType)}/${source.filingSlug}?pageNum=${source.page}`;
}

function formatEmbeddingLabel(info: EmbeddingInfo) {
  if (info.embeddingProvider === 'ollama' && info.ollamaModel) {
    return `Ollama / ${info.ollamaModel}`;
  }
  return `${info.embeddingProvider} / ${info.embeddingModel}`;
}

// ---------------------------------------------------------------------------
// Color accents for compare mode cards
// ---------------------------------------------------------------------------

const COMPARE_COLORS = [
  { border: 'border-t-blue-500', bg: 'bg-blue-50' },
  { border: 'border-t-purple-500', bg: 'bg-purple-50' },
  { border: 'border-t-amber-500', bg: 'bg-amber-50' },
  { border: 'border-t-red-500', bg: 'bg-red-50' },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function SearchInterface({
  cases,
  configuredProviders,
  tools,
  documents,
  embeddingInfo,
  ollamaCompletionModel,
  initialMode = 'ai',
  initialDeepMode = false,
  initialCompareMode = false,
  initialToolName = null,
  toolSlugMap = {},
  hasExplicitPath = false,
}: SearchInterfaceProps) {
  const router = useRouter();
  const { widths: columnWidths, startResize } = useResizableColumns();

  // Search mode — driven by URL when explicit path, otherwise persisted
  const [mode, setModeState] = useState<SearchMode>(initialMode);

  // Restore mode from IndexedDB only when no explicit URL path
  useEffect(() => {
    if (hasExplicitPath) return;
    getPreference<SearchMode>('search.mode').then(stored => {
      if (stored !== null) setModeState(stored);
    }).catch(() => {});
  }, [hasExplicitPath]);

  // Direct search state
  const [directMode, setDirectMode] = usePersistedState<DirectSubMode>('search.directMode', 'semantic');
  const [directQuery, setDirectQuery] = useState('');
  const [directCaseId, setDirectCaseId] = usePersistedState<string>('search.directCaseId', '');
  const [directResults, setDirectResults] = useState<SearchResult[]>([]);
  const [directLoading, setDirectLoading] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<number | null>(null);
  const [directSearchTime, setDirectSearchTime] = useState<number | null>(null);

  // AI search state
  const [aiQuery, setAiQuery] = useState('');
  const [aiCaseId, setAiCaseId] = usePersistedState<string>('search.aiCaseId', '');
  const [aiProvider, setAiProvider] = usePersistedState<string>('search.aiProvider', '');
  const [aiModel, setAiModel] = usePersistedState<string>('search.aiModel', '');
  const [aiResults, setAiResults] = useState<AISearchResult[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStopping, setAiStopping] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiStoppedRef = useRef(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSearchTime, setAiSearchTime] = useState<number | null>(null);
  const [compareMode, setCompareMode] = usePersistedState<boolean>('search.compareMode', hasExplicitPath ? initialCompareMode : false);
  const [deepSearchMode, setDeepSearchMode] = usePersistedState<boolean>('search.deepSearchMode', hasExplicitPath ? initialDeepMode : false);
  const [thinkingMode, setThinkingMode] = usePersistedState<boolean>('search.thinkingMode', true);
  const [maxTokens, setMaxTokens] = usePersistedState<number>('search.maxTokens', 2048);
  const [effort, setEffort] = usePersistedState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('search.effort', 'medium');
  const [multiPass, setMultiPass] = usePersistedState<boolean>('search.multiPass', false);
  const [inputHeight, setInputHeight] = usePersistedState<number>('search.inputHeight', 72);
  const [aiTurns, setAiTurns] = useState<AIConversationTurn[]>([]);
  const [deepTurns, setDeepTurns] = useState<DeepSearchTurn[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => `session-${Date.now()}`);
  const [deepProgress, setDeepProgress] = useState<DeepSearchProgress | null>(null);
  const [searchWarnings, setSearchWarnings] = useState<Array<{ source: string; host?: string; message: string; count?: number }>>([]);
  const [aiProgressLog, setAiProgressLog] = useState<AIProgressEntry[]>([]);
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [searchStartTime, setSearchStartTime] = useState(0);
  const [streamingAnswer, setStreamingAnswer] = useState<string | null>(null);
  const [streamTokenCount, setStreamTokenCount] = useState(0);
  const [compareSelections, setCompareSelections] = useState<Map<string, string>>(new Map());
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [attachmentsRefreshKey, setAttachmentsRefreshKey] = useState(0);
  const [uploadingCount, setUploadingCount] = useState(0);
  const dragDepthRef = useRef(0);

  // Haystack filter mode — when on, the AI query input becomes a chip-aware
  // structured filter that drives /api/search/haystack. Default ON; users can
  // disable for legacy textarea behavior.
  const [haystackMode, setHaystackMode] = usePersistedState<boolean>('search.haystackMode', true);
  const [haystackChips, setHaystackChips] = useState<FilterChip[]>([]);
  const [haystackBusy, setHaystackBusy] = useState(false);
  const [haystackPreview, setHaystackPreview] = useState<{
    filter: string;
    haystackCount?: number;
    note?: string;
  } | null>(null);

  // Task #36: in-place combo-box state for the left rail. When the user types
  // `motionType:` / `judge:` / etc., `activeToken` turns non-null and the rail
  // swaps from SampleQueryPanel → ActiveTokenSuggestions. `pickerOptions` is
  // mirrored from the suggestions component so HaystackFilterInput's Enter
  // handler can commit the highlighted row.
  const [activeToken, setActiveToken] = useState<ActiveToken | null>(null);
  const [pickerOptions, setPickerOptions] = useState<PickedSuggestion[]>([]);
  const [pickerHighlight, setPickerHighlight] = useState(0);

  // Token-name suggestions (e.g. `fi` → `filedAfter` / `filedBefore`). Mirrors
  // the partial-name list from HaystackFilterInput so the left rail can render
  // TokenNameSuggestions when no active token is under the cursor but the
  // user has typed a partial token name. Keyboard nav still lives in the
  // input via its existing handleKeyDown branch; the ref lets a panel click
  // run completeToken with proper input focus + cursor sync.
  const [tokenSuggestions, setTokenSuggestions] = useState<string[]>([]);
  const [tokenSuggestionHighlight, setTokenSuggestionHighlight] = useState(0);
  const haystackInputRef = useRef<HaystackFilterInputHandle>(null);

  // Commit a chip from the picker: appends to chips + strips the matching
  // `token:partial` substring out of freetext. The HaystackFilterInput's own
  // commitChip path covers Enter-to-commit; this callback handles mouse clicks
  // on rows in the rail (where the input doesn't have focus during the click).
  const handlePickActiveToken = useCallback(
    (picked: PickedSuggestion) => {
      if (!activeToken) return;
      setHaystackChips((prev) => [
        ...prev,
        { key: activeToken.prefix, value: picked.value, label: picked.label },
      ]);
      setAiQuery((prev) => {
        const before = prev.slice(0, activeToken.startIndex);
        const after = prev.slice(activeToken.endIndex);
        return (before + after).replace(/\s+$/, '');
      });
      setActiveToken(null);
      setPickerHighlight(0);
      setPickerOptions([]);
      // The row's onMouseDown calls e.preventDefault() which keeps focus in
      // the input — no manual refocus needed. The legacy aiQueryRef points
      // at the <textarea> path and isn't valid in haystack mode anyway.
    },
    [activeToken],
  );

  // Run the haystack-aware search whenever the user submits while in
  // structured mode. Sends both the compiled filter and any residual freetext
  // to /api/search/haystack — the endpoint routes the filter to the Haystack
  // server and the freetext to the existing semantic pipeline.
  const runHaystackSearch = useCallback(async () => {
    const { filter, freetext } = buildHaystackFilter(haystackChips, aiQuery);
    if (!filter && !freetext) return;
    setHaystackBusy(true);
    try {
      const res = await fetch('/api/search/haystack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter,
          freetext,
          ...(aiCaseId ? { caseId: aiCaseId } : {}),
        }),
      });
      const data = await res.json();
      setHaystackPreview({
        filter,
        haystackCount: Array.isArray(data?.haystack?.results)
          ? data.haystack.results.length
          : undefined,
        note: data?.haystack?.note,
      });
    } catch (err) {
      setHaystackPreview({
        filter,
        note: `error: ${(err as Error).message}`,
      });
    } finally {
      setHaystackBusy(false);
    }
  }, [haystackChips, aiQuery, aiCaseId]);

  // Click-to-apply from the sample-query panel.
  //
  // Once Task #5 lands (`POST /api/search/interpret`), this will round-trip the
  // English prompt through the interpreter to get back structured chips +
  // freetext residual. Until then, we fall back to populating the input
  // verbatim — semantic search runs over the prompt text and the user can hit
  // Enter to submit, or refine the chips manually.
  const handleSampleQuery = useCallback((q: SampleQuery) => {
    // TODO(task-5): when /api/search/interpret is live, POST {prompt} and use
    // the returned {chips, freetextResidual} to drive setHaystackChips +
    // setAiQuery; on 404 / non-200 keep the verbatim fallback below.
    setHaystackChips([]);
    setAiQuery(q.englishPrompt);
    aiQueryRef.current?.focus();
  }, []);

  // Click-to-insert a token prefix from the glossary. Appending `<token>:`
  // (with a leading space if non-empty) triggers HaystackFilterInput's
  // prefix-detector, which opens the matching picker on the next render.
  const handleSampleToken = useCallback((token: string) => {
    setAiQuery((prev) => {
      const trimmed = prev.replace(/\s+$/, '');
      if (!trimmed) return `${token}:`;
      // Replace a dangling partial token (e.g. user typed "jud") with the
      // selected one. Otherwise append after a single space.
      const partial = trimmed.match(/(?:^|\s)(\w+)$/);
      if (partial) {
        return trimmed.replace(/(?:^|\s)(\w+)$/, (m) => (m.startsWith(' ') ? ` ${token}:` : `${token}:`));
      }
      return `${trimmed} ${token}:`;
    });
    aiQueryRef.current?.focus();
  }, []);

  // Mirror the singleton deep-search runner into local state. This is what
  // lets an in-flight deep search survive page navigation: the runner keeps
  // running outside the React tree, and when this component re-mounts we
  // hydrate UI from runner.getSnapshot() immediately, then track further
  // updates via the subscription.
  useEffect(() => {
    const sync = () => {
      const s = deepSearchRunner.getSnapshot();
      setDeepProgress(s.progress);
      setStreamingAnswer(s.streamingAnswer);
      setStreamTokenCount(s.streamTokenCount);
      setSearchWarnings(s.warnings);
      setAiProgressLog(s.progressLog.map(p => ({
        type: 'progress',
        step: p.step,
        message: p.message,
        timestamp: p.timestamp,
      })) as AIProgressEntry[]);
      // If the runner is still running, force aiLoading true so the spinner
      // and stop button reappear when the user navigates back mid-search.
      if (s.loading) setAiLoading(true);
      // Mirror completed turns scoped to this chat session.
      if (s.sessionId === currentSessionId) {
        const turns = s.turns
          .filter(t => t.sessionId === currentSessionId && t.result)
          .map(t => ({
            query: t.query,
            result: t.result!,
            searchTime: Math.max(0, t.completedAt - s.startTime),
          }));
        if (turns.length > 0) setDeepTurns(turns);
      }
    };
    sync();
    return deepSearchRunner.subscribe(sync);
  }, [currentSessionId]);

  const uploadChatFiles = useCallback(async (files: File[]) => {
    const accepted = files.filter((f) => {
      const name = f.name.toLowerCase();
      const type = (f.type || '').toLowerCase();
      const okExt = name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg');
      const okMime = type === 'application/pdf' || type === 'image/png' || type === 'image/jpeg' || type === 'image/jpg';
      return okExt || okMime;
    });
    const skipped = files.length - accepted.length;
    if (skipped > 0) {
      console.warn(`[chat-attachments] Skipped ${skipped} unsupported file(s); only PDF/PNG/JPG allowed.`);
    }
    if (accepted.length === 0) return;
    setUploadingCount((n) => n + accepted.length);
    try {
      for (const file of accepted) {
        const fd = new FormData();
        fd.append('chatId', currentSessionId);
        fd.append('file', file);
        try {
          await fetch('/api/search/chat-attachments', { method: 'POST', body: fd });
        } catch {
          /* surfaced as ERROR row */
        }
      }
    } finally {
      setUploadingCount((n) => Math.max(0, n - accepted.length));
      setAttachmentsRefreshKey((k) => k + 1);
    }
  }, [currentSessionId]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(e.dataTransfer.files);
    uploadChatFiles(files);
  }, [uploadChatFiles]);

  // Clipboard paste of images (Cmd+V): document-level listener, scoped to AI mode.
  // Uses a ref so we don't re-bind the listener on every uploadChatFiles identity change.
  const uploadChatFilesRef = useRef(uploadChatFiles);
  useEffect(() => { uploadChatFilesRef.current = uploadChatFiles; }, [uploadChatFiles]);
  useEffect(() => {
    if (mode !== 'ai') return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const images: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) images.push(f);
        }
      }
      if (images.length === 0) return; // don't intercept plain text paste
      e.preventDefault();
      uploadChatFilesRef.current(images);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [mode]);
  // Stick-to-bottom: auto-scrolls only when the user is already near the bottom.
  // Reading older content scrolls them up → flag flips off → no autoscroll yank.
  // Default true so the first stream auto-follows.
  const stickToBottomRef = useRef(true);
  // Reveal a "Jump to latest" affordance when sticky is off and new content lands.
  const [hasNewContentBelow, setHasNewContentBelow] = useState(false);

  // Persist compareSelections as array of entries
  const compareInitialized = useRef(false);
  useEffect(() => {
    getPreference<[string, string][]>('search.compareSelections').then(stored => {
      if (stored !== null) setCompareSelections(new Map(stored));
      compareInitialized.current = true;
    }).catch(() => { compareInitialized.current = true; });
  }, []);
  useEffect(() => {
    if (!compareInitialized.current) return;
    setPreference('search.compareSelections', Array.from(compareSelections.entries())).catch(() => {});
  }, [compareSelections]);

  // Analysis tools state — persisted via IndexedDB
  const [selectedToolName, setSelectedToolNameState] = usePersistedState<string | null>('search.selectedTool', initialToolName ?? null);
  const [toolResult, setToolResult] = useState<{ toolName: string; data: any; executionTimeMs: number; resultCount: number; error?: string } | null>(null);
  const [toolLoading, setToolLoading] = useState(false);
  const [collapsedCats, setCollapsedCatsState] = useState<Set<string>>(new Set());
  const [infoTab, setInfoTab] = usePersistedState<'workflows' | 'history' | 'bookmarks' | 'docs'>('search.infoTab', 'workflows');
  const [selectedWorkflowIds, setSelectedWorkflowIds] = usePersistedState<string[]>('search.selectedWorkflowIds', []);

  // Persist collapsed categories as array
  const collapsedInitialized = useRef(false);
  useEffect(() => {
    getPreference<string[]>('search.collapsedCategories').then(stored => {
      if (stored !== null) setCollapsedCatsState(new Set(stored));
      collapsedInitialized.current = true;
    }).catch(() => { collapsedInitialized.current = true; });
  }, []);
  useEffect(() => {
    if (!collapsedInitialized.current) return;
    setPreference('search.collapsedCategories', Array.from(collapsedCats)).catch(() => {});
  }, [collapsedCats]);

  // Dynamic Ollama models — fetched from the running Ollama instance
  const [ollamaModels, setOllamaModels] = useState<AIModelDef[] | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaDefaultModel, setOllamaDefaultModel] = useState<string | null>(ollamaCompletionModel ?? null);
  const ollamaFetchedRef = useRef(false);

  // Refs for Cmd+K
  const aiQueryRef = useRef<HTMLTextAreaElement>(null);
  const directQueryRef = useRef<HTMLInputElement>(null);

  // URL-driven navigation helpers
  // Build AI sub-mode URL
  const getAiUrl = useCallback((deep: boolean, compare: boolean) => {
    if (deep) return '/search/ai/deep';
    if (compare) return '/search/ai/compare';
    return '/search/ai';
  }, []);

  const setMode = useCallback((m: SearchMode) => {
    setModeState(m);
    setPreference('search.mode', m).catch(() => {});
    if (m === 'ai') router.push(getAiUrl(deepSearchMode, compareMode), { scroll: false });
    else if (m === 'direct') router.push('/search/direct', { scroll: false });
    else if (m === 'analysis') router.push('/search/analysistools', { scroll: false });
  }, [router, deepSearchMode, compareMode, getAiUrl]);

  const setSelectedToolName = useCallback((name: string | null) => {
    setSelectedToolNameState(name);
    if (name && toolSlugMap[name]) {
      router.push(`/search/analysistools/${toolSlugMap[name]}`, { scroll: false });
    } else {
      router.push('/search/analysistools', { scroll: false });
    }
  }, [router, toolSlugMap]);

  // Derived
  const caseOptions = cases.map(c => c.name);
  const caseNameToId = new Map(cases.map(c => [c.name, c.id]));
  const caseIdToName = new Map(cases.map(c => [c.id, c.name]));
  const enabledTools = tools.filter(t => t.enabled);
  const selectedTool = enabledTools.find(t => t.name === selectedToolName) || null;

  // Group tools by category
  const groupedTools = new Map<string, ToolInfo[]>();
  for (const cat of CATEGORY_ORDER) {
    const catTools = enabledTools.filter(t => t.category === cat);
    if (catTools.length > 0) groupedTools.set(cat, catTools);
  }

  // ---------------------------------------------------------------------------
  // Cmd+K keyboard shortcut
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (mode === 'ai') aiQueryRef.current?.focus();
        else if (mode === 'direct') directQueryRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode]);

  // ---------------------------------------------------------------------------
  // Fetch Ollama models dynamically when Ollama is configured
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (ollamaFetchedRef.current) return;
    if (!configuredProviders.ollama) return;
    ollamaFetchedRef.current = true;
    setOllamaModelsLoading(true);

    fetch('/api/ollama/models')
      .then(r => r.json())
      .then(data => {
        const fetched: AIModelDef[] = (data.models && data.models.length > 0)
          ? data.models.map((m: any) => ({ id: m.id, label: m.label || m.id }))
          : [];
        if (fetched.length > 0) setOllamaModels(fetched);

        // Use the default completion model from the backend config
        const defaultModel = data.defaultModel || ollamaCompletionModel;
        if (defaultModel) setOllamaDefaultModel(defaultModel);

        // Reset persisted model if it's no longer available on the Ollama server
        if (aiProvider === 'ollama' && aiModel && fetched.length > 0) {
          const available = fetched.some(m => m.id === aiModel);
          if (!available && defaultModel) {
            setAiModel(defaultModel);
          }
        }
      })
      .catch(() => {
        // Fall back to hardcoded list
      })
      .finally(() => setOllamaModelsLoading(false));
  }, [configuredProviders.ollama]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleProviderChange = (key: string) => {
    setAiProvider(key);
    const models = getModels(key, ollamaDefaultModel ?? undefined, ollamaModels);
    // For Ollama, default to the backend-configured completion model
    if (key === 'ollama' && ollamaDefaultModel && models.some(m => m.id === ollamaDefaultModel)) {
      setAiModel(ollamaDefaultModel);
    } else {
      setAiModel(models[0]?.id ?? '');
    }
  };

  const handleCaseFilterChange = useCallback((newCaseId: string) => {
    if (newCaseId === aiCaseId) return;
    setAiCaseId(newCaseId);
    setAiTurns([]);
    setDeepTurns([]);
    setAiResults([]);
    setAiError(null);
    setDeepProgress(null);
    setStreamingAnswer(null);
    setCurrentSessionId(`session-${Date.now()}`);
  }, [aiCaseId, setAiCaseId]);

  const toggleCompareProvider = (key: string) => {
    setCompareSelections(prev => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else {
        const models = getModels(key, ollamaCompletionModel, ollamaModels);
        const defaultId = key === 'ollama' && ollamaDefaultModel && models.some(m => m.id === ollamaDefaultModel)
          ? ollamaDefaultModel
          : models[0]?.id ?? '';
        next.set(key, defaultId);
      }
      return next;
    });
  };

  const setCompareModel = (providerKey: string, modelId: string) => {
    setCompareSelections(prev => { const next = new Map(prev); next.set(providerKey, modelId); return next; });
  };

  // Direct search
  const handleDirectSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!directQuery.trim()) { setDirectError('Please enter a search query'); return; }
    setDirectLoading(true);
    setDirectError(null);
    setDirectResults([]);
    setSelectedResult(null);
    setDirectSearchTime(null);
    const t0 = performance.now();
    try {
      const endpoint = directMode === 'semantic' ? '/api/search/semantic' : '/api/search/pattern';
      const params = new URLSearchParams({ query: directQuery.trim(), ...(directCaseId && { caseId: directCaseId }) });
      const res = await fetch(`${endpoint}?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Search failed');
      setDirectResults(data.results || []);
      setDirectSearchTime(Math.round(performance.now() - t0));
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDirectLoading(false);
    }
  };

  // AI search — streaming NDJSON
  const doAISearch = async (
    provider: string,
    model: string,
    query?: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<AISearchResult> => {
    const q = (query || aiQuery).trim();
    const signal = aiAbortRef.current?.signal;
    const res = await fetch('/api/search/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q,
        provider,
        model,
        caseId: aiCaseId || undefined,
        chatId: currentSessionId,
        thinking: thinkingMode,
        maxTokens,
        effort,
        ...(history && history.length > 0 ? { history } : {}),
        ...(selectedWorkflowIds.length > 0 ? { workflowIds: selectedWorkflowIds } : {}),
      }),
      signal: aiAbortRef.current?.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'AI search failed');
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response stream');

    // Reset streaming state for this search
    setAiProgressLog([]);
    setSearchStartTime(prev => prev || Date.now());
    setThinkingExpanded(true);
    setStreamingAnswer(null);

    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: AISearchResult | null = null;

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* noop */ }
        const err = new Error('aborted');
        (err as any).name = 'AbortError';
        throw err;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (signal?.aborted) break;
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress') {
            setAiProgressLog(prev => [...prev, { ...event, timestamp: Date.now() }]);
          } else if (event.type === 'token') {
            setStreamingAnswer(prev => (prev ?? '') + event.text);
            setStreamTokenCount(c => c + Math.max(1, Math.round((event.text as string).length / 4)));
          } else if (event.type === 'result') {
            finalResult = event.data as AISearchResult;
          } else if (event.type === 'error') {
            throw new Error(event.error);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== line) throw e;
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'result') finalResult = event.data as AISearchResult;
        else if (event.type === 'error') throw new Error(event.error);
      } catch { /* ignore */ }
    }

    setStreamingAnswer(null);
    // Auto-collapse thinking log after result arrives
    setTimeout(() => setThinkingExpanded(false), 300);
    if (!finalResult) throw new Error('AI search completed without result');
    return finalResult;
  };

  const doDeepSearch = async (
    provider: string,
    model: string,
    query?: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<DeepSearchResult> => {
    const q = (query || aiQuery).trim();
    const result = await deepSearchRunner.start({
      query: q,
      provider,
      model,
      caseId: aiCaseId || undefined,
      sessionId: currentSessionId,
      thinking: thinkingMode,
      maxTokens,
      effort,
      multiPass,
      ...(history && history.length > 0 ? { history } : {}),
      ...(selectedWorkflowIds.length > 0 ? { workflowIds: selectedWorkflowIds } : {}),
    });
    if (!result) {
      // Runner sets lastError on abort/failure; surface it to the caller so
      // the existing catch path in handleAISearch fires.
      const err = deepSearchRunner.getSnapshot().lastError || 'Deep search failed';
      const e = new Error(err);
      if (/aborted|stopped/i.test(err)) (e as any).name = 'AbortError';
      throw e;
    }
    return result;
  };

  // Auto-scroll chat to bottom (force = always, even if user scrolled up)
  const scrollChatToBottom = useCallback((opts?: { force?: boolean; behavior?: ScrollBehavior }) => {
    const force = opts?.force ?? false;
    const behavior = opts?.behavior ?? 'smooth';
    setTimeout(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      if (!force && !stickToBottomRef.current) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
      stickToBottomRef.current = true;
      setHasNewContentBelow(false);
    }, 50);
  }, []);

  // Track whether the user is near the bottom; only auto-scroll when they are.
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const wasSticky = stickToBottomRef.current;
    stickToBottomRef.current = distFromBottom < 80;
    if (stickToBottomRef.current && !wasSticky) setHasNewContentBelow(false);
  }, []);

  // Auto-follow streaming output: when streamingAnswer or deep progress updates,
  // scroll if user is sticky; otherwise surface a "new content" pill.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (!aiLoading) return;
    if (stickToBottomRef.current) {
      // No timeout — chase the stream tightly. instant for snappy feel.
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
    } else {
      setHasNewContentBelow(true);
    }
  }, [streamingAnswer, deepProgress, aiLoading]);

  // Persist chat session to server
  const persistSession = useCallback((
    sessionAiTurns: AIConversationTurn[],
    sessionDeepTurns: DeepSearchTurn[],
    sessionId: string,
  ) => {
    const mode = deepSearchMode ? 'deep' : compareMode ? 'compare' : 'ai';
    const turns: Array<{ role: 'user' | 'assistant'; content: string; mode?: string; searchTime?: number | null; sources?: any[]; searchStats?: any; subQueries?: string[] }> = [];

    if (mode === 'deep') {
      for (const t of sessionDeepTurns) {
        turns.push({ role: 'user', content: t.query, mode: 'deep' });
        turns.push({
          role: 'assistant',
          content: t.result.report,
          mode: 'deep',
          searchTime: t.searchTime,
          sources: t.result.sources?.map(s => ({
            text: s.text,
            document: s.document,
            page: s.page,
            citation: s.citation,
            citationShort: s.citationShort,
          })),
          searchStats: t.result.searchStats,
          subQueries: t.result.subQueries,
        } as any);
      }
    } else {
      for (const t of sessionAiTurns) {
        turns.push({ role: 'user', content: t.query, mode });
        turns.push({
          role: 'assistant',
          content: t.result.answer,
          mode,
          searchTime: t.searchTime,
          sources: t.result.sources?.map((s: any) => ({
            text: s.text || s.content || '',
            document: s.document || s.fileName || '',
            page: s.page || s.pageNumber || 0,
            citation: s.citation,
            citationShort: s.citationShort,
          })),
        });
      }
    }

    if (turns.length === 0) return;

    const caseName = aiCaseId ? cases.find(c => c.id === aiCaseId)?.name : undefined;
    const caseNumber = caseName?.match(/\d{2}-\d{2}-\d{5}-\w+/)?.[0] || caseName;

    fetch('/api/chat/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sessionId,
        mode,
        provider: aiProvider,
        model: aiModel,
        caseNumber: caseNumber || undefined,
        caseId: aiCaseId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstQuery: turns[0]?.content || '',
        turnCount: turns.length,
        turns,
      }),
    }).catch(() => {});
  }, [deepSearchMode, compareMode, aiCaseId, aiProvider, aiModel, cases]);

  const handleAISearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiQuery.trim()) { setAiError('Please enter a question'); return; }

    // Determine if this is a new conversation or follow-up
    const isFollowUp = aiTurns.length > 0 || deepTurns.length > 0;

    aiAbortRef.current = new AbortController();
    aiStoppedRef.current = false;
    setAiStopping(false);
    setAiLoading(true);
    setAiError(null);
    setSearchWarnings([]);

    // User just submitted — they want to see what happens next. Force-snap to
    // bottom and arm the sticky flag so the upcoming stream auto-follows.
    stickToBottomRef.current = true;
    scrollChatToBottom({ force: true });
    setStreamTokenCount(0);
    setSearchStartTime(Date.now());

    // Reset per-search transient state on EVERY submission (including
    // follow-ups). Previously only the !isFollowUp branch cleared these, so
    // a follow-up's stream appended onto the previous turn's text — making it
    // look like the new answer was being added to the same box.
    setStreamingAnswer(null);
    setDeepProgress(null);
    setAiProgressLog([]);
    setSearchWarnings([]);

    if (!isFollowUp) {
      // New conversation — clear everything
      setAiResults([]);
      setAiTurns([]);
      setDeepTurns([]);
      setDeepProgress(null);
      setAiProgressLog([]);
      setSearchStartTime(Date.now());
      setThinkingExpanded(true);
      setStreamingAnswer(null);
      setAiSearchTime(null);
    }

    const currentQuery = aiQuery.trim();
    setAiQuery('');

    const t0 = performance.now();
    try {
      if (deepSearchMode && !compareMode) {
        if (!aiProvider) { setAiError('Select a provider'); setAiLoading(false); return; }
        if (!aiModel) { setAiError('Select a model'); setAiLoading(false); return; }

        // Build history from existing deep turns
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        for (const turn of deepTurns) {
          history.push({ role: 'user', content: turn.query });
          history.push({ role: 'assistant', content: turn.result.report });
        }

        // Runner owns the in-flight + completed state for deep search. The
        // mirror effect copies runner.turns into local deepTurns, so we don't
        // append the turn here. The await resolves once the runner records
        // the completed turn.
        await doDeepSearch(aiProvider, aiModel, currentQuery, history.length > 0 ? history : undefined);
        setDeepProgress(null);
        scrollChatToBottom();
      } else if (compareMode) {
        const entries = Array.from(compareSelections.entries()).filter(([p]) => configuredProviders[p]);
        if (entries.length === 0) { setAiError('Select at least one configured provider'); setAiLoading(false); return; }
        const promises = entries.map(async ([p, m]) => {
          if (!m) return null;
          try { return await doAISearch(p, m, currentQuery); }
          catch { return { answer: `Error from ${getProviderName(p)}`, sources: [], model: m, provider: p, usage: { inputTokens: 0, outputTokens: 0 } } as AISearchResult; }
        });
        const results = (await Promise.all(promises)).filter(Boolean) as AISearchResult[];
        setAiTurns(prev => [...prev, ...results.map(r => ({ query: currentQuery, result: r, searchTime: Math.round(performance.now() - t0) }))]);
        setAiResults(results);
        scrollChatToBottom();
      } else {
        if (!aiProvider) { setAiError('Select a provider'); setAiLoading(false); return; }
        if (!aiModel) { setAiError('Select a model'); setAiLoading(false); return; }

        // Build history from existing turns
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        for (const turn of aiTurns) {
          history.push({ role: 'user', content: turn.query });
          history.push({ role: 'assistant', content: turn.result.answer });
        }

        const result = await doAISearch(aiProvider, aiModel, currentQuery, history.length > 0 ? history : undefined);
        setAiTurns(prev => [...prev, { query: currentQuery, result, searchTime: Math.round(performance.now() - t0) }]);
        scrollChatToBottom();
      }
      setAiSearchTime(Math.round(performance.now() - t0));

      // Persist session immediately using the complete data we already have
      // (Don't rely on React state which may not be flushed yet)
      setTimeout(() => {
        if (aiStoppedRef.current) return; // user stopped — skip persist
        setAiTurns(latestAi => {
          setDeepTurns(latestDeep => {
            persistSession(latestAi, latestDeep, currentSessionId);
            return latestDeep;
          });
          return latestAi;
        });
      }, 500);
    } catch (err) {
      const aborted = aiStoppedRef.current
        || (err instanceof DOMException && err.name === 'AbortError')
        || (err instanceof Error && /aborted/i.test(err.message));
      if (aborted) {
        setAiError('Search stopped');
      } else {
        setAiError(err instanceof Error ? err.message : 'An error occurred');
      }
      // Restore query on error so user can retry
      if (!aiStoppedRef.current) setAiQuery(currentQuery);
      setDeepProgress(null);
      setStreamingAnswer(null);
    } finally {
      aiAbortRef.current = null;
      setAiLoading(false);
      setAiStopping(false);
    }
  };

  const handleStopAI = useCallback(() => {
    aiStoppedRef.current = true;
    if (aiAbortRef.current) aiAbortRef.current.abort();
    // The deep-search runner lives outside this component (so it can survive
    // page navigation), so abort it explicitly too.
    deepSearchRunner.abort();
    setAiStopping(true);
    setAiError('Search stopped');
    setDeepProgress(null);
    setStreamingAnswer(null);
    setAiProgressLog([]);
    // aiLoading stays true; the running async function will transition it
    // via the catch + finally path in handleAISearch. This avoids button
    // swap during the click and avoids stale buffered events repopulating
    // progress state after Stop.
  }, []);

  // Start new chat — clear conversation
  const handleNewChat = useCallback(() => {
    setAiTurns([]);
    setDeepTurns([]);
    setAiResults([]);
    setAiError(null);
    setAiSearchTime(null);
    setDeepProgress(null);
    setAiProgressLog([]);
    setStreamingAnswer(null);
    setAiQuery('');
    const nextSession = `session-${Date.now()}`;
    setCurrentSessionId(nextSession);
    deepSearchRunner.reset(nextSession);
    aiQueryRef.current?.focus();
  }, []);

  // Load a saved session from history
  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/chat/history/${sessionId}`);
      if (!res.ok) return;
      const { session } = await res.json();
      if (!session) return;

      // Set mode
      if (session.mode === 'deep') {
        setDeepSearchMode(true);
        setCompareMode(false);
      } else if (session.mode === 'compare') {
        setCompareMode(true);
        setDeepSearchMode(false);
      } else {
        setDeepSearchMode(false);
        setCompareMode(false);
      }

      // Set provider/model
      if (session.provider) setAiProvider(session.provider);
      if (session.model) setAiModel(session.model);
      if (session.caseId) setAiCaseId(session.caseId);

      // Hydrate turns
      setCurrentSessionId(session.id);
      setAiTurns([]);
      setDeepTurns([]);
      setAiResults([]);
      setAiError(null);

      if (session.mode === 'deep') {
        // Reconstruct deep turns from pairs
        const newDeepTurns: DeepSearchTurn[] = [];
        for (let i = 0; i < session.turns.length - 1; i += 2) {
          const userTurn = session.turns[i];
          const assistantTurn = session.turns[i + 1];
          if (userTurn?.role === 'user' && assistantTurn?.role === 'assistant') {
            newDeepTurns.push({
              query: userTurn.content,
              result: {
                report: assistantTurn.content,
                sources: assistantTurn.sources || [],
                subQueries: assistantTurn.subQueries || [],
                intent: '',
                searchStats: assistantTurn.searchStats || { totalRetrieved: 0, uniqueAfterDedup: 0, finalAfterRerank: 0, subQueryCount: 0 },
                model: session.model,
                provider: session.provider,
              },
              searchTime: assistantTurn.searchTime ?? null,
            });
          }
        }
        setDeepTurns(newDeepTurns);
      } else {
        // Reconstruct AI turns from pairs
        const newAiTurns: AIConversationTurn[] = [];
        for (let i = 0; i < session.turns.length - 1; i += 2) {
          const userTurn = session.turns[i];
          const assistantTurn = session.turns[i + 1];
          if (userTurn?.role === 'user' && assistantTurn?.role === 'assistant') {
            newAiTurns.push({
              query: userTurn.content,
              result: {
                answer: assistantTurn.content,
                sources: [],
                model: session.model,
                provider: session.provider,
                usage: { inputTokens: 0, outputTokens: 0 },
              },
              searchTime: assistantTurn.searchTime ?? null,
            });
          }
        }
        setAiTurns(newAiTurns);
      }

      scrollChatToBottom();
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  }, [scrollChatToBottom, setAiProvider, setAiModel, setAiCaseId, setDeepSearchMode, setCompareMode]);

  // Analysis tool execution
  const handleToolExecute = useCallback(async (params: Record<string, any>) => {
    if (!selectedTool) return;
    if (!aiProvider || !aiModel) {
      setToolResult({ toolName: selectedTool.name, data: null, executionTimeMs: 0, resultCount: 0, error: 'Select a provider and model before running analysis tools.' });
      return;
    }
    setToolLoading(true);
    const start = performance.now();
    try {
      const execBody: Record<string, any> = {
        tool: selectedTool.name,
        params,
        provider: aiProvider,
        model: aiModel,
      };
      console.log('[AnalysisTool] Executing', selectedTool.name, 'with provider:', aiProvider, 'model:', aiModel);
      const res = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(execBody),
      });
      const ms = performance.now() - start;
      const data = await res.json();
      if (!res.ok) {
        setToolResult({ toolName: selectedTool.name, data: null, executionTimeMs: ms, resultCount: 0, error: data.error?.message || 'Execution failed' });
      } else {
        // Tools return results under different keys
        const RESULT_KEYS = ['results', 'contradictions', 'evolution', 'events', 'obligations', 'entities', 'citations'];
        const resultsArr = RESULT_KEYS.map(k => data[k]).find(v => Array.isArray(v));
        setToolResult({ toolName: selectedTool.name, data, executionTimeMs: ms, resultCount: resultsArr ? resultsArr.length : 0 });
      }
    } catch (err: any) {
      setToolResult({ toolName: selectedTool.name, data: null, executionTimeMs: performance.now() - start, resultCount: 0, error: err.message });
    } finally {
      setToolLoading(false);
    }
  }, [selectedTool, aiProvider, aiModel]);

  const toggleCategory = (cat: string) => {
    setCollapsedCatsState(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const compareEntries = Array.from(compareSelections.entries()).filter(([p]) => configuredProviders[p]);

  // Check if conversation has any turns
  const hasConversation = aiTurns.length > 0 || deepTurns.length > 0 || (compareMode && aiResults.length > 0);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full">
      {/* ================================================================= */}
      {/* LEFT SIDEBAR — Search Mode */}
      {/* ================================================================= */}
      <aside className="flex-shrink-0 border-r border-gray-200 bg-gray-50/80 flex flex-col" style={{ width: columnWidths.left }}>
        <div className="p-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tools</h2>
        </div>
        <nav className="p-2 space-y-1">
          <button
            onClick={() => setMode('ai')}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
              mode === 'ai' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <svg className={`w-4 h-4 shrink-0 ${mode === 'ai' ? 'text-blue-600' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            AI Search
          </button>
          <button
            onClick={() => setMode('direct')}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
              mode === 'direct' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <svg className={`w-4 h-4 shrink-0 ${mode === 'direct' ? 'text-blue-600' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            Direct Search
          </button>
          <button
            onClick={() => setMode('analysis')}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
              mode === 'analysis' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <svg className={`w-4 h-4 shrink-0 ${mode === 'analysis' ? 'text-blue-600' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
            </svg>
            Analysis Tools
          </button>
        </nav>
      </aside>

      <ResizableDivider side="left" onResizeStart={startResize} />

      {/* ================================================================= */}
      {/* ANALYSIS TOOLS COLUMN — appears when analysis mode is active */}
      {/* ================================================================= */}
      {mode === 'analysis' && (
        <aside className="w-56 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-gray-200">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Analysis Tools</h3>
            <p className="text-[10px] text-gray-400 mt-0.5">{enabledTools.length} available</p>
          </div>
          {enabledTools.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-xs text-gray-400">No tools enabled</p>
            </div>
          ) : (
            <nav className="p-2 space-y-0.5">
              {enabledTools.map(tool => {
                const isActive = tool.name === selectedToolName;
                const status = !tool.enabled ? 'disabled' : tool.ready ? 'ready' : 'not_ready';
                return (
                  <button key={tool.name}
                    onClick={() => { setSelectedToolName(tool.name); setToolResult(null); }}
                    className={`w-full text-left px-2.5 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <MCPHealthIndicator status={status} />
                      <span className="font-medium text-xs leading-tight">{tool.displayName}</span>
                    </div>
                  </button>
                );
              })}
            </nav>
          )}
        </aside>
      )}

      {/* ================================================================= */}
      {/* CENTER — Top Bar + Main Content */}
      {/* ================================================================= */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3">
          <div className="flex items-center gap-4">
            {/* Left side — mode-specific controls */}
            {mode === 'ai' && !compareMode && (
              <div className="flex items-center gap-3">
                <select value={aiProvider} onChange={e => handleProviderChange(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                >
                  <option value="">Provider...</option>
                  {PROVIDERS.map(p => (
                    <option key={p.key} value={p.key} disabled={!configuredProviders[p.key]}>
                      {p.name}{!configuredProviders[p.key] ? ' (no key)' : ''}
                    </option>
                  ))}
                </select>
                <select value={aiModel} onChange={e => setAiModel(e.target.value)} disabled={!aiProvider}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white disabled:bg-gray-50"
                >
                  {!aiProvider && <option value="">Model...</option>}
                  {aiProvider === 'ollama' && ollamaModelsLoading && <option value="">Loading...</option>}
                  {getModels(aiProvider, ollamaCompletionModel, ollamaModels).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <div className="w-px h-6 bg-gray-200" />
                <select
                  value={aiCaseId}
                  onChange={e => handleCaseFilterChange(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white max-w-[300px]"
                >
                  <option value="">All Cases</option>
                  {cases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {mode === 'ai' && compareMode && (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-indigo-600">Compare Mode</span>
                <div className="w-px h-6 bg-gray-200" />
                <select
                  value={aiCaseId}
                  onChange={e => handleCaseFilterChange(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white max-w-[300px]"
                >
                  <option value="">All Cases</option>
                  {cases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {mode === 'direct' && (
              <div className="flex items-center gap-3">
                <div className="flex gap-1">
                  {(['semantic', 'pattern'] as const).map(m => (
                    <button key={m} type="button" onClick={() => setDirectMode(m)}
                      className={`px-3 py-1.5 rounded-md font-medium text-sm transition-colors ${
                        directMode === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {m === 'semantic' ? 'Semantic' : 'Pattern'}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500">
                  {directMode === 'semantic' ? 'Natural language search using AI embeddings' : 'Regex pattern matching for exact searches'}
                </p>
              </div>
            )}
            {mode === 'analysis' && (
              <div className="flex items-center gap-3">
                <select value={aiProvider} onChange={e => handleProviderChange(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                >
                  <option value="">Provider...</option>
                  {PROVIDERS.map(p => (
                    <option key={p.key} value={p.key} disabled={!configuredProviders[p.key]}>
                      {p.name}{!configuredProviders[p.key] ? ' (no key)' : ''}
                    </option>
                  ))}
                </select>
                <select value={aiModel} onChange={e => setAiModel(e.target.value)} disabled={!aiProvider}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white disabled:bg-gray-50"
                >
                  {!aiProvider && <option value="">Model...</option>}
                  {aiProvider === 'ollama' && ollamaModelsLoading && <option value="">Loading...</option>}
                  {getModels(aiProvider, ollamaCompletionModel, ollamaModels).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                {selectedTool && (
                  <>
                    <div className="w-px h-6 bg-gray-200" />
                    <MCPHealthIndicator status={selectedTool.ready ? 'ready' : 'not_ready'} />
                    <h3 className="text-base font-semibold text-gray-900">{selectedTool.displayName}</h3>
                    <MCPCategoryBadge category={selectedTool.category} />
                  </>
                )}
                {!selectedTool && (
                  <>
                    <div className="w-px h-6 bg-gray-200" />
                    <span className="text-sm text-gray-400">Select a tool from the sidebar</span>
                  </>
                )}
              </div>
            )}

            {/* Right side — new chat + toggles + embedding badge */}
            <div className="ml-auto flex items-center gap-3">
              {mode === 'ai' && (
                <div className="flex items-center gap-4">
                  {hasConversation && (
                    <button type="button" onClick={handleNewChat}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                      title="Start new conversation"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      New Chat
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-gray-500">Deep</label>
                    <button type="button" onClick={() => {
                      const newDeep = !deepSearchMode;
                      setDeepSearchMode(newDeep);
                      if (newDeep) setCompareMode(false);
                      router.push(getAiUrl(newDeep, false), { scroll: false });
                    }}
                      className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${deepSearchMode ? 'bg-indigo-600' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${deepSearchMode ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-gray-500">Compare</label>
                    <button type="button" onClick={() => {
                      const newCompare = !compareMode;
                      setCompareMode(newCompare);
                      if (newCompare) setDeepSearchMode(false);
                      router.push(getAiUrl(false, newCompare), { scroll: false });
                    }}
                      className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${compareMode ? 'bg-blue-600' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${compareMode ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-gray-500">Thinking</label>
                    <button type="button" onClick={() => setThinkingMode(!thinkingMode)}
                      className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${thinkingMode ? 'bg-purple-600' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${thinkingMode ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2" title="Multi-Pass: outline first, then stream each findings subsection as its own LLM call. Avoids mid-report truncation and improves quality on long answers.">
                    <label className="text-xs font-medium text-gray-500">Multi-Pass</label>
                    <button type="button" onClick={() => setMultiPass(!multiPass)}
                      className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${multiPass ? 'bg-emerald-600' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${multiPass ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-gray-500">Tokens</label>
                    <select
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(Number(e.target.value))}
                      className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    >
                      <option value={512}>512</option>
                      <option value={1024}>1k</option>
                      <option value={2048}>2k</option>
                      <option value={4096}>4k</option>
                      <option value={8192}>8k</option>
                      <option value={16384}>16k</option>
                      <option value={32768}>32k</option>
                    </select>
                  </div>
                  {aiProvider === 'anthropic' && aiModel === 'claude-opus-4-7' && thinkingMode && (
                    <div className="flex items-center gap-2" title="Adaptive-thinking effort. Lower = more visible response, higher = deeper reasoning.">
                      <label className="text-xs font-medium text-gray-500">Effort</label>
                      <select
                        value={effort}
                        onChange={(e) => setEffort(e.target.value as 'low' | 'medium' | 'high' | 'xhigh' | 'max')}
                        className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-purple-400"
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">xHigh</option>
                        <option value="max">Max</option>
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Content */}
        <main
          className={`flex-1 bg-gray-50 ${mode === 'analysis' ? 'flex overflow-hidden' : ''} ${mode === 'ai' ? `relative flex ${haystackMode ? 'flex-row' : 'flex-col'} overflow-hidden` : ''} ${mode === 'direct' ? 'overflow-auto' : ''}`}
          onDragEnter={mode === 'ai' ? handleDragEnter : undefined}
          onDragOver={mode === 'ai' ? handleDragOver : undefined}
          onDragLeave={mode === 'ai' ? handleDragLeave : undefined}
          onDrop={mode === 'ai' ? handleDrop : undefined}
        >

          {/* ---- AI Search Mode — Chat Layout ---- */}
          {/* When haystackMode is on, the outer container is flex-row and the
              sample-query rail renders to the left of the chat column. When
              off, the outer is flex-col (legacy single-column) and no rail.
              The chat column itself is always flex-col with the scrollable
              conversation + fixed input. */}
          {mode === 'ai' && haystackMode && (
            <div className="flex flex-col min-w-0 gap-2">
              {activeToken ? (
                <ActiveTokenSuggestions
                  active={activeToken}
                  highlight={pickerHighlight}
                  onPick={handlePickActiveToken}
                  onOptionsChange={setPickerOptions}
                  onHighlightReset={() => setPickerHighlight(0)}
                />
              ) : (
                <SampleQueryPanel
                  onSelectQuery={handleSampleQuery}
                  onSelectToken={handleSampleToken}
                />
              )}
              {tokenSuggestions.length > 0 && (
                <TokenNameSuggestions
                  suggestions={tokenSuggestions}
                  highlight={tokenSuggestionHighlight}
                  onPick={(tok) => haystackInputRef.current?.completeToken(tok)}
                />
              )}
            </div>
          )}
          {mode === 'ai' && (
            <div className={haystackMode ? 'flex-1 flex flex-col overflow-hidden min-w-0' : 'contents'}>
              {isDraggingFiles && (
                <div className="absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-blue-500/10 border-4 border-dashed border-blue-400 rounded-lg">
                  <div className="bg-white px-6 py-4 rounded-lg shadow-lg border border-blue-200">
                    <div className="text-blue-700 font-medium">Drop PDFs or images to add to this chat</div>
                    <div className="text-xs text-blue-500 mt-1">PDF, PNG, JPG · indexed into this chat&apos;s search</div>
                  </div>
                </div>
              )}
              {uploadingCount > 0 && (
                <div className="absolute top-2 right-2 z-20 bg-blue-600 text-white text-xs px-2 py-1 rounded shadow">
                  Uploading {uploadingCount} file{uploadingCount === 1 ? '' : 's'}…
                </div>
              )}
              {/* Compare provider selection — shown above conversation when in compare mode */}
              {compareMode && (
                <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3">
                  <label className="block text-xs font-medium text-gray-500 mb-2">Select Providers &amp; Models to Compare</label>
                  <div className="flex flex-wrap gap-2">
                    {PROVIDERS.map(p => {
                      const configured = configuredProviders[p.key];
                      const selected = compareSelections.has(p.key);
                      const selectedModelId = compareSelections.get(p.key) ?? '';
                      const models = getModels(p.key, ollamaCompletionModel, ollamaModels);
                      return (
                        <div key={p.key} className={`inline-flex items-center gap-2 border rounded-lg px-3 py-1.5 transition-colors ${
                          !configured ? 'bg-gray-50 border-gray-200 opacity-50' :
                          selected ? 'border-blue-300 bg-blue-50' : 'border-gray-200'
                        }`}>
                          <input type="checkbox" checked={selected} disabled={!configured}
                            onChange={() => toggleCompareProvider(p.key)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                          <span className="text-sm font-medium text-gray-700">{p.name}</span>
                          {!configured && <span className="text-[10px] text-gray-400">No key</span>}
                          {configured && selected && (
                            <select value={selectedModelId} onChange={e => setCompareModel(p.key, e.target.value)}
                              className="px-2 py-0.5 border border-gray-300 rounded text-xs bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            >
                              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Scrollable conversation area */}
              <div ref={chatScrollRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto px-6 py-6 relative">
                <div className="max-w-3xl mx-auto space-y-4">
                  {/* Empty state — shown when no conversation */}
                  {!hasConversation && !aiLoading && !aiError && (
                    <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center">
                      <svg className="w-16 h-16 text-gray-200 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                      </svg>
                      <h3 className="text-lg font-medium text-gray-400 mb-1">Ask Your Legal Documents</h3>
                      <p className="text-sm text-gray-400">
                        {deepSearchMode ? 'Deep Search analyzes your question with multiple sub-queries for comprehensive answers.' :
                         compareMode ? 'Compare answers from multiple AI providers side by side.' :
                         'Ask a question and get AI-powered answers grounded in your case materials.'}
                      </p>
                      <kbd className="mt-4 inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-200 bg-gray-50 text-xs text-gray-400 font-mono">
                        <span className="text-[10px]">&#8984;</span>K
                      </kbd>
                    </div>
                  )}

                  {/* Regular AI conversation turns */}
                  {!deepSearchMode && !compareMode && aiTurns.map((turn, i) => (
                    <div key={i} className="space-y-3">
                      {/* User bubble */}
                      <div className="flex items-start gap-2 group/turn">
                        <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-0.5">
                          <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                          </svg>
                        </div>
                        <div className="bg-gray-100 rounded-lg px-4 py-2.5 max-w-[80%]">
                          <p className="text-sm text-gray-800">{turn.query}</p>
                        </div>
                        <button
                          onClick={() => setAiTurns(prev => prev.filter((_, idx) => idx !== i))}
                          className="opacity-0 group-hover/turn:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 shrink-0 mt-0.5"
                          title="Delete this turn"
                        >
                          <svg className="w-3.5 h-3.5 text-red-400 hover:text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </button>
                      </div>
                      {/* AI response */}
                      <AIResultCard result={turn.result} searchTime={turn.searchTime} />
                    </div>
                  ))}

                  {/* Deep search conversation turns */}
                  {deepSearchMode && deepTurns.map((turn, i) => (
                    <div key={i} className="space-y-3">
                      {/* User bubble */}
                      <div className="flex items-start gap-2 group/turn">
                        <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-0.5">
                          <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                          </svg>
                        </div>
                        <div className="bg-gray-100 rounded-lg px-4 py-2.5 max-w-[80%]">
                          <p className="text-sm text-gray-800">{turn.query}</p>
                        </div>
                        <button
                          onClick={() => setDeepTurns(prev => prev.filter((_, idx) => idx !== i))}
                          className="opacity-0 group-hover/turn:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 shrink-0 mt-0.5"
                          title="Delete this turn"
                        >
                          <svg className="w-3.5 h-3.5 text-red-400 hover:text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </button>
                      </div>
                      <DeepSearchResultCard result={turn.result} searchTime={turn.searchTime} />
                    </div>
                  ))}

                  {/* Compare mode results */}
                  {compareMode && aiResults.length > 0 && (
                    <>
                      {/* User bubble for the query */}
                      {aiTurns.length > 0 && (
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-0.5">
                            <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                          </div>
                          <div className="bg-gray-100 rounded-lg px-4 py-2.5 max-w-[80%]">
                            <p className="text-sm text-gray-800">{aiTurns[0]?.query}</p>
                          </div>
                        </div>
                      )}
                      {/* Comparison banner */}
                      <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3">
                        <p className="text-xs font-medium text-indigo-600 mb-2">Comparing</p>
                        <div className="flex flex-wrap gap-2">
                          {aiResults.map((r, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium bg-white border border-indigo-200 text-indigo-800 shadow-sm">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'][i % 4] }} />
                              {getProviderName(r.provider)}: {getModelLabel(r.provider, r.model)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className={`grid gap-4 ${aiResults.length === 1 ? 'grid-cols-1' : aiResults.length === 2 ? 'grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
                        {aiResults.map((result, i) => <AIResultCard key={i} result={result} compact colorIndex={i} />)}
                      </div>
                    </>
                  )}

                  {/* Deep Search Progress — sticky so it stays visible while
                      the streaming answer card grows below it. Without sticky,
                      stick-to-bottom pins the user to the answer tail and the
                      progress card scrolls off-screen, hiding stage info. */}
                  {aiLoading && !aiStopping && deepSearchMode && deepProgress && (
                    <div className="sticky top-0 z-10 -mx-6 px-6 py-1 bg-gray-50/95 backdrop-blur-sm">
                      <DeepSearchProgressCard progress={deepProgress} startTime={searchStartTime || Date.now()} tokenCount={streamTokenCount} />
                    </div>
                  )}
                  {!aiStopping && searchWarnings.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-1">
                      <p className="text-xs font-medium text-amber-900">Warnings</p>
                      {searchWarnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-800 flex items-start gap-2">
                          {w.count && w.count > 1 && (
                            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-200 text-amber-900 text-[10px] font-semibold shrink-0">
                              ×{w.count}
                            </span>
                          )}
                          <span>
                            <span className="font-medium">{w.source}{w.host ? ` (${w.host})` : ''}:</span> {w.message}
                          </span>
                        </p>
                      ))}
                    </div>
                  )}

                  {/* Thinking log for regular AI search */}
                  {!deepSearchMode && !aiStopping && (aiLoading || aiProgressLog.length > 0) && (
                    <AIThinkingLog
                      entries={aiProgressLog}
                      expanded={thinkingExpanded}
                      onToggle={() => setThinkingExpanded(e => !e)}
                      startTime={searchStartTime}
                      loading={aiLoading}
                    />
                  )}

                  {/* Streaming answer (shows while tokens arrive, before final result) */}
                  {streamingAnswer !== null && aiLoading && !aiStopping && (
                    <div className={`bg-white rounded-lg shadow-sm border p-4 ${deepSearchMode ? 'border-indigo-200' : 'border-purple-200'}`}>
                      {deepSearchMode && (
                        <p className="text-xs font-medium text-indigo-700 mb-2">Streaming research report…</p>
                      )}
                      <div className="prose prose-sm max-w-none text-gray-800">
                        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{streamingAnswer}</ReactMarkdown>
                      </div>
                      <span className={`inline-block w-1.5 h-4 animate-pulse ml-0.5 rounded-sm ${deepSearchMode ? 'bg-indigo-400' : 'bg-purple-400'}`} />
                    </div>
                  )}

                  {/* AI Error */}
                  {aiError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <p className="text-red-800 text-sm">{aiError}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Jump-to-latest pill — appears when user is scrolled up while new content arrives below */}
              {hasNewContentBelow && aiLoading && (
                <button
                  type="button"
                  onClick={() => scrollChatToBottom({ force: true })}
                  className="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--input-h,80px)+12px)] z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-600 text-white text-xs font-medium shadow-lg hover:bg-indigo-700 transition-colors"
                  style={{ bottom: `calc(${inputHeight}px + 24px)` }}
                  title="Jump to latest"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                  </svg>
                  New content
                </button>
              )}

              {/* Per-chat attachments strip — appears above the input */}
              <ChatAttachmentsStrip chatId={currentSessionId} refreshKey={attachmentsRefreshKey} />

              {/* Fixed bottom input with drag-resizable top edge */}
              <div className="flex-shrink-0 bg-white">
                {/* Drag handle — matches sidebar ResizableDivider pattern */}
                <div
                  className="h-1 cursor-ns-resize hover:bg-blue-400 active:bg-blue-500 transition-colors border-t border-gray-200"
                  onMouseDown={e => {
                    e.preventDefault();
                    const startY = e.clientY;
                    const startH = inputHeight;
                    document.body.style.cursor = 'ns-resize';
                    document.body.style.userSelect = 'none';
                    const onMove = (ev: MouseEvent) => {
                      const delta = startY - ev.clientY;
                      setInputHeight(Math.max(48, Math.min(window.innerHeight * 0.5, startH + delta)));
                    };
                    const onUp = () => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                      document.body.style.cursor = '';
                      document.body.style.userSelect = '';
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                  title="Drag to resize input area"
                />
                <div className="px-6 py-4">
                <div className="max-w-3xl mx-auto">
                  <form onSubmit={e => {
                    if (haystackMode && (haystackChips.length > 0 || /\w+:/.test(aiQuery))) {
                      e.preventDefault();
                      void runHaystackSearch();
                      return;
                    }
                    handleAISearch(e);
                  }} className="flex items-end gap-3">
                    {haystackMode ? (
                      <HaystackFilterInput
                        ref={haystackInputRef}
                        chips={haystackChips}
                        onChipsChange={setHaystackChips}
                        freetext={aiQuery}
                        onFreetextChange={setAiQuery}
                        onSubmit={() => {
                          if (haystackChips.length > 0) {
                            void runHaystackSearch();
                          } else if (aiQuery.trim() && !aiLoading) {
                            handleAISearch(new Event('submit') as unknown as React.FormEvent);
                          }
                        }}
                        placeholder={hasConversation ? 'Ask a follow-up… (try judge: hearingDate:)' : 'Filter or ask… (try judge: hearingDate: motionType:)'}
                        disabled={aiLoading || haystackBusy}
                        className="flex-1"
                        style={{ minHeight: inputHeight }}
                        onActiveTokenChange={setActiveToken}
                        pickerOptions={pickerOptions}
                        pickerHighlight={pickerHighlight}
                        onPickerHighlightChange={setPickerHighlight}
                        onTokenSuggestionsChange={setTokenSuggestions}
                        onTokenHighlightChange={setTokenSuggestionHighlight}
                      />
                    ) : (
                      <textarea
                        id="ai-query"
                        ref={aiQueryRef}
                        value={aiQuery}
                        onChange={e => setAiQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (aiQuery.trim() && !aiLoading) {
                              handleAISearch(e as unknown as React.FormEvent);
                            }
                          }
                        }}
                        placeholder={hasConversation ? 'Ask a follow-up...' : 'Ask a question about your legal documents...'}
                        className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none overflow-y-auto"
                        style={{ height: inputHeight }}
                      />
                    )}
                    {aiLoading ? (
                      <button
                        type="button"
                        onClick={handleStopAI}
                        disabled={aiStopping}
                        className="px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:bg-red-400 disabled:cursor-wait transition-colors whitespace-nowrap inline-flex items-center gap-2"
                      >
                        <span className="inline-block w-2.5 h-2.5 bg-white rounded-sm" />
                        {aiStopping ? 'Stopping…' : 'Stop'}
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!aiQuery.trim()}
                        className="px-5 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                      >
                        {compareMode ? 'Compare' : deepSearchMode ? 'Deep Search' : 'Ask AI'}
                      </button>
                    )}
                  </form>
                  <div className="flex items-center justify-center gap-3 mt-1.5 flex-wrap">
                    <label className="inline-flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={haystackMode}
                        onChange={e => setHaystackMode(e.target.checked)}
                        className="w-3 h-3"
                      />
                      Use Haystack filters
                    </label>
                    {haystackMode && haystackChips.length > 0 && (
                      <span
                        className="text-[10px] font-mono text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded max-w-md truncate"
                        title={buildHaystackFilter(haystackChips, aiQuery).filter}
                      >
                        {buildHaystackFilter(haystackChips, aiQuery).filter || '(empty)'}
                      </span>
                    )}
                    {haystackPreview && (
                      <span className="text-[10px] text-gray-500">
                        {haystackPreview.haystackCount !== undefined
                          ? `${haystackPreview.haystackCount} record${haystackPreview.haystackCount === 1 ? '' : 's'}`
                          : ''}
                        {haystackPreview.note ? ` · ${haystackPreview.note}` : ''}
                      </span>
                    )}
                    <p className="text-[10px] text-gray-400">
                      Enter to send, Shift+Enter for new line
                    </p>
                    {embeddingInfo && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-gray-400" title={`Embedding: ${formatEmbeddingLabel(embeddingInfo)}`}>
                        <span className="w-1 h-1 rounded-full bg-green-500" />
                        Embedding: {formatEmbeddingLabel(embeddingInfo)}
                      </span>
                    )}
                  </div>
                </div>
                </div>
              </div>
            </div>
          )}

          {/* ---- Direct Search Mode ---- */}
          {mode === 'direct' && (
          <div className="p-6 space-y-6 w-full">
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <form onSubmit={handleDirectSearch} className="space-y-4">
                    {/* Query */}
                    <div>
                      <label htmlFor="direct-query" className="block text-sm font-medium text-gray-700 mb-2">
                        {directMode === 'semantic' ? 'Search Query' : 'Regex Pattern'}
                      </label>
                      <input id="direct-query" ref={directQueryRef} type="text" value={directQuery} onChange={e => setDirectQuery(e.target.value)}
                        placeholder={directMode === 'semantic' ? 'e.g., "What evidence was presented?"' : 'e.g., "\\d{4}-\\d{2}-\\d{2}" for dates'}
                        className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>

                    {/* Case Filter */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Filter by Case</label>
                      <SearchableCombo
                        value={caseIdToName.get(directCaseId) || ''}
                        onChange={name => setDirectCaseId(caseNameToId.get(name) || '')}
                        options={['All Cases', ...caseOptions]}
                        placeholder="All Cases"
                      />
                    </div>

                    <button type="submit" disabled={directLoading}
                      className="w-full bg-blue-600 text-white py-2 px-4 rounded-md font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {directLoading ? 'Searching...' : 'Search'}
                    </button>
                  </form>
                </div>

                {/* Direct Error */}
                {directError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-red-800 text-sm">{directError}</p>
                  </div>
                )}

                {/* Direct Results */}
                {directResults.length > 0 && (
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                    <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                      <h2 className="text-lg font-semibold text-gray-900">
                        Results ({directResults.length})
                        {directSearchTime !== null && (
                          <span className="ml-2 text-sm font-normal text-gray-400">in {directSearchTime}ms</span>
                        )}
                      </h2>
                    </div>
                    <div className="divide-y divide-gray-200">
                      {directResults.map((result, index) => (
                        <div key={index} onClick={() => setSelectedResult(selectedResult === index ? null : index)}
                          className={`p-4 cursor-pointer transition-colors ${selectedResult === index ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1">
                              <h3 className="font-medium text-gray-900 text-sm">{result.document}</h3>
                              <p className="text-xs text-gray-500 mt-1">
                                Page {result.page}
                                {result.score !== undefined && <span className="ml-2">Similarity: {(result.score * 100).toFixed(1)}%</span>}
                              </p>
                            </div>
                            <CopyButton text={result.text} />
                          </div>
                          <div className={`text-sm text-gray-700 mt-2 ${selectedResult === index ? '' : 'line-clamp-2'}`}>
                            {result.match ? (
                              <span>Match: <span className="bg-yellow-200 px-1 rounded">{result.match}</span></span>
                            ) : (
                              <span>{result.text}</span>
                            )}
                          </div>
                          {selectedResult === index && (
                            <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                              <p className="text-xs font-medium text-gray-700 mb-2">Full Context:</p>
                              <p className="text-sm text-gray-800 whitespace-pre-wrap">{result.text}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* No Direct Results */}
                {!directLoading && !directError && directResults.length === 0 && directQuery && (
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
                    <p className="text-gray-500">No results found</p>
                    <p className="text-sm text-gray-400 mt-2">Try adjusting your query or changing the search mode</p>
                  </div>
                )}

                {/* Empty state */}
                {!directLoading && !directError && directResults.length === 0 && !directQuery && (
                  <EmptyState mode="direct" />
                )}
          </div>
          )}

          {/* ---- Analysis Tools Mode ---- */}
          {mode === 'analysis' && (
            selectedTool ? (
              <div className="flex-1 overflow-auto p-6">
                <div className="max-w-4xl mx-auto space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-500">{selectedTool.description}</p>
                    <a
                      href={`/workflow?template=${selectedTool.name.replace(/_/g, '-')}`}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap ml-4 flex items-center gap-1"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Create Workflow
                    </a>
                  </div>

                  {/* Parameter form */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <MCPParamForm
                      inputSchema={selectedTool.inputSchema}
                      cases={cases}
                      documents={documents}
                      onExecute={handleToolExecute}
                      loading={toolLoading}
                    />
                  </div>

                  {/* Tool result */}
                  {toolResult && (
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                      {toolResult.error ? (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                          <p className="text-sm font-medium text-red-800">Error</p>
                          <p className="text-sm text-red-700 mt-1">{toolResult.error}</p>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between mb-4">
                            <span className="text-sm text-gray-500">
                              {toolResult.resultCount} result{toolResult.resultCount !== 1 ? 's' : ''} in {Math.round(toolResult.executionTimeMs)}ms
                            </span>
                            <CopyButton text={JSON.stringify(toolResult.data, null, 2)} />
                          </div>
                          <MCPResultRenderer
                            toolName={toolResult.toolName}
                            data={toolResult.data}
                            executionTimeMs={toolResult.executionTimeMs}
                            resultCount={toolResult.resultCount}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto flex items-center justify-center">
                <div className="text-center py-16">
                  <svg className="w-16 h-16 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                  <h3 className="text-lg font-medium text-gray-400 mb-1">Select a Tool</h3>
                  <p className="text-sm text-gray-400">Choose an analysis tool from the sidebar to get started</p>
                </div>
              </div>
            )
          )}
        </main>
      </div>

      <ResizableDivider side="right" onResizeStart={startResize} />

      {/* ================================================================= */}
      {/* RIGHT SIDEBAR — Docs & Bookmarks (always visible) */}
      {/* ================================================================= */}
      <aside className="flex-shrink-0 border-l border-gray-200 bg-white flex flex-col overflow-hidden" style={{ width: columnWidths.right }}>
        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          {(['workflows', 'history', 'bookmarks', 'docs'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setInfoTab(tab)}
              className={`flex-1 px-2 py-2.5 text-[11px] font-medium transition-colors ${
                infoTab === tab
                  ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab === 'workflows' ? 'Workflows' : tab === 'history' ? 'History' : tab === 'bookmarks' ? 'Bookmarks' : 'Docs'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {infoTab === 'workflows' && (
            <WorkflowsPanel
              caseId={aiCaseId}
              selectedWorkflowIds={selectedWorkflowIds}
              onSelectionChange={setSelectedWorkflowIds}
            />
          )}
          {infoTab === 'history' && (
            <HistoryPanel
              currentSessionId={currentSessionId}
              onLoadSession={loadSession}
            />
          )}
          {infoTab === 'bookmarks' && (
            <div className="p-4 text-center py-12">
              <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
              </svg>
              <p className="text-sm text-gray-400 font-medium">No bookmarks yet</p>
              <p className="text-xs text-gray-400 mt-1">Saved presets will appear here</p>
            </div>
          )}
          {infoTab === 'docs' && (
            mode === 'analysis' && selectedTool
              ? <ToolDocsPanel tool={selectedTool} />
              : <SearchDocsPanel mode={mode} embeddingInfo={embeddingInfo} directMode={directMode} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Docs Panel
// ---------------------------------------------------------------------------

function ToolDocsPanel({ tool }: { tool: ToolInfo }) {
  const params = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];

  return (
    <div className="p-4 space-y-4">
      {/* Description */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">About</h4>
        <p className="text-sm text-gray-700 leading-relaxed">{tool.description}</p>
      </div>

      {/* Metadata */}
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
          v{tool.version}
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
          {tool.category}
        </span>
        {tool.totalExecutions > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
            {tool.totalExecutions} runs
          </span>
        )}
      </div>

      {/* Parameters */}
      {Object.keys(params).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Parameters</h4>
          <div className="space-y-3">
            {Object.entries(params).map(([name, schema]: [string, any]) => {
              const isRequired = required.includes(name);
              return (
                <div key={name} className="bg-gray-50 rounded-md p-2.5">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <code className="text-xs font-mono font-semibold text-gray-800">{name}</code>
                    <span className="text-[10px] text-gray-400">{schema.type || 'string'}</span>
                    {isRequired && (
                      <span className="text-[10px] font-medium text-red-500">required</span>
                    )}
                  </div>
                  {schema.description && (
                    <p className="text-[11px] text-gray-600 leading-relaxed">{schema.description}</p>
                  )}
                  {schema.enum && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {schema.enum.map((v: string) => (
                        <code key={v} className="text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">{v}</code>
                      ))}
                    </div>
                  )}
                  {schema.default !== undefined && (
                    <p className="text-[10px] text-gray-400 mt-1">Default: <code className="bg-white border border-gray-200 rounded px-1 py-0.5">{String(schema.default)}</code></p>
                  )}
                  {schema.examples && (
                    <div className="mt-1.5">
                      <p className="text-[10px] text-gray-400 mb-0.5">Examples:</p>
                      {schema.examples.map((ex: string, i: number) => (
                        <code key={i} className="block text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600 mt-0.5">{ex}</code>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Ready status */}
      {!tool.ready && tool.readyReasons.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-2.5">
          <p className="text-xs font-medium text-amber-800 mb-1">Not Ready</p>
          {tool.readyReasons.map((r, i) => (
            <p key={i} className="text-[11px] text-amber-700">{r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search Docs Panel — contextual help for AI / Direct / Analysis (no tool)
// ---------------------------------------------------------------------------

function SearchDocsPanel({ mode, embeddingInfo, directMode }: { mode: SearchMode; embeddingInfo?: EmbeddingInfo; directMode?: DirectSubMode }) {
  if (mode === 'ai') {
    return (
      <div className="p-4 space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">How AI Search Works</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            AI Search uses Retrieval-Augmented Generation (RAG). It finds the most relevant passages
            in your documents using vector similarity, then sends them as context to the selected AI
            model to generate an answer grounded in your actual case materials.
          </p>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Tips</h4>
          <ul className="space-y-1.5">
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Ask specific questions for more precise answers
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Filter by case to narrow the search scope
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Use Compare Mode to see how different models answer the same question
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Check the Sources section to verify the AI&apos;s answer against original documents
            </li>
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Compare Mode</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Enable Compare Mode to send the same question to multiple AI providers simultaneously.
            Useful for cross-referencing answers and finding the most accurate response.
          </p>
        </div>

        {embeddingInfo && (
          <div className="bg-gray-50 rounded-md p-2.5">
            <p className="text-[10px] text-gray-400 mb-0.5">Embedding Provider</p>
            <p className="text-xs text-gray-700 font-medium">{formatEmbeddingLabel(embeddingInfo)}</p>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'direct') {
    return (
      <div className="p-4 space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Semantic Search</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Uses AI embeddings to find passages that are similar in meaning to your query,
            even when the exact words differ. Best for natural language questions.
          </p>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pattern Search</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Uses regex patterns for exact text matching across all indexed documents.
          </p>
          <div className="mt-2 space-y-1">
            <p className="text-[10px] text-gray-400 font-medium">Common Patterns</p>
            <div className="space-y-1">
              <code className="block text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                \d{'{4}'}-\d{'{2}'}-\d{'{2}'} &mdash; dates
              </code>
              <code className="block text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                \$[\d,]+\.?\d* &mdash; dollar amounts
              </code>
              <code className="block text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                Exhibit\s+[A-Z0-9]+ &mdash; exhibit references
              </code>
            </div>
          </div>
        </div>

        {embeddingInfo && (
          <div className="bg-gray-50 rounded-md p-2.5">
            <p className="text-[10px] text-gray-400 mb-0.5">Embedding Provider</p>
            <p className="text-xs text-gray-700 font-medium">{formatEmbeddingLabel(embeddingInfo)}</p>
          </div>
        )}
      </div>
    );
  }

  // analysis mode with no tool selected
  return (
    <div className="p-4 space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Analysis Tools</h4>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          Select a tool from the sidebar to analyze your legal documents with specialized AI-powered capabilities.
        </p>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Categories</h4>
        <ul className="space-y-1.5">
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-blue-400 shrink-0 font-bold">S</span>
            Search &mdash; advanced document search and retrieval
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-red-400 shrink-0 font-bold">C</span>
            Contradiction &mdash; detect conflicting statements
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-purple-400 shrink-0 font-bold">A</span>
            Argument &mdash; map legal arguments and reasoning
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-green-400 shrink-0 font-bold">T</span>
            Timeline &mdash; extract and order events chronologically
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-amber-400 shrink-0 font-bold">E</span>
            Entity &mdash; identify people, organizations, and relationships
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-gray-400 shrink-0 font-bold">R</span>
            Review &mdash; document review and summarization
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState({ mode }: { mode: 'ai' | 'direct' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <svg className="w-16 h-16 text-gray-200 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
      <h3 className="text-lg font-medium text-gray-400 mb-1">Search Your Documents</h3>
      <p className="text-sm text-gray-400">
        {mode === 'ai' ? 'Ask a question and get AI-powered answers from your legal documents.' : 'Search for keywords, phrases, or patterns across all indexed documents.'}
      </p>
      <kbd className="mt-4 inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-200 bg-gray-50 text-xs text-gray-400 font-mono">
        <span className="text-[10px]">&#8984;</span>K
      </kbd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Result Card
// ---------------------------------------------------------------------------

const AIResultCard = React.memo(function AIResultCard({ result, compact = false, colorIndex, searchTime }: { result: AISearchResult; compact?: boolean; colorIndex?: number; searchTime?: number | null }) {
  const [showSources, setShowSources] = useState(false);
  const [showWorkflowSave, setShowWorkflowSave] = useState(false);
  const [workflows, setWorkflows] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [savingToWorkflow, setSavingToWorkflow] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const color = colorIndex !== undefined ? COMPARE_COLORS[colorIndex % COMPARE_COLORS.length] : null;

  const handleSaveToWorkflow = async () => {
    if (!selectedWorkflowId || result.sources.length === 0) return;
    setSavingToWorkflow(true);
    try {
      const citations = result.sources.map(s => ({
        text: s.text,
        citation: s.citation || `${s.document}, p.${s.page}`,
        citationShort: s.citationShort || `p.${s.page}`,
        page: s.page,
        document: s.document,
        filingType: s.filingType,
      }));
      const res = await fetch(`/api/workflows/${selectedWorkflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ citations }),
      });
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch { /* ignore */ }
    finally { setSavingToWorkflow(false); }
  };

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 ${color ? `border-t-4 ${color.border}` : ''}`}>
      <div className={`flex items-center justify-between px-4 py-3 border-b border-gray-200 ${color ? color.bg : 'bg-gray-50'}`}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">{getProviderName(result.provider)}</span>
          <span className="text-xs bg-white/60 px-1.5 py-0.5 rounded text-gray-600 font-mono">{getModelLabel(result.provider, result.model)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>{result.usage.inputTokens + result.usage.outputTokens} tokens</span>
          {searchTime !== null && searchTime !== undefined && <span>in {searchTime}ms</span>}
          <CopyButton text={result.answer} />
        </div>
      </div>
      <div className={`px-4 py-4 ${compact ? 'max-h-80 overflow-y-auto' : ''}`}>
        <div className="prose prose-sm max-w-none text-gray-800">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{result.answer}</ReactMarkdown>
          </div>
      </div>
      {result.sources.length > 0 && (
        <div className="border-t border-gray-200">
          <button onClick={() => setShowSources(!showSources)}
            className="w-full flex items-center justify-between px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            <span>Sources ({result.sources.length})</span>
            <svg className={`w-4 h-4 transition-transform ${showSources ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showSources && (
            <div className="px-4 pb-3 space-y-2">
              {result.sources.map((s, i) => {
                const explorerUrl = getExplorerUrl(s);
                return (
                <div key={i} className="text-xs border border-gray-100 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    {explorerUrl ? (
                      <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
                        className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        {s.citationShort || s.citation || `[${i + 1}] ${s.document}`}
                      </a>
                    ) : (
                      <span className="font-medium text-blue-700">
                        {s.citationShort || s.citation || `[${i + 1}] ${s.document}`}
                      </span>
                    )}
                    {!s.citation && <span className="text-gray-400">p.{s.page}</span>}
                    {s.filingType && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{s.filingType}</span>
                    )}
                    <span className="text-gray-400 ml-auto">{(s.score * 100).toFixed(0)}%</span>
                  </div>
                  <p className="text-[10px] text-gray-400 mb-1">{s.document}</p>
                  {s.annotations && (() => {
                    try {
                      const anns = JSON.parse(s.annotations) as Array<{ type: string; author?: string; comment?: string; coveredText?: string }>;
                      if (anns.length === 0) return null;
                      return (
                        <div className="flex flex-wrap gap-1 mb-1">
                          {anns.map((ann: any, j: number) => (
                            <span
                              key={j}
                              className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                                ann.type === 'strikeout' ? 'bg-red-50 text-red-700 line-through' :
                                ann.type === 'highlight' ? 'bg-yellow-50 text-yellow-800' :
                                ann.type === 'underline' ? 'bg-blue-50 text-blue-700 underline' :
                                ann.type === 'comment' ? 'bg-purple-50 text-purple-700' :
                                'bg-gray-50 text-gray-600'
                              }`}
                              title={[ann.author && `By: ${ann.author}`, ann.comment, ann.coveredText && `Text: "${ann.coveredText.slice(0, 100)}"`].filter(Boolean).join('\n')}
                            >
                              {ann.type === 'strikeout' ? 'Struck through' : ann.type === 'highlight' ? 'Highlighted' : ann.type === 'underline' ? 'Underlined' : ann.type === 'comment' ? 'Comment' : ann.type}
                              {ann.author && ` by ${ann.author}`}
                            </span>
                          ))}
                        </div>
                      );
                    } catch { return null; }
                  })()}
                  <p className="text-gray-500 line-clamp-2">{s.text}</p>
                </div>
                );
              })}

              {/* Save to Workflow */}
              <div className="pt-2 border-t border-gray-100">
                {!showWorkflowSave ? (
                  <button
                    onClick={() => {
                      setShowWorkflowSave(true);
                      // Fetch workflows for the first source's case (if available)
                      fetch('/api/cases')
                        .then(r => r.json())
                        .then(data => {
                          const cases = data.cases || [];
                          if (cases.length > 0) {
                            // Fetch workflows for all cases
                            Promise.all(
                              cases.map((c: any) =>
                                fetch(`/api/workflows?caseId=${c.id}`)
                                  .then(r => r.json())
                                  .then(d => (d.workflows || []).map((w: any) => ({ ...w, caseName: c.name })))
                              )
                            ).then(allWorkflows => {
                              setWorkflows(allWorkflows.flat());
                            });
                          }
                        })
                        .catch(() => {});
                    }}
                    className="text-xs text-purple-600 hover:text-purple-800 font-medium flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    Save Citations to Workflow
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedWorkflowId}
                      onChange={e => setSelectedWorkflowId(e.target.value)}
                      className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs bg-white"
                    >
                      <option value="">Select workflow...</option>
                      {workflows.map((w: any) => (
                        <option key={w.id} value={w.id}>{w.title}{w.caseName ? ` (${w.caseName})` : ''}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleSaveToWorkflow}
                      disabled={!selectedWorkflowId || savingToWorkflow}
                      className="px-2 py-1 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 disabled:bg-gray-300"
                    >
                      {savingToWorkflow ? '...' : saveSuccess ? 'Saved!' : 'Save'}
                    </button>
                    <button
                      onClick={() => setShowWorkflowSave(false)}
                      className="px-1.5 py-1 text-gray-400 hover:text-gray-600 text-xs"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Deep Search Progress Card
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<string, string> = {
  decomposing: 'Decomposing Query',
  searching: 'Searching Sub-Queries',
  pattern_searching: 'Pattern Search (Exact Matches)',
  merging: 'Deduplicating & Reranking',
  reranking: 'Reranking Results',
  generating: 'Generating Report',
  done: 'Complete',
};

const STEP_ORDER = ['decomposing', 'searching', 'pattern_searching', 'merging', 'generating', 'done'] as const;

function DeepSearchProgressCard({ progress, startTime, tokenCount }: { progress: DeepSearchProgress; startTime: number; tokenCount: number }) {
  const currentIdx = STEP_ORDER.indexOf(progress.step as typeof STEP_ORDER[number]);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 250);
    return () => clearInterval(id);
  }, [startTime]);
  const fmt = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-indigo-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2 bg-indigo-50 hover:bg-indigo-100 border-b border-indigo-200 flex items-center gap-2 text-left transition-colors"
        aria-expanded={expanded}
      >
        <svg className="w-3.5 h-3.5 text-indigo-600 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="text-xs font-medium text-indigo-700 shrink-0">{STEP_LABELS[progress.step] || progress.step}</span>
        <span className="text-xs text-gray-600 truncate flex-1 min-w-0">{progress.message}</span>
        <span className="flex items-center gap-2 text-[11px] text-indigo-600 font-mono tabular-nums shrink-0">
          <span title="Elapsed time">⏱ {fmt(elapsed)}</span>
          {tokenCount > 0 && <span title="Tokens received">{tokenCount.toLocaleString()}t</span>}
          {progress.subQueries && progress.subQueries.length > 0 && (
            <span title="Sub-queries">{progress.subQueries.length}q</span>
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-indigo-600 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
      <div className="px-4 py-4 space-y-3">
        {/* Step indicators */}
        <div className="flex items-center gap-1">
          {STEP_ORDER.filter(s => s !== 'done').map((step, i) => {
            const isDone = i < currentIdx;
            const isCurrent = step === progress.step;
            return (
              <div key={step} className="flex items-center gap-1 flex-1">
                <div className={`h-1.5 flex-1 rounded-full transition-colors ${
                  isDone ? 'bg-indigo-500' : isCurrent ? 'bg-indigo-300 animate-pulse' : 'bg-gray-200'
                }`} />
              </div>
            );
          })}
        </div>

        {/* Current step label + message */}
        <div>
          <p className="text-sm font-medium text-gray-900">{STEP_LABELS[progress.step] || progress.step}</p>
          <p className="text-xs text-gray-500 mt-0.5">{progress.message}</p>
        </div>

        {/* Sub-queries (shown once decomposition is done) */}
        {progress.subQueries && progress.subQueries.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-500">Sub-queries:</p>
            {progress.subQueries.map((sq, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-medium shrink-0">{i + 1}</span>
                <span className="text-gray-600">{sq}</span>
              </div>
            ))}
          </div>
        )}

        {/* Partial stats */}
        {progress.searchStats && (
          <div className="flex gap-4 text-[11px] text-gray-400">
            {progress.searchStats.totalRetrieved != null && <span>{progress.searchStats.totalRetrieved} chunks retrieved</span>}
            {progress.searchStats.uniqueAfterDedup != null && <span>{progress.searchStats.uniqueAfterDedup} unique</span>}
            {progress.searchStats.finalAfterRerank != null && <span>{progress.searchStats.finalAfterRerank} after rerank</span>}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deep Search Result Card
// ---------------------------------------------------------------------------

const DeepSearchResultCard = React.memo(function DeepSearchResultCard({ result, searchTime }: { result: DeepSearchResult; searchTime: number | null }) {
  const [showSubQueries, setShowSubQueries] = useState(false);
  const [showSources, setShowSources] = useState(false);

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
            <span className="text-sm font-medium text-indigo-700">Deep Search</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-indigo-600">
            <span>{result.searchStats.subQueryCount} sub-queries</span>
            <span>{result.searchStats.totalRetrieved} chunks retrieved</span>
            <span>{result.searchStats.uniqueAfterDedup} unique</span>
            <span>{result.searchStats.finalAfterRerank} after rerank</span>
            {searchTime !== null && <span>{searchTime}ms</span>}
          </div>
        </div>
      </div>

      {/* Sub-queries collapsible */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <button onClick={() => setShowSubQueries(!showSubQueries)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <span className="font-medium">Sub-Queries ({result.subQueries.length})</span>
          <svg className={`w-4 h-4 transition-transform ${showSubQueries ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showSubQueries && (
          <div className="px-4 pb-3 space-y-1.5">
            <p className="text-xs text-gray-400 mb-2">Intent: {result.intent}</p>
            {result.subQueries.map((sq, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-medium shrink-0">{i + 1}</span>
                <span className="text-gray-700">{sq}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Report */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">Research Report</span>
            <span className="text-xs bg-white/60 px-1.5 py-0.5 rounded text-gray-600 font-mono">{getProviderName(result.provider)}: {result.model}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                const blob = new Blob([result.report], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const w = window.open(url, '_blank');
                if (w) setTimeout(() => URL.revokeObjectURL(url), 60000);
              }}
              className="p-1.5 rounded hover:bg-gray-200 transition-colors"
              title="Open full report in new tab"
            >
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>
            <CopyButton text={result.report} />
          </div>
        </div>
        <div className="px-6 py-5">
          <div className="prose prose-sm max-w-none text-gray-800">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{result.report}</ReactMarkdown>
          </div>
        </div>
      </div>

      {/* Sources collapsible */}
      {result.sources.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <button onClick={() => setShowSources(!showSources)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <span className="font-medium">Sources ({result.sources.length})</span>
            <svg className={`w-4 h-4 transition-transform ${showSources ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showSources && (
            <div className="px-4 pb-3 space-y-2">
              {result.sources.map((s, i) => {
                const explorerUrl = getExplorerUrl(s);
                return (
                <div key={i} className="text-xs border border-gray-100 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    {explorerUrl ? (
                      <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
                        className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        {s.citationShort || s.citation || `[${i + 1}] ${s.document}`}
                      </a>
                    ) : (
                      <span className="font-medium text-blue-700">
                        {s.citationShort || s.citation || `[${i + 1}] ${s.document}`}
                      </span>
                    )}
                    {!s.citation && <span className="text-gray-400">p.{s.page}</span>}
                    {s.filingType && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{s.filingType}</span>
                    )}
                    <span className="text-gray-400 ml-auto">{(s.score * 100).toFixed(0)}%</span>
                  </div>
                  <p className="text-[10px] text-gray-400 mb-1">{s.document}</p>
                  {s.annotations && (() => {
                    try {
                      const anns = JSON.parse(s.annotations) as Array<{ type: string; author?: string; comment?: string; coveredText?: string }>;
                      if (anns.length === 0) return null;
                      return (
                        <div className="flex flex-wrap gap-1 mb-1">
                          {anns.map((ann: any, j: number) => (
                            <span
                              key={j}
                              className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                                ann.type === 'strikeout' ? 'bg-red-50 text-red-700 line-through' :
                                ann.type === 'highlight' ? 'bg-yellow-50 text-yellow-800' :
                                ann.type === 'underline' ? 'bg-blue-50 text-blue-700 underline' :
                                ann.type === 'comment' ? 'bg-purple-50 text-purple-700' :
                                'bg-gray-50 text-gray-600'
                              }`}
                              title={[ann.author && `By: ${ann.author}`, ann.comment, ann.coveredText && `Text: "${ann.coveredText.slice(0, 100)}"`].filter(Boolean).join('\n')}
                            >
                              {ann.type === 'strikeout' ? 'Struck through' : ann.type === 'highlight' ? 'Highlighted' : ann.type === 'underline' ? 'Underlined' : ann.type === 'comment' ? 'Comment' : ann.type}
                              {ann.author && ` by ${ann.author}`}
                            </span>
                          ))}
                        </div>
                      );
                    } catch { return null; }
                  })()}
                  <p className="text-gray-500 line-clamp-2">{s.text}</p>
                  {s.matchedSubQueries && s.matchedSubQueries.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.matchedSubQueries.map((sq, j) => (
                        <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{sq.length > 40 ? sq.slice(0, 40) + '...' : sq}</span>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
