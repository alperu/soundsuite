'use client';

interface ContainerConfig {
  image: string;
  model: string | null;
  port: number;
  vram: number;
  type: string;
  gpuOnly?: boolean;
}

interface LoadedModel {
  name: string;
  size: string;
  sizeBytes?: number;
  sizeVram?: number;
  gpuPercent?: number;
  processor: string;
  until: string;
}

interface ContainerInfo {
  name: string;
  status: string;
  image?: string;
  config: ContainerConfig;
  loadedModels?: LoadedModel[];
  modelOnDisk?: boolean;
  apiReady?: boolean;
}

/**
 * Display label for the runtime a container/role is using. Image-derived when
 * a container exists; falls back to a regex on the configured image when the
 * container hasn't been created yet. Mirrors the master's admin-gpu-fleet
 * implementation so both UIs stay consistent.
 */
type RuntimeLabel = 'Ollama (native)' | 'Docker Ollama' | 'Docker vLLM' | 'Docker Model Runner' | '—';

function runtimeLabel(image: string | undefined, assignmentRuntime?: string | null): RuntimeLabel {
  if (image === 'host-ollama') return 'Ollama (native)';
  if (image === 'dmr') return 'Docker Model Runner';
  if (image) {
    if (/(^|\/)vllm/i.test(image)) return 'Docker vLLM';
    if (/(^|\/)ollama/i.test(image)) return 'Docker Ollama';
  }
  if (assignmentRuntime === 'host') return 'Ollama (native)';
  if (assignmentRuntime === 'docker-vllm') return 'Docker vLLM';
  if (assignmentRuntime === 'docker-ollama') return 'Docker Ollama';
  return '—';
}

function RuntimeChip({ label }: { label: RuntimeLabel }) {
  const cls =
    label === 'Ollama (native)' ? 'bg-slate-50 text-slate-700 border-slate-200'
    : label === 'Docker Ollama' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : label === 'Docker vLLM' ? 'bg-purple-50 text-purple-700 border-purple-200'
    : label === 'Docker Model Runner' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-100 text-gray-500 border-gray-200';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

interface ContainerTableProps {
  containers: Record<string, ContainerInfo>;
  onStart: (role: string) => void;
  onStop: (role: string) => void;
  onLoad?: (role: string) => void;
  onPull?: (role: string) => void;
  onPullAndLoad?: (role: string) => void;
}

function formatVramGB(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0.0 GB';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatRelativeUntil(until?: string): string {
  if (!until) return '';
  const target = Date.parse(until);
  if (Number.isNaN(target)) {
    if (typeof until === 'string' && until.toLowerCase().includes('forever')) return 'forever';
    return '';
  }
  const ms = target - Date.now();
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function ProcessorTag({ m }: { m: LoadedModel }) {
  const proc = (m.processor || '').toUpperCase();
  const pct = m.gpuPercent;
  if (proc === 'CPU' || pct === 0) {
    return <span className="font-semibold text-red-700">{pct ?? 0}% CPU</span>;
  }
  if (proc === 'GPU' && (pct === undefined || pct >= 99)) {
    return <span className="text-green-700">{pct ?? 100}% GPU</span>;
  }
  if (pct !== undefined && pct > 0 && pct < 99) {
    return <span className="font-semibold text-amber-700">{pct}% {proc || 'MIXED'}</span>;
  }
  return <span className="text-slate-500">{proc || '—'}</span>;
}

function renderPsCell(container: ContainerInfo) {
  const type = container.config?.type;
  if (type === 'vllm') {
    return <span className="text-slate-400" title="vLLM does not expose per-model VRAM via /api/ps">—</span>;
  }
  if (type !== 'ollama' && type !== 'dmr') {
    return <span className="text-slate-300">—</span>;
  }
  if (container.status !== 'running') return <span className="text-slate-300">—</span>;
  const models = (container.loadedModels ?? []).slice().sort((a, b) => (b.sizeVram || 0) - (a.sizeVram || 0));
  if (models.length === 0) {
    if (container.modelOnDisk) {
      return (
        <div className="flex items-center gap-1 text-blue-600 text-[11px]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          pulled, loading...
        </div>
      );
    }
    const gpuOnly = container.config?.gpuOnly === true;
    return (
      <div className={`flex items-center gap-1 text-[11px] ${gpuOnly ? 'text-red-700' : 'text-orange-600'}`}>
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${gpuOnly ? 'bg-red-600' : 'bg-orange-400'}`} />
        {gpuOnly ? 'not loaded (GPU required)' : 'not loaded'}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {models.map(m => {
        const rel = formatRelativeUntil(m.until);
        return (
          <div key={m.name} className="flex items-center gap-2 whitespace-nowrap">
            <span className="font-mono text-[11px] text-slate-800">{m.name}</span>
            <span className="text-[11px] text-slate-600">{formatVramGB(m.sizeVram || m.sizeBytes)}</span>
            <ProcessorTag m={m} />
            {rel && <span className="text-[10px] text-slate-400">until {rel}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function PsSummaryLine({ containers }: { containers: Record<string, ContainerInfo> }) {
  const all: LoadedModel[] = [];
  let anyOllama = false;
  for (const c of Object.values(containers)) {
    const type = c.config?.type;
    if (type === 'ollama' || type === 'dmr') anyOllama = true;
    if (c.loadedModels) all.push(...c.loadedModels);
  }
  if (!anyOllama) return null;
  if (all.length === 0) {
    return <div className="mb-2 text-xs text-slate-500">No models loaded in VRAM.</div>;
  }
  const totalVram = all.reduce((s, m) => s + (m.sizeVram || 0), 0);
  const gpuPctAvg = Math.round(
    all.reduce((s, m) => s + (m.gpuPercent ?? (m.processor === 'GPU' ? 100 : 0)), 0) / all.length
  );
  const anyCpu = all.some(m => (m.gpuPercent ?? -1) === 0 || m.processor?.toUpperCase() === 'CPU');
  return (
    <div className="mb-3 text-xs text-slate-600">
      <span className="font-semibold">{all.length}</span> model{all.length === 1 ? '' : 's'} loaded
      <span className="mx-1.5 text-slate-300">·</span>
      <span className="font-semibold">{formatVramGB(totalVram)}</span> VRAM total
      <span className="mx-1.5 text-slate-300">·</span>
      <span className={anyCpu ? 'font-semibold text-red-700' : 'text-green-700'}>{gpuPctAvg}% GPU{anyCpu ? ' (CPU FALLBACK)' : ''}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs font-medium">
        running
      </span>
    );
  }
  if (status === 'exited') {
    return (
      <span className="bg-red-100 text-red-800 px-2 py-0.5 rounded text-xs font-medium">
        exited
      </span>
    );
  }
  return (
    <span className="bg-slate-100 text-slate-500 px-2 py-0.5 rounded text-xs font-medium">
      {status}
    </span>
  );
}

export default function ContainerTable({ containers, onStart, onStop, onLoad, onPull, onPullAndLoad }: ContainerTableProps) {
  const entries = Object.entries(containers);

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Containers</h2>
      <PsSummaryLine containers={containers} />

      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">No containers configured.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Container</th>
                <th className="pb-2 pr-4">Running On</th>
                <th className="pb-2 pr-4">Model</th>
                <th className="pb-2 pr-4">PS</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([role, container]) => {
                const imageForRuntime = container.image || container.config?.image;
                const rtLabel = runtimeLabel(imageForRuntime);
                return (
                <tr key={role} className="border-b border-slate-100 last:border-0">
                  <td className="py-3 pr-4 font-medium text-slate-700">{role}</td>
                  <td className="py-3 pr-4 text-slate-500 font-mono text-xs">
                    <span className="flex items-center gap-1.5">
                      {container.config?.type === 'ollama' && container.status === 'running' && (
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${container.loadedModels !== undefined ? 'bg-green-500' : 'bg-red-400'}`}
                          title={container.loadedModels !== undefined ? 'API reachable' : 'API unreachable'}
                        />
                      )}
                      {container.name}
                    </span>
                  </td>
                  <td className="py-3 pr-4"><RuntimeChip label={rtLabel} /></td>
                  <td className="py-3 pr-4 text-slate-500 font-mono text-xs">
                    {container.config?.model || <span className="text-slate-300 italic">none</span>}
                  </td>
                  <td className="py-3 pr-4 text-xs">
                    {renderPsCell(container)}
                  </td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={container.status} />
                  </td>
                  <td className="py-3 space-x-1">
                    {(() => {
                      // Status-aware action buttons. Mirrors the master's
                      // /admin/gpu admin-gpu-fleet panel (task #25) so the
                      // sidecar's own dashboard exposes the same controls
                      // operators are used to: Pull, Pull & Load, Load on
                      // host-runtime rows; Start on docker rows.
                      const isHostOllama = (container.image || container.config?.image) === 'host-ollama';
                      const isOllamaType = container.config?.type === 'ollama';
                      const btnStart = (
                        <button key="start" onClick={() => onStart(role)}
                          className="bg-blue-500 hover:bg-blue-600 text-white rounded-md px-2 py-1 text-xs font-medium">Start</button>
                      );
                      const btnStop = (
                        <button key="stop" onClick={() => onStop(role)}
                          className="bg-red-500 hover:bg-red-600 text-white rounded-md px-2 py-1 text-xs font-medium">Stop</button>
                      );
                      const btnPull = onPull && (
                        <button key="pull" onClick={() => onPull(role)}
                          className="bg-purple-500 hover:bg-purple-600 text-white rounded-md px-2 py-1 text-xs font-medium">Pull</button>
                      );
                      const btnPullLoad = onPullAndLoad && (
                        <button key="pullload" onClick={() => onPullAndLoad(role)}
                          className="bg-indigo-500 hover:bg-indigo-600 text-white rounded-md px-2 py-1 text-xs font-medium">Pull &amp; Load</button>
                      );
                      const btnLoad = onLoad && (
                        <button key="load" onClick={() => onLoad(role)}
                          className="bg-amber-500 hover:bg-amber-600 text-white rounded-md px-2 py-1 text-xs font-medium">Load</button>
                      );

                      // Host-Ollama runtime: no docker container to start/stop;
                      // model lifecycle is pull -> load -> running.
                      if (isHostOllama) {
                        if (container.status === 'running') return btnStop;
                        if (container.status === 'not_pulled') return <>{btnPull}{btnPullLoad}</>;
                        // 'unloaded' or any other non-running host state
                        return <>{btnLoad}{btnPullLoad}</>;
                      }

                      // Docker runtime: Start handles created/exited/not_found
                      // (drift detection from task #37 auto-recreates). Pull &
                      // Load is offered for ollama-type while running.
                      if (container.status === 'running') {
                        return (
                          <>
                            {btnStop}
                            {isOllamaType && container.config?.model && btnPullLoad}
                            {isOllamaType && container.config?.model && (!container.loadedModels || container.loadedModels.length === 0) && btnLoad}
                          </>
                        );
                      }
                      return btnStart;
                    })()}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
