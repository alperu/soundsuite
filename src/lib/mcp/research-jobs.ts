/**
 * In-memory research/report job store (REPORT-v2.1 Part D).
 *
 * MCP has no partial tool result, so long research runs use the job pattern:
 * `research_start` / `report_start` create a job, `…_status` polls it with a
 * cursor and receives only the evidence it has not seen, `…_result` fetches
 * the final value, `…_cancel` aborts. Every callback also appends to an
 * ordered event log so `GET /api/mcp/{kind}/:id/events` can replay + tail
 * NDJSON and the bridge can relay `notifications/progress` / `message`.
 *
 * Singleton on `globalThis` so it survives Next.js HMR like the tool registry.
 * Finished jobs are evicted 30 min after completion; the store holds at most
 * 100 jobs (oldest finished jobs go first).
 */

import { randomUUID } from 'crypto';
import type {
  EvidenceItem,
  EvidenceResult,
  McpProfile,
  ReportResult,
  ResearchJobEvent,
  ResearchJobKind,
  ResearchJobStatus,
  ResearchJobStatusView,
  ResearchProgress,
} from './research-types';

export const JOB_TTL_MS = 30 * 60 * 1000;
export const MAX_JOBS = 100;

export interface JobHandle {
  id: string;
  /** Aborted by `cancelJob`; pass it to every awaited call. */
  signal: AbortSignal;
  progress(p: ResearchProgress): void;
  evidence(items: EvidenceItem[]): void;
  thoughts(text: string): void;
  /** Appends to `partialReport` — routed profile only; dropped for local. */
  token(text: string): void;
  setOutline(o: EvidenceResult['outline']): void;
  setCost(c: ReportResult['cost']): void;
  rlmNote(text: string): void;
}

interface JobRecord {
  id: string;
  kind: ResearchJobKind;
  profile: McpProfile;
  query: string;
  sessionId?: string;
  status: ResearchJobStatus;
  phase?: string;
  evidence: EvidenceItem[];
  outline?: EvidenceResult['outline'];
  rlmNotes: string[];
  partialReport: string;
  cost?: ReportResult['cost'];
  error?: string;
  result: unknown;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  events: ResearchJobEvent[];
  subscribers: Set<(e: ResearchJobEvent) => void>;
  controller: AbortController;
  evictTimer?: ReturnType<typeof setTimeout>;
}

type Subscriber = (e: ResearchJobEvent) => void;

const FINISHED: ReadonlySet<ResearchJobStatus> = new Set(['done', 'error', 'cancelled']);

const globalForJobs = globalThis as unknown as { __researchJobs: Map<string, JobRecord> | undefined };
const jobs: Map<string, JobRecord> = globalForJobs.__researchJobs ?? (globalForJobs.__researchJobs = new Map());

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isFinished(job: JobRecord): boolean {
  return FINISHED.has(job.status);
}

function emit(job: JobRecord, type: ResearchJobEvent['type'], payload: unknown): void {
  const event: ResearchJobEvent = { seq: job.events.length, ts: Date.now(), type, payload };
  job.events.push(event);
  job.updatedAt = event.ts;
  for (const cb of job.subscribers) {
    try { cb(event); } catch { /* subscriber errors never break the job */ }
  }
}

function finish(job: JobRecord, status: ResearchJobStatus): void {
  if (isFinished(job)) return;
  job.status = status;
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  scheduleEviction(job);
}

function scheduleEviction(job: JobRecord): void {
  if (job.evictTimer) clearTimeout(job.evictTimer);
  const t = setTimeout(() => {
    job.subscribers.clear();
    jobs.delete(job.id);
  }, JOB_TTL_MS);
  (t as { unref?: () => void }).unref?.();
  job.evictTimer = t;
}

/** Keep the store under MAX_JOBS: drop finished jobs oldest-first, then the
 *  oldest running ones (cancelled) as a last resort. */
function enforceCap(): void {
  if (jobs.size < MAX_JOBS) return;
  const byAge = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const job of byAge) {
    if (jobs.size < MAX_JOBS) break;
    if (isFinished(job)) {
      if (job.evictTimer) clearTimeout(job.evictTimer);
      jobs.delete(job.id);
    }
  }
  for (const job of byAge) {
    if (jobs.size < MAX_JOBS) break;
    if (!jobs.has(job.id)) continue;
    job.controller.abort();
    emit(job, 'cancelled', { reason: 'evicted: job cap reached' });
    finish(job, 'cancelled');
    if (job.evictTimer) clearTimeout(job.evictTimer);
    jobs.delete(job.id);
  }
}

function toView(job: JobRecord, cursor: number): ResearchJobStatusView {
  const from = Math.max(0, Math.min(cursor, job.evidence.length));
  const fresh = job.evidence.slice(from);
  const now = Date.now();
  return {
    id: job.id,
    kind: job.kind,
    profile: job.profile,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    cursor: job.evidence.length,
    evidence: fresh,
    newEvidenceCount: fresh.length,
    ...(job.outline ? { outline: job.outline } : {}),
    rlmNotes: [...job.rlmNotes],
    ...(job.profile === 'routed' ? { partialReport: job.partialReport } : {}),
    ...(job.cost ? { cost: job.cost } : {}),
    ...(job.error ? { error: job.error } : {}),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    elapsedMs: (job.finishedAt ?? now) - job.startedAt,
  };
}

function makeHandle(job: JobRecord): JobHandle {
  const live = () => !isFinished(job);
  return {
    id: job.id,
    signal: job.controller.signal,
    progress(p) {
      if (!live()) return;
      job.phase = p.phase;
      emit(job, 'progress', p);
    },
    evidence(items) {
      if (!live() || items.length === 0) return;
      job.evidence.push(...items);
      emit(job, 'evidence', items);
    },
    thoughts(text) {
      if (!live()) return;
      emit(job, 'thoughts', text);
    },
    token(text) {
      if (!live()) return;
      // Local never synthesises — a token would be prose, so it is dropped
      // from both the partial report and the event log.
      if (job.profile !== 'routed') return;
      job.partialReport += text;
      emit(job, 'token', text);
    },
    setOutline(o) {
      if (!live()) return;
      job.outline = o;
      job.updatedAt = Date.now();
    },
    setCost(c) {
      if (!live()) return;
      job.cost = c;
      job.updatedAt = Date.now();
    },
    rlmNote(text) {
      if (!live()) return;
      job.rlmNotes.push(text);
      job.updatedAt = Date.now();
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartJobOptions {
  kind: ResearchJobKind;
  profile: McpProfile;
  query: string;
  sessionId?: string;
  /** The work. Its resolved value becomes `getJobResult(id)`. */
  run: (job: JobHandle) => Promise<unknown>;
}

/**
 * Create a job and start `run` asynchronously. Returns the initial status
 * view immediately; errors thrown by `run` land in `status: 'error'`.
 */
export function startJob(opts: StartJobOptions): ResearchJobStatusView {
  enforceCap();

  const now = Date.now();
  const job: JobRecord = {
    id: randomUUID(),
    kind: opts.kind,
    profile: opts.profile,
    query: opts.query,
    sessionId: opts.sessionId,
    status: 'queued',
    evidence: [],
    rlmNotes: [],
    partialReport: '',
    result: null,
    startedAt: now,
    updatedAt: now,
    events: [],
    subscribers: new Set<Subscriber>(),
    controller: new AbortController(),
  };
  jobs.set(job.id, job);

  const handle = makeHandle(job);
  const view = toView(job, 0);

  // Defer so the caller gets the view before any synchronous work in `run`.
  queueMicrotask(() => {
    if (isFinished(job)) return;
    job.status = 'running';
    job.updatedAt = Date.now();
    Promise.resolve()
      .then(() => opts.run(handle))
      .then((value) => {
        if (isFinished(job)) return;
        job.result = value;
        emit(job, 'result', value);
        finish(job, 'done');
      })
      .catch((err: unknown) => {
        if (isFinished(job)) return;
        if (job.controller.signal.aborted) {
          emit(job, 'cancelled', { reason: 'aborted' });
          finish(job, 'cancelled');
          return;
        }
        job.error = err instanceof Error ? err.message : String(err);
        emit(job, 'error', { message: job.error, code: (err as { code?: string })?.code });
        finish(job, 'error');
      });
  });

  return view;
}

/**
 * Status since `cursor`: only evidence with index >= cursor is included and
 * the returned `cursor` is the new total (monotonic — pass it back next time).
 */
export function getJobStatus(id: string, cursor = 0): ResearchJobStatusView | null {
  const job = jobs.get(id);
  return job ? toView(job, cursor) : null;
}

/** The value `run` resolved with, or null while running / on failure. */
export function getJobResult(id: string): unknown | null {
  const job = jobs.get(id);
  if (!job || job.status !== 'done') return null;
  return job.result;
}

/** Abort the job's signal and mark it cancelled. False if unknown or already finished. */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || isFinished(job)) return false;
  job.controller.abort();
  emit(job, 'cancelled', { reason: 'cancelled by client' });
  finish(job, 'cancelled');
  return true;
}

/** Jobs, newest first; optionally only those started by `sessionId`. */
export function listJobs(sessionId?: string): ResearchJobStatusView[] {
  return [...jobs.values()]
    .filter((j) => !sessionId || j.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => toView(j, j.evidence.length));
}

/** Replay events with `seq >= fromSeq`, in order. */
export function readEvents(id: string, fromSeq = 0): ResearchJobEvent[] {
  const job = jobs.get(id);
  if (!job) return [];
  return job.events.slice(Math.max(0, fromSeq));
}

/** Tail new events. Returns an unsubscribe function. */
export function subscribe(id: string, cb: Subscriber): () => void {
  const job = jobs.get(id);
  if (!job) return () => {};
  job.subscribers.add(cb);
  return () => { job.subscribers.delete(cb); };
}

/** Whether a job has reached a terminal status (unknown ids count as finished). */
export function isJobFinished(id: string): boolean {
  const job = jobs.get(id);
  return !job || isFinished(job);
}

/** Validate an untrusted `kind` path segment. */
export function parseJobKind(v: unknown): ResearchJobKind | null {
  return v === 'research' || v === 'report' ? v : null;
}

/** Test hook — drop every job and timer. */
export function _resetJobsForTests(): void {
  for (const job of jobs.values()) {
    if (job.evictTimer) clearTimeout(job.evictTimer);
    job.subscribers.clear();
  }
  jobs.clear();
}
