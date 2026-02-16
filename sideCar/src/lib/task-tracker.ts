/**
 * Task Tracker — Lightweight in-memory tracker for long-running sidecar operations.
 *
 * Surfaces real-time progress for image pulls, model pulls, and VRAM loads
 * through the existing heartbeat pipeline to both sidecar UI and admin UI.
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
}

let nextId = 1;
const active = new Map<string, Task>();
const history: Task[] = [];
const MAX_HISTORY = 50;

function genId(): string {
  return `task-${nextId++}`;
}

export function start(type: Task['type'], label: string, role?: string): string {
  const id = genId();
  active.set(id, {
    id,
    type,
    label,
    role,
    status: 'running',
    startedAt: Date.now(),
  });
  return id;
}

export function update(id: string, patch: { progress?: number; detail?: string }): void {
  const task = active.get(id);
  if (!task) return;
  if (patch.progress !== undefined) task.progress = patch.progress;
  if (patch.detail !== undefined) task.detail = patch.detail;
}

export function complete(id: string): void {
  const task = active.get(id);
  if (!task) return;
  task.status = 'completed';
  task.completedAt = Date.now();
  task.progress = 100;
  active.delete(id);
  history.push(task);
  if (history.length > MAX_HISTORY) history.shift();
}

export function fail(id: string, error: string): void {
  const task = active.get(id);
  if (!task) return;
  task.status = 'failed';
  task.completedAt = Date.now();
  task.error = error;
  active.delete(id);
  history.push(task);
  if (history.length > MAX_HISTORY) history.shift();
}

/** Return all active tasks + recent history (last 10 completed/failed). */
export function getAll(): Task[] {
  const recentHistory = history.slice(-10);
  return [...Array.from(active.values()), ...recentHistory];
}

/** Return only active (running) tasks. */
export function getActive(): Task[] {
  return Array.from(active.values());
}

export const tasks = { start, update, complete, fail, getAll, getActive };
