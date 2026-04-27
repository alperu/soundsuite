'use client';

interface RoleVram {
  role: string;
  runtime: 'ollama' | 'vllm' | 'utility';
  containerStatus: string;
  loaded: boolean;
  actualMb: number;
  budgetMb: number;
  priority: 'critical' | 'high' | 'normal';
  gpuOnly: boolean;
  modes: string[];
}

export interface VramSnapshot {
  totalMb: number;
  freeMb: number;
  usedMb: number;
  unattributedMb: number;
  perRole: Record<string, RoleVram>;
  ts: number;
}

export default function VramPanel({ vram }: { vram: VramSnapshot | null | undefined }) {
  if (!vram || vram.totalMb === 0) return null;

  const usedGb = (vram.usedMb / 1024).toFixed(1);
  const totalGb = (vram.totalMb / 1024).toFixed(1);
  const freeGb = (vram.freeMb / 1024).toFixed(1);
  const pct = Math.round((vram.usedMb / vram.totalMb) * 100);
  const tight = pct >= 85;
  const barColor = tight ? 'bg-red-500' : pct >= 65 ? 'bg-orange-400' : 'bg-emerald-500';
  const loaded = Object.values(vram.perRole).filter((r) => r.loaded);

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-700">GPU VRAM</h2>
        <span className={`text-xs font-mono ${tight ? 'text-red-700 font-semibold' : 'text-slate-600'}`}>
          {usedGb} / {totalGb} GB used
          <span className="text-slate-400"> · {freeGb} GB free</span>
          <span className={tight ? 'ml-2 text-red-700' : 'ml-2 text-slate-500'}>({pct}%)</span>
          {vram.unattributedMb > 200 && (
            <span className="ml-2 text-slate-400">
              · {(vram.unattributedMb / 1024).toFixed(1)} GB unattributed
            </span>
          )}
        </span>
      </div>
      <div className="h-2 w-full rounded bg-slate-200 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {loaded.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {loaded.map((r) => {
            const tag =
              r.priority === 'critical'
                ? 'border-red-300 bg-red-50 text-red-700'
                : r.priority === 'high'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-300 bg-slate-50 text-slate-700';
            return (
              <span
                key={r.role}
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-mono ${tag}`}
                title={`${r.runtime} · ${r.priority}${r.gpuOnly ? ' · GPU-only' : ''} · modes: ${r.modes.join(',')}`}
              >
                <span className="capitalize font-medium">{r.role}</span>
                <span className="text-slate-400">{(r.actualMb / 1024).toFixed(1)}GB</span>
                {r.gpuOnly && <span className="text-red-600 font-bold">GPU</span>}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 text-xs text-slate-400">No models currently loaded.</div>
      )}
    </div>
  );
}
