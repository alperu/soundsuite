'use client';
/**
 * Workers card on /admin/openrouter: the Workers setting (saved with the
 * page's main Save) plus live stats of the OpenRouter worker pool from
 * GET /api/openrouter/workers. Matches Fantom MCP's OpenRouterWorkersCard.
 *
 * The input is seeded from the saved config only, never from the poll, so
 * the poll cannot overwrite what the user is typing.
 */
import { useEffect, useState } from 'react';

const POLL_MS = 3_000;

export interface WorkersRange {
  min: number;
  max: number;
  def: number;
}

export const WORKERS_RANGE: WorkersRange = { min: 1, max: 8, def: 6 };

interface RoleStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  rateLimited: number;
  retried: number;
  meanMs: number;
  meanWaitMs: number;
}

export interface PoolStatsView {
  settings: { workerCount: number; interactiveSlots: number };
  bulk: { running: number; queued: number; limit: number };
  interactive: { running: number; queued: number; limit: number };
  rateLimit: { adaptiveLimit: number; hits: number; coolingDownMs: number; state: 'steady' | 'ramping' | 'backing-off' };
  lag: { p95Ms: number; maxMs: number; lagLimit: number; stepsDown: number };
  totals: { done: number; failed: number; rateLimited: number; retried: number };
  byRole: Record<string, RoleStats>;
}

/** Range problem in the typed value, or null. Blank is fine (no change). */
export function workersInputError(draft: string, r: WorkersRange = WORKERS_RANGE): string | null {
  if (draft.trim() === '') return null;
  const n = Number(draft);
  if (!Number.isInteger(n) || n < r.min || n > r.max) return `Must be a whole number from ${r.min} to ${r.max}.`;
  return null;
}

export function OpenRouterWorkersCard({
  draft,
  setDraft,
  saved,
}: {
  draft: string;
  setDraft: (v: string) => void;
  saved: number | undefined;
}) {
  const [pool, setPool] = useState<PoolStatsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/openrouter/workers');
        if (!res.ok) return;
        const body = (await res.json()) as PoolStatsView;
        if (!cancelled && body?.bulk) setPool(body);
      } catch {
        // Transient; keep the last good stats.
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const r = WORKERS_RANGE;
  const err = workersInputError(draft, r);
  const dirty = !err && draft.trim() !== '' && Number(draft) !== saved;

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">Workers</h3>
      <div>
        <label className="block text-xs text-gray-600 mb-1">
          Workers ({r.min}–{r.max})
        </label>
        <input
          type="number"
          min={r.min}
          max={r.max}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`default ${r.def}`}
          className={`w-full md:w-40 px-2 py-1.5 border rounded-md text-sm ${err ? 'border-red-400' : 'border-gray-300'}`}
        />
        <p className="text-xs text-gray-500 mt-1">
          One worker = one bulk OpenRouter request in flight (ingestion embeddings). Searches, rerank and chat use
          their own lane and never wait.
        </p>
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        {dirty && <p className="text-xs text-blue-700 mt-1">Unsaved. Press Save Settings.</p>}
      </div>

      {pool && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <MiniStat
              label="Bulk"
              value={`${pool.bulk.running}/${pool.bulk.limit} running`}
              sub={`${pool.bulk.queued} queued`}
            />
            <MiniStat
              label="Search and chat"
              value={`${pool.interactive.running}/${pool.interactive.limit} running`}
              sub={`${pool.interactive.queued} queued`}
            />
            <MiniStat
              label="Calls"
              value={`${pool.totals.done} done`}
              sub={`${pool.totals.failed} failed · ${pool.totals.retried} retried`}
              warn={pool.totals.failed > 0}
            />
            <MiniStat
              label="Rate limit (429)"
              value={`${pool.rateLimit.hits} hits · ${pool.rateLimit.state}`}
              sub={`limit ${pool.rateLimit.adaptiveLimit}${
                pool.rateLimit.coolingDownMs > 0 ? ` · cooling ${Math.ceil(pool.rateLimit.coolingDownMs / 1000)}s` : ''
              }`}
              warn={pool.rateLimit.state === 'backing-off'}
            />
            <MiniStat
              label="Event loop lag"
              value={`p95 ${Math.round(pool.lag.p95Ms)} ms`}
              sub={`max ${Math.round(pool.lag.maxMs)} ms · lag limit ${pool.lag.lagLimit}`}
              warn={pool.lag.stepsDown > 0}
            />
          </div>
          {Object.keys(pool.byRole).length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-medium py-1">Role</th>
                  <th className="text-right font-medium py-1">Running</th>
                  <th className="text-right font-medium py-1">Queued</th>
                  <th className="text-right font-medium py-1">Done</th>
                  <th className="text-right font-medium py-1">Failed</th>
                  <th className="text-right font-medium py-1">429</th>
                  <th className="text-right font-medium py-1">Mean time</th>
                  <th className="text-right font-medium py-1">Mean wait</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pool.byRole).map(([role, s]) => (
                  <tr key={role} className="border-t border-gray-100">
                    <td className="py-1 text-gray-800">{role}</td>
                    <td className="py-1 text-right">{s.running}</td>
                    <td className="py-1 text-right">{s.queued}</td>
                    <td className="py-1 text-right">{s.done}</td>
                    <td className={`py-1 text-right ${s.failed > 0 ? 'text-red-600' : ''}`}>{s.failed}</td>
                    <td className="py-1 text-right">{s.rateLimited}</td>
                    <td className="py-1 text-right">{Math.round(s.meanMs)} ms</td>
                    <td className="py-1 text-right">{Math.round(s.meanWaitMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function MiniStat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${warn ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
