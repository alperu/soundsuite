'use client';

/**
 * useDraftSuggestions — state + streaming consumer for the Auto-Suggest feature.
 *
 * Owns the in-memory list of DraftSuggestionDTO rows for the active draft,
 * consumes the NDJSON stream emitted by /api/draft/chat when autoSuggest=true,
 * persists status changes via PATCH, and rehydrates on mount from the GET
 * endpoint so pending suggestions survive page reloads.
 *
 * The hook is intentionally decoupled from the editor — the caller is
 * responsible for wiring Accept/Flash into the editor via an `onAction`
 * callback. The hook only handles the DB side + streaming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIProgressEntry } from '@/components/search/ai-thinking-log';
import type {
  DenyReasonTagSlug,
  DraftSuggestionDTO,
  SuggestionStatus,
  SuggestionStreamEvent,
} from '@/lib/draft/suggestion-types';

export interface UseDraftSuggestionsOptions {
  draftId?: string;
  /** Called when the stream installs a new or updated suggestion. */
  onSuggestionArrived?: (suggestion: DraftSuggestionDTO) => void;
  /** Called when a suggestion transitions to a terminal status client-side. */
  onSuggestionResolved?: (id: string, status: SuggestionStatus) => void;
  /** Called when the initial stream run finishes with a count. */
  onStreamComplete?: (count: number) => void;
  /** Called on warnings (e.g. anchor not found). */
  onWarning?: (message: string) => void;
  /** Called on fatal stream errors. */
  onError?: (message: string, raw?: string) => void;
}

export interface UseDraftSuggestionsReturn {
  suggestions: DraftSuggestionDTO[];
  /** Ordered view: pending first (by anchorFrom), then resolved by updatedAt desc. */
  orderedSuggestions: DraftSuggestionDTO[];
  pendingCount: number;
  isStreaming: boolean;
  lastError: string | null;

  /** Thinking-log entries from the most recent run (progress + warnings). */
  progressLog: AIProgressEntry[];
  /** Unix ms when the current run started (for AIThinkingLog elapsed timer). 0 when idle. */
  runStartTime: number;

  /** Start an Auto-Suggest generation run. */
  startAutoSuggest: (params: AutoSuggestRequest) => Promise<void>;
  /** Regenerate a single suggestion in place. */
  regenerate: (id: string, params: AutoSuggestRequest) => Promise<void>;
  /** Abort the in-flight stream, if any. */
  abort: () => void;

  /** Transition a suggestion to accepted/denied/ignored. */
  updateStatus: (
    id: string,
    status: Extract<SuggestionStatus, 'accepted' | 'denied' | 'ignored' | 'pending'>,
    payload?: { denyReasonTags?: DenyReasonTagSlug[]; denyReasonText?: string | null }
  ) => Promise<DraftSuggestionDTO | null>;

  /** Permanently delete a suggestion (removes from DB and local state). */
  deleteSuggestion: (id: string) => Promise<void>;
  /** Permanently delete all suggestions with the given ids. */
  bulkDelete: (ids: string[]) => Promise<void>;
  /** Refresh from the server (e.g. on focus). */
  refresh: () => Promise<void>;
  /** Manually set the list (used after external edits). */
  setSuggestions: React.Dispatch<React.SetStateAction<DraftSuggestionDTO[]>>;
}

export interface AutoSuggestRequest {
  /** The user's free-form request. */
  query: string;
  /** Smart-windowed document text the server should use for anchor location. */
  documentContent: string;
  selectedText?: string;
  provider: string;
  model: string;
  caseIds?: string[];
  thinking?: boolean;
  maxTokens?: number;
  vectorSearch?: boolean;
  /** When true, the server runs iterative Deep Research before producing suggestions. */
  deepSearch?: boolean;
  sessionId?: string;
}

export function useDraftSuggestions(options: UseDraftSuggestionsOptions): UseDraftSuggestionsReturn {
  const { draftId, onSuggestionArrived, onSuggestionResolved, onStreamComplete, onWarning, onError } = options;

  const [suggestions, setSuggestions] = useState<DraftSuggestionDTO[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<AIProgressEntry[]>([]);
  const [runStartTime, setRunStartTime] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Keep callback refs stable so the effect below doesn't re-run them unnecessarily.
  const callbacksRef = useRef({ onSuggestionArrived, onSuggestionResolved, onStreamComplete, onWarning, onError });
  callbacksRef.current = { onSuggestionArrived, onSuggestionResolved, onStreamComplete, onWarning, onError };

  // ---------------------------------------------------------------------
  // Rehydrate on mount / draftId change
  // ---------------------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!draftId) return;
    try {
      const res = await fetch(`/api/draft/suggestions?draftId=${encodeURIComponent(draftId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.suggestions)) {
        setSuggestions(data.suggestions as DraftSuggestionDTO[]);
      }
    } catch {
      // ignore
    }
  }, [draftId]);

  useEffect(() => {
    if (draftId) {
      refresh();
    } else {
      setSuggestions([]);
    }
  }, [draftId, refresh]);

  // ---------------------------------------------------------------------
  // Stream consumer
  // ---------------------------------------------------------------------
  const consumeStream = useCallback(async (url: string, body: object) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setLastError(null);
    setProgressLog([]);
    setRunStartTime(Date.now());

    console.log('[useDraftSuggestions] consumeStream start', {
      url,
      bodyKeys: Object.keys(body as object),
      autoSuggest: (body as { autoSuggest?: boolean }).autoSuggest,
      draftId: (body as { draftId?: string }).draftId,
    });

    let eventCount = 0;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      console.log('[useDraftSuggestions] fetch response', { ok: response.ok, status: response.status });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errBody.error || `HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        // The raw event may carry fields beyond SuggestionStreamEvent — in
        // particular, `progress` events now include step + detail.
        let rawEvent: Record<string, unknown>;
        try {
          rawEvent = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          console.warn('[useDraftSuggestions] failed to parse NDJSON line', { line: trimmed.slice(0, 200) });
          return;
        }
        eventCount++;
        console.log('[useDraftSuggestions] event', {
          n: eventCount,
          type: rawEvent.type,
          step: rawEvent.step,
          preview: JSON.stringify(rawEvent).slice(0, 200),
        });
        const event = rawEvent as unknown as SuggestionStreamEvent;
        if (event.type === 'suggestion') {
          // Insert or update by id.
          setSuggestions((prev) => {
            const existing = prev.findIndex((s) => s.id === event.suggestion.id);
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = event.suggestion;
              return next;
            }
            return [...prev, event.suggestion];
          });
          callbacksRef.current.onSuggestionArrived?.(event.suggestion);
        } else if (event.type === 'suggestions_done') {
          callbacksRef.current.onStreamComplete?.(event.count);
        } else if (event.type === 'regenerate_done') {
          callbacksRef.current.onStreamComplete?.(1);
        } else if (event.type === 'warning') {
          // Append warnings to the thinking log with a ⚠ marker, AND fire the
          // callback so callers can toast if they want.
          setProgressLog((prev) => [
            ...prev,
            {
              type: 'progress',
              step: 'warning',
              message: `⚠ ${event.message}`,
              timestamp: Date.now(),
            } as AIProgressEntry,
          ]);
          callbacksRef.current.onWarning?.(event.message);
        } else if (event.type === 'progress') {
          // Coalesce consecutive 'generating_tick' heartbeats — we only want
          // the latest one visible, not a pile-up of per-tick entries.
          const step = (rawEvent.step as string | undefined) ?? 'progress';
          const message = (rawEvent.message as string | undefined) ?? '';
          const detail = rawEvent.detail as AIProgressEntry['detail'] | undefined;
          setProgressLog((prev) => {
            if (step === 'generating_tick' && prev.length > 0 && prev[prev.length - 1].step === 'generating_tick') {
              const next = prev.slice(0, -1);
              next.push({
                type: 'progress',
                step,
                message,
                timestamp: Date.now(),
                ...(detail ? { detail } : {}),
              } as AIProgressEntry);
              return next;
            }
            return [
              ...prev,
              {
                type: 'progress',
                step,
                message,
                timestamp: Date.now(),
                ...(detail ? { detail } : {}),
              } as AIProgressEntry,
            ];
          });
        } else if (event.type === 'error') {
          setLastError(event.error);
          setProgressLog((prev) => [
            ...prev,
            {
              type: 'progress',
              step: 'error',
              message: `✗ ${event.error}`,
              timestamp: Date.now(),
            } as AIProgressEntry,
          ]);
          callbacksRef.current.onError?.(event.error, event.raw);
        }
        // token/result events intentionally ignored in suggest mode — we get
        // the char-count progress via 'generating_tick' progress events.
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }
      if (buffer.trim()) processLine(buffer);
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        console.log('[useDraftSuggestions] stream aborted by user');
        return;
      }
      const msg = e.message || 'Stream failed';
      console.error('[useDraftSuggestions] stream error', { message: msg, eventCount });
      setLastError(msg);
      callbacksRef.current.onError?.(msg);
    } finally {
      console.log('[useDraftSuggestions] stream finally', { eventCount });
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, []);

  const startAutoSuggest = useCallback(
    async (params: AutoSuggestRequest) => {
      if (!draftId) throw new Error('draftId is required');
      await consumeStream('/api/draft/chat', {
        ...params,
        draftId,
        autoSuggest: true,
      });
    },
    [draftId, consumeStream]
  );

  const regenerate = useCallback(
    async (id: string, params: AutoSuggestRequest) => {
      if (!draftId) throw new Error('draftId is required');
      await consumeStream('/api/draft/chat', {
        ...params,
        draftId,
        regenerateFromSuggestionId: id,
      });
    },
    [draftId, consumeStream]
  );

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  // ---------------------------------------------------------------------
  // Status transitions (Accept / Deny / Ignore)
  // ---------------------------------------------------------------------
  const updateStatus = useCallback<UseDraftSuggestionsReturn['updateStatus']>(
    async (id, status, payload) => {
      // Optimistic update
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                denyReasonTags: payload?.denyReasonTags ?? s.denyReasonTags,
                denyReasonText: payload?.denyReasonText ?? s.denyReasonText,
                resolvedAt: status === 'pending' ? null : new Date().toISOString(),
              }
            : s
        )
      );
      try {
        const res = await fetch(`/api/draft/suggestions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status,
            denyReasonTags: payload?.denyReasonTags,
            denyReasonText: payload?.denyReasonText,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const updated = data.suggestion as DraftSuggestionDTO;
        // Reconcile with server state (in case server transformed anything).
        setSuggestions((prev) => prev.map((s) => (s.id === id ? updated : s)));
        callbacksRef.current.onSuggestionResolved?.(id, status);
        return updated;
      } catch (err: unknown) {
        // Roll back on error.
        const e = err as Error;
        setLastError(e.message || 'Failed to update suggestion');
        await refresh();
        return null;
      }
    },
    [refresh]
  );

  // ---------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------
  const deleteSuggestion = useCallback(async (id: string) => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
    try {
      await fetch(`/api/draft/suggestions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // If the delete failed, refresh to get back in sync.
      await refresh();
    }
  }, [refresh]);

  const bulkDelete = useCallback(async (ids: string[]) => {
    const idSet = new Set(ids);
    setSuggestions((prev) => prev.filter((s) => !idSet.has(s.id)));
    await Promise.allSettled(
      ids.map((id) => fetch(`/api/draft/suggestions/${encodeURIComponent(id)}`, { method: 'DELETE' }))
    );
  }, []);

  // ---------------------------------------------------------------------
  // Derived: ordered view + pending count
  // ---------------------------------------------------------------------
  const orderedSuggestions = (() => {
    const pending = suggestions
      .filter((s) => s.status === 'pending')
      .slice()
      .sort((a, b) => a.anchorFrom - b.anchorFrom);
    const resolved = suggestions
      .filter((s) => s.status !== 'pending')
      .slice()
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    return [...pending, ...resolved];
  })();

  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;

  return {
    suggestions,
    orderedSuggestions,
    pendingCount,
    isStreaming,
    lastError,
    progressLog,
    runStartTime,
    startAutoSuggest,
    regenerate,
    abort,
    updateStatus,
    deleteSuggestion,
    bulkDelete,
    refresh,
    setSuggestions,
  };
}
