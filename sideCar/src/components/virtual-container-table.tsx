'use client';

import { useEffect, useState } from 'react';
import type { VirtualContainerInfo, RoutingMode } from '@/lib/virtual-inference';

export interface VirtualMasterEntry {
  serverUrl: string;
  virtualContainers?: VirtualContainerInfo[];
}

interface VirtualContainerTableProps {
  masters?: VirtualMasterEntry[];
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function ModeBadge({ mode }: { mode: RoutingMode }) {
  const cls =
    mode === 'cloud-only' ? 'bg-purple-50 text-purple-700 border-purple-200'
    : mode === 'local-first' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {mode}
    </span>
  );
}

function StateBadge({ state, failures }: { state: VirtualContainerInfo['state']; failures: number }) {
  if (state === 'serving') {
    return (
      <span className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-medium">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        serving
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="bg-red-100 text-red-800 px-2 py-0.5 rounded text-xs font-medium" title={`${failures} failure${failures === 1 ? '' : 's'} so far`}>
        failed
      </span>
    );
  }
  return (
    <span className="bg-slate-100 text-slate-500 px-2 py-0.5 rounded text-xs font-medium">
      idle
    </span>
  );
}

/**
 * "Virtual Containers" — the sidecar's own OpenRouter-served roles. Never
 * startable/stoppable: there is no container behind a row here, only a
 * (master, role) mapping and its activity counters, so this table renders
 * NO action column at all rather than a real one with disabled buttons.
 */
export default function VirtualContainerTable({ masters }: VirtualContainerTableProps) {
  // "N ago" needs a clock, but reading Date.now() during render is impure —
  // React may re-render at any time, so the value would update unpredictably
  // (and the Next build rejects it outright). Holding it in state and ticking
  // it on an interval makes the passage of time an explicit effect, and has the
  // side benefit that ages stay fresh between status polls instead of freezing
  // until the next one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows: (VirtualContainerInfo & { masterUrl: string })[] = [];
  for (const m of masters ?? []) {
    for (const vc of m.virtualContainers ?? []) {
      rows.push({ ...vc, masterUrl: m.serverUrl });
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Virtual Containers</h2>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          No virtual containers — no master has pushed OpenRouter config.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Model</th>
                <th className="pb-2 pr-4">Mode</th>
                <th className="pb-2 pr-4">State</th>
                <th className="pb-2 pr-4">Served</th>
                <th className="pb-2 pr-4">Last served</th>
                <th className="pb-2 pr-4">Last duration</th>
                <th className="pb-2">Master</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.masterUrl}::${r.role}`} className="border-b border-slate-100 last:border-0">
                  <td className="py-3 pr-4">
                    <span className="flex items-center gap-1.5 font-medium text-slate-700">
                      {r.role}
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-indigo-50 text-indigo-700 border-indigo-200"
                        title="Served over OpenRouter — no local container backs this row"
                      >
                        virtual
                      </span>
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-slate-600 font-mono text-xs">
                    {r.model}
                    {r.provider && <span className="text-slate-400"> &middot; {r.provider}</span>}
                    {r.dims && <span className="text-slate-400"> &middot; {r.dims}d</span>}
                  </td>
                  <td className="py-3 pr-4"><ModeBadge mode={r.mode} /></td>
                  <td className="py-3 pr-4">
                    <span title={r.lastError ?? undefined}>
                      <StateBadge state={r.state} failures={r.failures} />
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-slate-600 font-mono text-xs">
                    {r.served}
                    {r.failures > 0 && <span className="text-red-500"> ({r.failures} failed)</span>}
                  </td>
                  <td className="py-3 pr-4 text-slate-500 text-xs">
                    {r.lastServedAt ? `${formatAge(now - r.lastServedAt)} ago` : <span className="text-slate-300">never</span>}
                  </td>
                  <td className="py-3 pr-4 text-slate-500 text-xs">
                    {r.lastDurationMs !== null ? formatAge(r.lastDurationMs) : <span className="text-slate-300">&mdash;</span>}
                  </td>
                  <td className="py-3 text-slate-400 text-xs font-mono" title={r.masterUrl}>
                    {r.masterUrl}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
