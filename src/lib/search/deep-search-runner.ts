/**
 * Singleton runner that owns an in-flight deep search across page navigations.
 *
 * The fetch + NDJSON parsing live at module scope so the search keeps running
 * even after the SearchInterface component unmounts (e.g. user navigates to
 * /case-management mid-search). When the user returns, the component subscribes
 * again via `useDeepSearchRunner` and re-renders the current state.
 *
 * Only the deep-search flow uses this runner. Regular AI search is request-
 * scoped to its component because canceling it on unmount is fine.
 */

import type {
  DeepSearchProgress,
  DeepSearchResult,
} from '@/lib/search/deep-search';

export interface DeepSearchWarning {
  source: string;
  host?: string;
  message: string;
  count?: number;
}

export interface DeepProgressEntry {
  step: string;
  message: string;
  timestamp: number;
}

export interface DeepSearchTurnSnapshot {
  query: string;
  sessionId: string;
  result?: DeepSearchResult;
  error?: string;
  completedAt: number;
}

export interface DeepSearchRunnerState {
  loading: boolean;
  query: string;
  sessionId: string | null;
  startTime: number;
  progress: DeepSearchProgress | null;
  streamingAnswer: string | null;
  streamTokenCount: number;
  progressLog: DeepProgressEntry[];
  warnings: DeepSearchWarning[];
  lastResult: DeepSearchResult | null;
  lastError: string | null;
  /** Completed turns, oldest-first. Survives navigation. */
  turns: DeepSearchTurnSnapshot[];
}

export interface DeepSearchStartParams {
  query: string;
  provider: string;
  model: string;
  caseId?: string;
  sessionId: string;
  thinking?: boolean;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  multiPass?: boolean;
  workflowIds?: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Route the final synthesis through ss-rlm with recursive tool calls. */
  useRlm?: boolean;
}

const initialState: DeepSearchRunnerState = {
  loading: false,
  query: '',
  sessionId: null,
  startTime: 0,
  progress: null,
  streamingAnswer: null,
  streamTokenCount: 0,
  progressLog: [],
  warnings: [],
  lastResult: null,
  lastError: null,
  turns: [],
};

class DeepSearchRunner {
  private state: DeepSearchRunnerState = { ...initialState };
  private listeners = new Set<() => void>();
  private abortCtrl: AbortController | null = null;

  getSnapshot = (): DeepSearchRunnerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<DeepSearchRunnerState>) {
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

  async start(params: DeepSearchStartParams): Promise<DeepSearchResult | null> {
    if (this.state.loading) {
      throw new Error('A deep search is already in progress');
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
      warnings: [],
      lastResult: null,
      lastError: null,
    });

    let finalResult: DeepSearchResult | null = null;
    let errMsg: string | null = null;

    try {
      const res = await fetch('/api/search/deep', {
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
          multiPass: params.multiPass,
          ...(params.useRlm ? { useRlm: true } : {}),
          ...(params.history && params.history.length > 0 ? { history: params.history } : {}),
          ...(params.workflowIds && params.workflowIds.length > 0 ? { workflowIds: params.workflowIds } : {}),
        }),
        signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Deep search failed');
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
            if (event.type === 'result') finalResult = event.data as DeepSearchResult;
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
          if (event.type === 'result') finalResult = event.data as DeepSearchResult;
          else if (event.type === 'error') throw new Error(event.error);
        } catch { /* ignore */ }
      }

      if (!finalResult) throw new Error('Deep search completed without result');
    } catch (e) {
      errMsg = e instanceof Error ? e.message : 'Unknown error';
      if ((e as Error)?.name === 'AbortError') {
        errMsg = 'Search stopped';
      }
    } finally {
      const turn: DeepSearchTurnSnapshot = {
        query: this.state.query,
        sessionId: this.state.sessionId || params.sessionId,
        result: finalResult || undefined,
        error: errMsg || undefined,
        completedAt: Date.now(),
      };
      // Clear in-flight visuals on completion. Keep warnings so the user can
      // still see anything important the run surfaced.
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

    return finalResult;
  }

  private handleEvent(event: any) {
    if (event.type === 'progress') {
      const p = event as DeepSearchProgress;
      if (p.warnings && p.warnings.length > 0) {
        const next = [...this.state.warnings];
        for (const w of p.warnings) {
          const idx = next.findIndex(
            x => x.source === w.source && x.host === w.host && x.message === w.message
          );
          if (idx >= 0) next[idx] = w;
          else next.push(w);
        }
        this.set({ warnings: next });
      }
      if (p.step !== 'warning') this.set({ progress: p });
      // RLM tool-call rounds are valuable history — keep them in the log so
      // the user can see what sub-queries the model asked for.
      if (p.step === 'rlm-subcall' || p.step === 'rlm-synthesis') {
        this.set({
          progressLog: [
            ...this.state.progressLog,
            { step: p.step, message: p.message, timestamp: Date.now() },
          ],
        });
      }
      // Handoff transition: the orchestrator emits a 'generating' step after
      // RLM finishes its loop with a message containing "now drafting" — at
      // that point inject a visual separator so RLM's preamble stays visible
      // and the cloud LLM's tokens append below it as a distinct section.
      // We deliberately do NOT clear streamingAnswer: clearing made the user
      // think the system froze, since the next Anthropic call may take
      // 5–30 s to produce its first token.
      if (
        p.step === 'generating'
        && typeof p.message === 'string'
        && /now drafting/i.test(p.message)
        && this.state.streamingAnswer
        && !this.state.streamingAnswer.includes('\n\n---\n\n## Final Report')
      ) {
        this.set({
          streamingAnswer: `${this.state.streamingAnswer.trimEnd()}\n\n---\n\n## Final Report (${p.message.match(/handing off to (\S+)/i)?.[1] ?? 'cloud LLM'})\n\n`,
        });
      }
    } else if (event.type === 'token') {
      this.set({
        streamingAnswer: (this.state.streamingAnswer ?? '') + event.text,
        streamTokenCount:
          this.state.streamTokenCount +
          Math.max(1, Math.round((event.text as string).length / 4)),
      });
    } else if (event.type === 'thinking') {
      this.set({
        progressLog: [
          ...this.state.progressLog,
          { step: 'thinking', message: event.text, timestamp: Date.now() },
        ],
      });
    }
  }
}

// Single shared instance, module-scoped → survives React component lifecycles.
export const deepSearchRunner = new DeepSearchRunner();
