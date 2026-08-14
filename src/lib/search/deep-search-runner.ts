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
import { capThoughts } from '@/lib/search/report-preamble';

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
  /** Per-turn elapsed ms. Carried explicitly so historical turns seeded via
   *  hydrate() keep their saved timing instead of being recomputed against a
   *  later run's startTime. */
  searchTime?: number;
}

export interface DeepSearchRunnerState {
  loading: boolean;
  query: string;
  sessionId: string | null;
  startTime: number;
  progress: DeepSearchProgress | null;
  streamingAnswer: string | null;
  /** Live research trace for the in-flight turn. Plain text, never markdown —
   *  it can contain raw retrieved excerpts. */
  streamingThoughts: string | null;
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
  /** Graph-scope pre-filter clauses. Sent INSTEAD of `caseId` — the two AND
   *  together server-side and would match nothing. */
  whereClauses?: string[];
}

const initialState: DeepSearchRunnerState = {
  loading: false,
  query: '',
  sessionId: null,
  startTime: 0,
  progress: null,
  streamingAnswer: null,
  streamingThoughts: null,
  streamTokenCount: 0,
  progressLog: [],
  warnings: [],
  lastResult: null,
  lastError: null,
  turns: [],
};

/** Coalescing window for token/thinking notifications. Streaming emits per
 *  token; every emit re-renders SearchInterface and re-parses the whole
 *  accumulated answer through react-markdown (O(N²) over a long report), which
 *  is what froze the UI during active searches. State still updates per event —
 *  only listener notification is batched. */
const STREAM_EMIT_INTERVAL_MS = 80;

class DeepSearchRunner {
  private state: DeepSearchRunnerState = { ...initialState };
  private listeners = new Set<() => void>();
  private abortCtrl: AbortController | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  getSnapshot = (): DeepSearchRunnerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Emit now and cancel any pending coalesced flush (state is already current). */
  private flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.emit();
  }

  private set(patch: Partial<DeepSearchRunnerState>) {
    this.state = { ...this.state, ...patch };
    this.flushNow();
  }

  /** Apply the patch immediately but defer listener notification to the next
   *  coalescing window. For high-frequency stream events only. */
  private setThrottled(patch: Partial<DeepSearchRunnerState>) {
    this.state = { ...this.state, ...patch };
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.emit();
    }, STREAM_EMIT_INTERVAL_MS);
  }

  /** Wipe completed turns + error. Used by "New chat". */
  reset(sessionId: string) {
    if (this.state.loading) return; // never wipe an active run
    this.state = { ...initialState, sessionId };
    this.flushNow();
  }

  /** Seed completed turns from persisted history when a saved deep-search chat
   *  is opened. Without this the runner's snapshot holds zero turns for the
   *  reopened session, so the first follow-up search mirrors back ONLY the new
   *  turn — clobbering the loaded history in React state and overwriting the
   *  saved file with a single turn pair. Seeding makes follow-ups append. */
  hydrate(sessionId: string, turns: DeepSearchTurnSnapshot[]) {
    if (this.state.loading) return; // never disturb an active run
    this.state = { ...initialState, sessionId, turns };
    this.flushNow();
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
      streamingThoughts: null,
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
          ...(params.whereClauses && params.whereClauses.length > 0
            ? { whereClauses: params.whereClauses }
            : {}),
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
      const completedAt = Date.now();
      // The server's trace covers the research passes; the client also folds in
      // provider thinking deltas. Prefer whichever is longer so the persisted
      // turn keeps the fuller picture — but cap the client copy the same way
      // the server caps its own, or the comparison silently picks the uncapped
      // one *because* the server's was trimmed, and the cap never applies.
      const clientTrace = this.state.streamingThoughts
        ? capThoughts(this.state.streamingThoughts)
        : null;
      if (finalResult && clientTrace && clientTrace.length > (finalResult.thoughts?.length ?? 0)) {
        finalResult = { ...finalResult, thoughts: clientTrace };
      }
      const turn: DeepSearchTurnSnapshot = {
        query: this.state.query,
        sessionId: this.state.sessionId || params.sessionId,
        result: finalResult || undefined,
        error: errMsg || undefined,
        completedAt,
        searchTime: Math.max(0, completedAt - this.state.startTime),
      };
      // Clear in-flight visuals on completion. Keep warnings so the user can
      // still see anything important the run surfaced.
      this.set({
        loading: false,
        progress: null,
        streamingAnswer: null,
        streamingThoughts: null,
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
      // (The RLM handoff used to inject a "## Final Report" separator into the
      // streaming answer, because RLM narration and the report shared the
      // answer channel. RLM narration now streams to `streamingThoughts`, so
      // the answer holds nothing but synthesis output and needs no separator.)
    } else if (event.type === 'token') {
      this.setThrottled({
        streamingAnswer: (this.state.streamingAnswer ?? '') + event.text,
        streamTokenCount:
          this.state.streamTokenCount +
          Math.max(1, Math.round((event.text as string).length / 4)),
      });
    } else if (event.type === 'thoughts' || event.type === 'thinking') {
      // One accumulating string, not an array push per token: appending to an
      // array on a per-token channel copies the whole log every time (O(N²)),
      // which is what the coalescing window above exists to hide.
      this.setThrottled({
        streamingThoughts: (this.state.streamingThoughts ?? '') + event.text,
      });
    }
  }
}

// Single shared instance, module-scoped → survives React component lifecycles.
export const deepSearchRunner = new DeepSearchRunner();
