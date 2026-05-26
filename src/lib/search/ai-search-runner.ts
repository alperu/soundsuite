/**
 * Singleton runner that owns an in-flight regular AI search across page
 * navigations.
 *
 * The fetch + NDJSON parsing live at module scope so the search keeps running
 * even after the SearchInterface component unmounts (e.g. user navigates to
 * /case-management mid-search). When the user returns, the component
 * subscribes again and re-renders the current state from `getSnapshot()`.
 *
 * Mirrors the shape of `deep-search-runner.ts` so the two flows can share the
 * same mirror-effect pattern in SearchInterface.
 */

import type { AIProgressEntry } from '@/components/search/ai-thinking-log';

export interface AISearchResult {
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

export interface AISearchTurnSnapshot {
  query: string;
  sessionId: string;
  result?: AISearchResult;
  error?: string;
  completedAt: number;
}

export interface AISearchRunnerState {
  loading: boolean;
  query: string;
  sessionId: string | null;
  startTime: number;
  progress: AIProgressEntry | null;
  streamingAnswer: string | null;
  streamTokenCount: number;
  progressLog: AIProgressEntry[];
  lastResult: AISearchResult | null;
  lastError: string | null;
  /** Completed turns, oldest-first. Survives navigation. */
  turns: AISearchTurnSnapshot[];
}

export interface AISearchStartParams {
  query: string;
  provider: string;
  model: string;
  caseId?: string;
  sessionId: string;
  thinking?: boolean;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  booleanMode?: boolean;
  workflowIds?: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Route the synthesis through ss-rlm with recursive tool calls. */
  useRlm?: boolean;
}

const initialState: AISearchRunnerState = {
  loading: false,
  query: '',
  sessionId: null,
  startTime: 0,
  progress: null,
  streamingAnswer: null,
  streamTokenCount: 0,
  progressLog: [],
  lastResult: null,
  lastError: null,
  turns: [],
};

class AISearchRunner {
  private state: AISearchRunnerState = { ...initialState };
  private listeners = new Set<() => void>();
  private abortCtrl: AbortController | null = null;

  getSnapshot = (): AISearchRunnerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<AISearchRunnerState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Wipe completed turns + error. Used by "New chat". */
  reset(sessionId: string) {
    if (this.state.loading) return; // never wipe an active run
    this.state = { ...initialState, sessionId };
    this.emit();
  }

  abort() {
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch { /* noop */ }
    }
  }

  isLoading() { return this.state.loading; }

  async start(params: AISearchStartParams): Promise<AISearchResult | null> {
    if (this.state.loading) {
      throw new Error('An AI search is already in progress');
    }

    this.abortCtrl = new AbortController();
    const signal = this.abortCtrl.signal;

    this.set({
      loading: true,
      query: params.query,
      sessionId: params.sessionId,
      startTime: Date.now(),
      progress: null,
      streamingAnswer: null,
      streamTokenCount: 0,
      progressLog: [],
      lastResult: null,
      lastError: null,
    });

    let finalResult: AISearchResult | null = null;
    let errMsg: string | null = null;

    try {
      const res = await fetch('/api/search/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: params.query,
          provider: params.provider,
          model: params.model,
          caseId: params.caseId || undefined,
          chatId: params.sessionId,
          thinking: params.thinking,
          maxTokens: params.maxTokens,
          effort: params.effort,
          useRlm: params.useRlm,
          ...(params.booleanMode ? { mode: 'boolean' } : {}),
          ...(params.history && params.history.length > 0 ? { history: params.history } : {}),
          ...(params.workflowIds && params.workflowIds.length > 0 ? { workflowIds: params.workflowIds } : {}),
        }),
        signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'AI search failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (signal.aborted) {
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
          if (signal.aborted) break;
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            this.handleEvent(event);
            if (event.type === 'result') finalResult = event.data as AISearchResult;
            if (event.type === 'error') throw new Error(event.error);
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }

      // Trailing buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          this.handleEvent(event);
          if (event.type === 'result') finalResult = event.data as AISearchResult;
          else if (event.type === 'error') throw new Error(event.error);
        } catch { /* ignore */ }
      }

      if (!finalResult) throw new Error('AI search completed without result');
    } catch (e) {
      errMsg = e instanceof Error ? e.message : 'Unknown error';
      if ((e as Error)?.name === 'AbortError') {
        errMsg = 'Search stopped';
      }
    } finally {
      const turn: AISearchTurnSnapshot = {
        query: this.state.query,
        sessionId: this.state.sessionId || params.sessionId,
        result: finalResult || undefined,
        error: errMsg || undefined,
        completedAt: Date.now(),
      };
      this.set({
        loading: false,
        progress: null,
        streamingAnswer: null,
        progressLog: [],
        lastResult: finalResult,
        lastError: errMsg,
        turns: [...this.state.turns, turn],
      });
      this.abortCtrl = null;
    }

    if (errMsg) {
      const err = new Error(errMsg);
      if (errMsg === 'Search stopped') (err as any).name = 'AbortError';
      throw err;
    }
    return finalResult;
  }

  private handleEvent(event: any) {
    if (event.type === 'progress') {
      const entry: AIProgressEntry = { ...event, timestamp: Date.now() };
      this.set({
        progress: entry,
        progressLog: [...this.state.progressLog, entry],
      });
    } else if (event.type === 'token') {
      this.set({
        streamingAnswer: (this.state.streamingAnswer ?? '') + event.text,
        streamTokenCount:
          this.state.streamTokenCount +
          Math.max(1, Math.round((event.text as string).length / 4)),
      });
    } else if (event.type === 'thinking') {
      const entry: AIProgressEntry = {
        type: 'progress',
        step: 'thinking',
        message: event.text,
        timestamp: Date.now(),
      };
      this.set({
        progressLog: [...this.state.progressLog, entry],
      });
    }
  }
}

// Single shared instance, module-scoped → survives React component lifecycles.
export const aiSearchRunner = new AISearchRunner();
