'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useDraftStream } from '@/hooks/use-draft-stream';
import { AI_PROVIDERS, AI_PROVIDER_KEYS, type AIProviderKey, type AIModelDef } from '@/lib/ai/models';
import { AIThinkingLog, type AIProgressEntry } from '@/components/search/ai-thinking-log';
import DraftVersionHistory from '@/components/draft/draft-version-history';
import { usePersistedState } from '@/hooks/use-persisted-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  mode?: 'ai' | 'deep';
}

interface WorkflowTemplate {
  id: string;
  name: string;
  category?: string;
  description?: string;
}

interface DraftChatPanelProps {
  caseId: string;
  caseIds?: string[];
  documentContent: string;
  selectedText: string;
  hasSelection: boolean;
  onInsertText?: (text: string) => void;
  onReplaceSelection?: (text: string) => void;
  draftId?: string;
  currentVersion?: number;
  onDraftRestore?: () => void;
  onPreviewVersion?: (content: string | null) => void;
}

// ---------------------------------------------------------------------------
// Chat input height persistence (localStorage, same pattern as panel widths)
// ---------------------------------------------------------------------------

const LS_CHAT_INPUT_HEIGHT = 'draft-chat-input-height';
const CHAT_INPUT_MIN = 60;
const CHAT_INPUT_MAX = 300;
const CHAT_INPUT_DEFAULT = 100;

// ---------------------------------------------------------------------------
// Provider / model helpers
// ---------------------------------------------------------------------------

const PROVIDERS = AI_PROVIDER_KEYS.map(key => ({
  key,
  name: AI_PROVIDERS[key].name,
  models: AI_PROVIDERS[key].models,
}));

function getModels(
  providerKey: string,
  dynamicOllamaModels?: AIModelDef[] | null,
): AIModelDef[] {
  if (providerKey === 'ollama' && dynamicOllamaModels && dynamicOllamaModels.length > 0) {
    return dynamicOllamaModels;
  }
  return PROVIDERS.find(p => p.key === providerKey)?.models ?? [];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DraftChatPanel({
  caseId,
  caseIds,
  documentContent,
  selectedText,
  hasSelection,
  onInsertText,
  onReplaceSelection,
  draftId,
  currentVersion,
  onDraftRestore,
  onPreviewVersion,
}: DraftChatPanelProps) {
  // Tabs (persisted)
  const [activeTab, setActiveTab] = usePersistedState<'chat' | 'workflows' | 'history'>('draft.chat.activeTab', 'chat');

  // Chat input height (localStorage)
  const [chatInputHeight, setChatInputHeight] = useState(CHAT_INPUT_DEFAULT);
  const isResizingInput = useRef(false);

  useEffect(() => {
    try {
      const h = Number(localStorage.getItem(LS_CHAT_INPUT_HEIGHT));
      if (h >= CHAT_INPUT_MIN && h <= CHAT_INPUT_MAX) setChatInputHeight(h);
    } catch {}
  }, []);

  // Provider / model
  const [provider, setProvider] = usePersistedState<string>('draft.chat.provider', 'ollama');
  const [model, setModel] = usePersistedState<string>('draft.chat.model', '');

  // Ollama dynamic models
  const [ollamaModels, setOllamaModels] = useState<AIModelDef[] | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const ollamaFetchedRef = useRef(false);

  // Toggles
  const [deepSearch, setDeepSearch] = usePersistedState<boolean>('draft.chat.deepSearch', false);
  const [thinkingMode, setThinkingMode] = usePersistedState<boolean>('draft.chat.thinking', true);
  const [maxTokens, setMaxTokens] = usePersistedState<number>('draft.chat.maxTokens', 2048);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Thinking log
  const [progressLog, setProgressLog] = useState<AIProgressEntry[]>([]);
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [searchStartTime, setSearchStartTime] = useState(0);

  // Reindex
  const [reindexing, setReindexing] = useState(false);
  const [reindexProgress, setReindexProgress] = useState('');

  // Workflows
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');

  // Stream hook
  const { send, tokens, isStreaming, result, error, abort } = useDraftStream();

  // Deep search manual streaming state
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepStreamingAnswer, setDeepStreamingAnswer] = useState<string | null>(null);
  const [deepError, setDeepError] = useState<string | null>(null);
  const deepAbortRef = useRef<AbortController | null>(null);

  const isAnyStreaming = isStreaming || deepLoading;

  // ---------------------------------------------------------------------------
  // Fetch Ollama models
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (ollamaFetchedRef.current) return;
    ollamaFetchedRef.current = true;
    setOllamaModelsLoading(true);

    fetch('/api/ollama/models')
      .then(r => r.json())
      .then(data => {
        const fetched: AIModelDef[] = (data.models && data.models.length > 0)
          ? data.models.map((m: any) => ({ id: m.id, label: m.label || m.id }))
          : [];
        if (fetched.length > 0) setOllamaModels(fetched);

        // If current provider is ollama and no model set, default to first
        if (provider === 'ollama' && !model && fetched.length > 0) {
          const defaultModel = data.defaultModel || fetched[0]?.id;
          if (defaultModel) setModel(defaultModel);
        }
      })
      .catch(() => {})
      .finally(() => setOllamaModelsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Load workflow templates
  // ---------------------------------------------------------------------------

  useEffect(() => {
    fetch('/api/workflow-templates')
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : data.templates || [];
        setTemplates(list);
      })
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Scroll to bottom
  // ---------------------------------------------------------------------------

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tokens, deepStreamingAnswer]);

  // ---------------------------------------------------------------------------
  // When regular stream completes, add assistant message
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (result?.text) {
      setMessages(prev => [...prev, { role: 'assistant', content: result.text, mode: 'ai' }]);
      // Auto-collapse thinking log
      setTimeout(() => setThinkingExpanded(false), 300);
    }
  }, [result]);

  // ---------------------------------------------------------------------------
  // Provider change handler
  // ---------------------------------------------------------------------------

  const handleProviderChange = useCallback((key: string) => {
    setProvider(key);
    const models = getModels(key, ollamaModels);
    setModel(models[0]?.id ?? '');
  }, [ollamaModels, setProvider, setModel]);

  // ---------------------------------------------------------------------------
  // Persist chat session
  // ---------------------------------------------------------------------------

  const persistSession = useCallback((msgs: ChatMessage[], sid: string) => {
    const turns = msgs.map(m => ({ role: m.role, content: m.content, mode: m.mode }));
    if (turns.length === 0) return;

    fetch('/api/chat/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        mode: deepSearch ? 'deep' : 'ai',
        provider,
        model,
        caseId: caseId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstQuery: turns[0]?.content || '',
        turnCount: turns.length,
        turns,
      }),
    }).catch(() => {});
  }, [deepSearch, provider, model, caseId]);

  // ---------------------------------------------------------------------------
  // Deep search handler (manual NDJSON streaming)
  // ---------------------------------------------------------------------------

  const doDeepSearch = useCallback(async (query: string, history: Array<{ role: string; content: string }>) => {
    setDeepLoading(true);
    setDeepError(null);
    setProgressLog([]);
    setSearchStartTime(Date.now());
    setThinkingExpanded(true);
    setDeepStreamingAnswer(null);

    const controller = new AbortController();
    deepAbortRef.current = controller;

    try {
      // Prepend document context to the query
      let contextualQuery = query;
      if (hasSelection && selectedText) {
        contextualQuery = `[Selected text from document]: ${selectedText.slice(0, 4000)}\n\n${query}`;
      } else if (documentContent) {
        contextualQuery = `[Document context]: ${documentContent.slice(0, 8000)}\n\n${query}`;
      }

      const res = await fetch('/api/search/deep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: contextualQuery,
          provider,
          model,
          caseId: caseId || undefined,
          thinking: thinkingMode,
          maxTokens,
          ...(history.length > 0 ? { history } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Deep search failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let finalReport = '';

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
            if (event.type === 'progress') {
              setProgressLog(prev => [...prev, { ...event, timestamp: Date.now() }]);
            } else if (event.type === 'token') {
              setDeepStreamingAnswer(prev => (prev ?? '') + event.text);
            } else if (event.type === 'result') {
              finalReport = event.data?.report || event.data?.answer || JSON.stringify(event.data);
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
          if (event.type === 'result') {
            finalReport = event.data?.report || event.data?.answer || JSON.stringify(event.data);
          } else if (event.type === 'error') throw new Error(event.error);
        } catch { /* ignore */ }
      }

      setDeepStreamingAnswer(null);
      setTimeout(() => setThinkingExpanded(false), 300);

      if (finalReport) {
        setMessages(prev => [...prev, { role: 'assistant', content: finalReport, mode: 'deep' }]);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setDeepError(err.message || 'Deep search failed');
    } finally {
      setDeepLoading(false);
      deepAbortRef.current = null;
    }
  }, [provider, model, caseId, thinkingMode, maxTokens, hasSelection, selectedText, documentContent]);

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!input.trim() || isAnyStreaming) return;
    const query = input.trim();
    setInput('');

    // Generate session ID on first message
    const sid = sessionId || `draft-session-${Date.now()}`;
    if (!sessionId) setSessionId(sid);

    const userMsg: ChatMessage = { role: 'user', content: query, mode: deepSearch ? 'deep' : 'ai' };
    setMessages(prev => [...prev, userMsg]);

    const history = messages.map(m => ({ role: m.role, content: m.content }));

    if (deepSearch) {
      await doDeepSearch(query, history.slice(-10));
    } else {
      // Reset thinking log for regular stream
      setProgressLog([]);
      setSearchStartTime(Date.now());
      setThinkingExpanded(true);

      await send('/api/draft/chat', {
        query,
        caseIds: caseIds?.length ? caseIds : caseId ? [caseId] : undefined,
        documentContent: documentContent.slice(0, 12000),
        selectedText: hasSelection ? selectedText : undefined,
        history: history.slice(-10),
        provider,
        model,
        thinking: thinkingMode,
        maxTokens,
      });
    }

    // Persist session after the exchange
    const updatedMessages = [...messages, userMsg];
    // The assistant message gets added via useEffect, so defer persist
    setTimeout(() => {
      setMessages(current => {
        persistSession(current, sid);
        return current;
      });
    }, 500);
  }, [input, isAnyStreaming, sessionId, deepSearch, messages, caseId, documentContent, selectedText, hasSelection, provider, model, thinkingMode, maxTokens, send, doDeepSearch, persistSession]);

  // ---------------------------------------------------------------------------
  // New chat
  // ---------------------------------------------------------------------------

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setProgressLog([]);
    setDeepStreamingAnswer(null);
    setDeepError(null);
    setThinkingExpanded(true);
    setSearchStartTime(0);
  }, []);

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  const handleAbort = useCallback(() => {
    if (deepLoading && deepAbortRef.current) {
      deepAbortRef.current.abort();
      deepAbortRef.current = null;
      setDeepLoading(false);
    } else {
      abort();
    }
  }, [deepLoading, abort]);

  // ---------------------------------------------------------------------------
  // Reindex
  // ---------------------------------------------------------------------------

  const handleReindex = useCallback(async () => {
    if (!caseId || reindexing) return;
    setReindexing(true);
    setReindexProgress('Fetching documents...');

    try {
      const res = await fetch(`/api/documents?caseId=${caseId}`);
      if (!res.ok) throw new Error('Failed to fetch documents');
      const data = await res.json();
      const docs = data.documents || data || [];
      if (!Array.isArray(docs) || docs.length === 0) {
        setReindexProgress('No documents found');
        setTimeout(() => { setReindexProgress(''); setReindexing(false); }, 2000);
        return;
      }

      for (let i = 0; i < docs.length; i++) {
        setReindexProgress(`Reindexing ${i + 1}/${docs.length} documents...`);
        await fetch(`/api/documents/${docs[i].id}/reindex-pages`, { method: 'POST' }).catch(() => {});
      }

      setReindexProgress(`Done! Reindexed ${docs.length} documents`);
      setTimeout(() => { setReindexProgress(''); setReindexing(false); }, 3000);
    } catch (err: any) {
      setReindexProgress(`Error: ${err.message}`);
      setTimeout(() => { setReindexProgress(''); setReindexing(false); }, 3000);
    }
  }, [caseId, reindexing]);

  // ---------------------------------------------------------------------------
  // Key handler
  // ---------------------------------------------------------------------------

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Computed
  const models = getModels(provider, ollamaModels);
  const streamingText = deepSearch ? deepStreamingAnswer : tokens;
  const currentError = deepSearch ? deepError : error;
  const hasThinkingEntries = progressLog.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Tabs + New Chat */}
      <div className="flex border-b border-gray-200 shrink-0">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex-1 px-3 py-2 text-sm font-medium ${
            activeTab === 'chat'
              ? 'text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => setActiveTab('workflows')}
          className={`flex-1 px-3 py-2 text-sm font-medium ${
            activeTab === 'workflows'
              ? 'text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Workflows
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 px-3 py-2 text-sm font-medium ${
            activeTab === 'history'
              ? 'text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          History
        </button>
        {activeTab === 'chat' && messages.length > 0 && (
          <button
            onClick={handleNewChat}
            className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 flex items-center gap-1"
            title="New Chat"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        )}
      </div>

      {activeTab === 'chat' ? (
        <>
          {/* Provider / Model selectors */}
          <div className="px-2 py-1.5 border-b border-gray-100 space-y-1.5 shrink-0">
            <div className="flex items-center gap-1.5">
              <select
                value={provider}
                onChange={e => handleProviderChange(e.target.value)}
                className="flex-1 px-1.5 py-1 text-xs border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">Provider...</option>
                {PROVIDERS.map(p => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                disabled={!provider}
                className="flex-1 px-1.5 py-1 text-xs border border-gray-200 rounded bg-white disabled:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-400 truncate"
              >
                {!provider && <option value="">Model...</option>}
                {provider === 'ollama' && ollamaModelsLoading && <option value="">Loading...</option>}
                {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {/* Reindex button */}
              {caseId && (
                <button
                  onClick={handleReindex}
                  disabled={reindexing}
                  className="p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50 disabled:opacity-40 shrink-0"
                  title="Reindex case documents"
                >
                  <svg className={`w-3.5 h-3.5 ${reindexing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 19.644l3.181-3.182" />
                  </svg>
                </button>
              )}
            </div>

            {/* Reindex progress */}
            {reindexProgress && (
              <div className="text-[10px] text-blue-600 px-0.5">{reindexProgress}</div>
            )}

            {/* Toggle controls row */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Deep Search toggle */}
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] font-medium text-gray-500">Deep</label>
                <button
                  type="button"
                  onClick={() => setDeepSearch(!deepSearch)}
                  className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${deepSearch ? 'bg-indigo-600' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${deepSearch ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Thinking toggle */}
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] font-medium text-gray-500">Thinking</label>
                <button
                  type="button"
                  onClick={() => setThinkingMode(!thinkingMode)}
                  className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${thinkingMode ? 'bg-purple-600' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${thinkingMode ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Max Tokens */}
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] font-medium text-gray-500">Tokens</label>
                <select
                  value={maxTokens}
                  onChange={e => setMaxTokens(Number(e.target.value))}
                  className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value={512}>512</option>
                  <option value={1024}>1k</option>
                  <option value={2048}>2k</option>
                  <option value={4096}>4k</option>
                </select>
              </div>
            </div>
          </div>

          {/* Selection indicator */}
          {hasSelection && (
            <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-600 flex items-center gap-1.5 shrink-0">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              Editing selected text
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {messages.length === 0 && !isAnyStreaming && (
              <div className="text-xs text-gray-400 text-center py-8">
                Ask questions about your document or case.
                {hasSelection ? ' Selected text will be used as context.' : ''}
                {deepSearch && (
                  <span className="block mt-1 text-indigo-400">Deep search mode enabled — searches across indexed documents.</span>
                )}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {m.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none">
                      {m.mode === 'deep' && (
                        <div className="text-[10px] text-indigo-500 font-medium mb-1 not-prose">Deep Search Result</div>
                      )}
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                      {/* Action buttons */}
                      <div className="flex gap-1.5 mt-2 pt-2 border-t border-gray-200 not-prose">
                        {onInsertText && (
                          <button
                            onClick={() => onInsertText(m.content)}
                            className="text-[11px] px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 text-gray-700"
                          >
                            Insert
                          </button>
                        )}
                        {onReplaceSelection && hasSelection && (
                          <button
                            onClick={() => onReplaceSelection(m.content)}
                            className="text-[11px] px-2 py-0.5 rounded bg-blue-100 hover:bg-blue-200 text-blue-700"
                          >
                            Replace Selection
                          </button>
                        )}
                        <button
                          onClick={() => navigator.clipboard.writeText(m.content)}
                          className="text-[11px] px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 text-gray-700"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}

            {/* Thinking log (during streaming) */}
            {isAnyStreaming && hasThinkingEntries && (
              <AIThinkingLog
                entries={progressLog}
                expanded={thinkingExpanded}
                onToggle={() => setThinkingExpanded(!thinkingExpanded)}
                startTime={searchStartTime}
                loading={isAnyStreaming}
              />
            )}

            {/* Streaming indicator */}
            {isAnyStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown>{streamingText || '...'}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}

            {/* Collapsed thinking log after completion */}
            {!isAnyStreaming && hasThinkingEntries && searchStartTime > 0 && (
              <AIThinkingLog
                entries={progressLog}
                expanded={thinkingExpanded}
                onToggle={() => setThinkingExpanded(!thinkingExpanded)}
                startTime={searchStartTime}
                loading={false}
              />
            )}

            {currentError && (
              <div className="text-xs text-red-500 px-2 py-1 bg-red-50 rounded">
                Error: {currentError}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input — resizable with drag handle */}
          <div className="border-t border-gray-200 shrink-0">
            {/* Drag handle */}
            <div
              className="h-2 cursor-row-resize flex items-center justify-center hover:bg-blue-100 active:bg-blue-200 transition-colors group"
              onMouseDown={(e) => {
                e.preventDefault();
                isResizingInput.current = true;
                const startY = e.clientY;
                const startH = chatInputHeight;
                const onMove = (ev: MouseEvent) => {
                  if (!isResizingInput.current) return;
                  const newH = Math.min(CHAT_INPUT_MAX, Math.max(CHAT_INPUT_MIN, startH - (ev.clientY - startY)));
                  setChatInputHeight(newH);
                };
                const onUp = () => {
                  isResizingInput.current = false;
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  document.body.style.userSelect = '';
                  setChatInputHeight(prev => {
                    try { localStorage.setItem(LS_CHAT_INPUT_HEIGHT, String(prev)); } catch {}
                    return prev;
                  });
                };
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            >
              <div className="w-8 h-0.5 rounded bg-gray-300 group-hover:bg-blue-400" />
            </div>
            <div className="px-3 pb-2 flex gap-1.5">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  deepSearch
                    ? 'Deep search across case documents...'
                    : hasSelection
                      ? 'Ask about selected text...'
                      : 'Ask about your document...'
                }
                style={{ height: chatInputHeight }}
                className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md resize-none"
              />
              <div className="flex flex-col gap-1">
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isAnyStreaming}
                  className={`px-3 py-1.5 text-sm font-medium text-white rounded-md disabled:opacity-40 ${
                    deepSearch
                      ? 'bg-indigo-600 hover:bg-indigo-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {isAnyStreaming ? '...' : deepSearch ? 'Deep' : 'Send'}
                </button>
                {isAnyStreaming && (
                  <button
                    onClick={handleAbort}
                    className="px-3 py-1.5 text-sm text-red-600 border border-red-300 rounded-md hover:bg-red-50"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      ) : activeTab === 'workflows' ? (
        /* Workflows tab */
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <label className="text-xs text-gray-500 font-medium mb-1 block">Document Workflow</label>
          <select
            value={selectedWorkflow}
            onChange={e => setSelectedWorkflow(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md bg-white mb-3"
          >
            <option value="">Select a workflow...</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>
                {t.name} {t.category ? `(${t.category})` : ''}
              </option>
            ))}
          </select>

          {selectedWorkflow && (() => {
            const tmpl = templates.find(t => t.id === selectedWorkflow);
            if (!tmpl) return null;
            return (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">{tmpl.name}</h3>
                {tmpl.description && (
                  <p className="text-xs text-gray-500">{tmpl.description}</p>
                )}
                <button
                  onClick={() => {
                    setActiveTab('chat');
                    setInput(`Help me write a ${tmpl.name} for this case. Guide me through the structure and key sections.`);
                  }}
                  className="w-full px-3 py-1.5 text-sm font-medium text-blue-700 border border-blue-300 rounded-md hover:bg-blue-50"
                >
                  Start with this workflow
                </button>
              </div>
            );
          })()}

          {templates.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">
              No workflow templates found. Create them in the Workflows page.
            </div>
          )}
        </div>
      ) : (
        /* History tab */
        draftId ? (
          <DraftVersionHistory
            draftId={draftId}
            currentVersion={currentVersion ?? 1}
            onRestore={() => onDraftRestore?.()}
            onPreview={onPreviewVersion}
            caseId={caseId}
            onImportComplete={onDraftRestore}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-gray-400 px-4">
            Select a draft to view version history
          </div>
        )
      )}
    </div>
  );
}
