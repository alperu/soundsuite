import { state } from './state';

/**
 * Record a demand sample for a role (call after activeRequests changes).
 * Pushes the current active count, prunes stale samples, recalculates peak.
 */
export function recordDemandSample(role: string): void {
  const tracker = state.peakDemand[role];
  if (!tracker) return;

  const now = Date.now();
  const count = state.perRole[role]?.activeRequests ?? 0;

  tracker.samples.push({ ts: now, count });

  // Prune samples older than the window
  const cutoff = now - tracker.windowMs;
  tracker.samples = tracker.samples.filter(s => s.ts >= cutoff);

  // Recalculate peak from remaining samples
  tracker.peak = tracker.samples.reduce((max, s) => Math.max(max, s.count), 0);
}

/**
 * Get current peak demand per role (prunes stale on read).
 * Returns Record<string, number> e.g. { embedding: 3, completion: 1, ocr: 0, reranker: 2 }
 */
export function getPeakDemand(): Record<string, number> {
  const now = Date.now();
  const result: Record<string, number> = {};

  for (const [role, tracker] of Object.entries(state.peakDemand)) {
    const cutoff = now - tracker.windowMs;
    tracker.samples = tracker.samples.filter(s => s.ts >= cutoff);
    tracker.peak = tracker.samples.reduce((max, s) => Math.max(max, s.count), 0);
    result[role] = tracker.peak;
  }

  return result;
}
