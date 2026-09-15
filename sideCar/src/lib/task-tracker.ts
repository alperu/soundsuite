import { processGlobal } from './process-global';
import { createLogger } from './logger';

/**
 * Task Tracker — Lightweight in-memory tracker for long-running sidecar operations.
 *
 * Surfaces real-time progress for image pulls, model pulls, and VRAM loads
 * through the existing heartbeat pipeline to both sidecar UI and admin UI.
 *
 * ## Stale sweep
 *
 * Nothing used to reap a task that never settles. A promise that hangs (a
 * dropped Ollama connection mid-load, a container that vanishes under a pull)
 * left its task in `G.active` as "running" forever — the Active Tasks panel
 * then shows the same load "In progress..." indefinitely, which is exactly
 * what made the duplicate-load bug (handlers.ts fireAndForgetLoad — the
 * `modelLoading` guard used to be released before a scheduled retry) visible
 * as several identical rows rather than one that eventually failed and
 * cleared. Follows the lease sweeper's shape (leases.ts): a TTL measured
 * from the task's last activity (not just its start — a slow multi-GB pull
 * that is still reporting progress every few seconds is not stale), a
 * periodic sweep, and `unref()` on the timer so it never holds the process
 * open.
 */

export interface Task {
  id: string;
  type: 'image-pull' | 'model-pull' | 'model-load' | 'provision';
  label: string;
  role?: string;
  status: 'running' | 'completed' | 'failed';
  progress?: number;    // 0-100, undefined = indeterminate
  detail?: string;      // e.g. "Downloading layer 3/8  1.2GB/2.4GB"
  startedAt: number;
  completedAt?: number;
  error?: string;
  /** ms epoch of the last start/update — what the stale sweep measures
   *  against, so an actively-progressing task is never reaped mid-flight. */
  lastActivityAt: number;
}

const log = createLogger('task-tracker');

let nextId = 1;
const G = processGlobal('task-tracker', () => ({
  active: new Map<string, Task>(),
  history: [] as Task[],
  sweepTimer: null as ReturnType<typeof setInterval> | null,
}));
const MAX_HISTORY = 50;
const SWEEP_INTERVAL_MS = 60_000;
/** The load timeout is 120s; this is generous headroom above any legitimate
 *  single attempt while still bounding a hung promise to a finite window. */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

function staleMs(): number {
  const raw = parseInt(process.env.SS_TASK_STALE_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_STALE_MS;
}

function genId(): string {
  return `task-${nextId++}`;
}

function archive(task: Task): void {
  G.history.push(task);
  if (G.history.length > MAX_HISTORY) G.history.shift();
}

export function start(type: Task['type'], label: string, role?: string): string {
  const id = genId();
  const now = Date.now();
  G.active.set(id, {
    id,
    type,
    label,
    role,
    status: 'running',
    startedAt: now,
    lastActivityAt: now,
  });
  startSweeper();
  return id;
}

export function update(id: string, patch: { progress?: number; detail?: string }): void {
  const task = G.active.get(id);
  if (!task) return;
  if (patch.progress !== undefined) task.progress = patch.progress;
  if (patch.detail !== undefined) task.detail = patch.detail;
  task.lastActivityAt = Date.now();
}

export function complete(id: string): void {
  const task = G.active.get(id);
  if (!task) return;
  task.status = 'completed';
  task.completedAt = Date.now();
  task.progress = 100;
  G.active.delete(id);
  archive(task);
}

export function fail(id: string, error: string): void {
  const task = G.active.get(id);
  if (!task) return;
  task.status = 'failed';
  task.completedAt = Date.now();
  task.error = error;
  G.active.delete(id);
  archive(task);
}

/** Return all active tasks + recent history (last 10 completed/failed). */
export function getAll(): Task[] {
  const recentHistory = G.history.slice(-10);
  return [...Array.from(G.active.values()), ...recentHistory];
}

/** Return only active (running) tasks. */
export function getActive(): Task[] {
  return Array.from(G.active.values());
}

/**
 * Reap tasks whose last activity is older than the stale TTL — a promise
 * that never resolves (dropped connection, vanished container) otherwise
 * shows as "running" forever. Marks them failed and archives them, exactly
 * like a real `fail()` call, so every consumer (Active Tasks panel,
 * `hasActiveTask` guards in containers.ts/handlers.ts) sees the role as free
 * again instead of permanently "busy".
 */
export function sweepStaleTasks(): number {
  const ttl = staleMs();
  if (ttl === 0) return 0;
  const cutoff = Date.now() - ttl;
  const stale = [...G.active.values()].filter((t) => t.lastActivityAt < cutoff);
  if (stale.length === 0) return 0;
  for (const task of stale) {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.error = `Stale — no activity for ${Math.round(ttl / 1000)}s; reaped by the sweep`;
    G.active.delete(task.id);
    archive(task);
  }
  log.warn(
    `Reaped ${stale.length} stale task(s) older than ${ttl / 1000}s: ` +
    `${stale.map((t) => `${t.label}${t.role ? ` (${t.role})` : ''}`).join(', ')}`,
  );
  return stale.length;
}

export function startSweeper(): void {
  if (G.sweepTimer) return;
  G.sweepTimer = setInterval(() => {
    try { sweepStaleTasks(); } catch (err) {
      log.error(`Task sweep failed: ${(err as Error).message}`);
    }
  }, SWEEP_INTERVAL_MS);
  G.sweepTimer.unref?.();
}

export function stopSweeper(): void {
  if (!G.sweepTimer) return;
  clearInterval(G.sweepTimer);
  G.sweepTimer = null;
}

/** Test seam — drops all task state without touching anything else. */
export function __resetTasksForTest(): void {
  G.active.clear();
  G.history.length = 0;
  nextId = 1;
  stopSweeper();
}

export const tasks = { start, update, complete, fail, getAll, getActive, sweepStaleTasks };
