'use client';

interface ContainerConfig {
  image: string;
  model: string | null;
  port: number;
  vram: number;
  type: string;
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
  config: ContainerConfig;
  loadedModels?: LoadedModel[];
  modelOnDisk?: boolean;
  apiReady?: boolean;
}

interface ContainerTableProps {
  containers: Record<string, ContainerInfo>;
  onStart: (role: string) => void;
  onStop: (role: string) => void;
  onLoad?: (role: string) => void;
  onPull?: (role: string) => void;
  onPullAndLoad?: (role: string) => void;
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

      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">No containers configured.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Container</th>
                <th className="pb-2 pr-4">Model</th>
                <th className="pb-2 pr-4">PS</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([role, container]) => (
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
                  <td className="py-3 pr-4 text-slate-500 font-mono text-xs">
                    {container.config?.model || <span className="text-slate-300 italic">none</span>}
                  </td>
                  <td className="py-3 pr-4 text-xs">
                    {container.config?.type === 'ollama' && container.status === 'running' ? (
                      container.loadedModels && container.loadedModels.length > 0 ? (
                        <div className="flex items-center gap-1">
                          {(() => {
                            const m = container.loadedModels![0];
                            const gpuPct = m.gpuPercent ?? (m.processor === 'GPU' ? 100 : 0);
                            const isFullGpu = gpuPct >= 99;
                            const isPartial = gpuPct > 0 && gpuPct < 99;
                            const colorClass = isFullGpu ? 'text-green-700' : isPartial ? 'text-orange-600' : 'text-red-600';
                            const dotClass = isFullGpu ? 'bg-green-500' : isPartial ? 'bg-orange-400' : 'bg-red-500';
                            return (
                              <>
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} />
                                <span className={colorClass}>
                                  {container.loadedModels!.map(m => m.name).join(', ')}
                                </span>
                                <span className={`ml-1 ${isFullGpu ? 'text-slate-400' : colorClass + ' font-semibold'}`}>
                                  ({m.processor} {gpuPct}% {m.size})
                                </span>
                              </>
                            );
                          })()}
                        </div>
                      ) : container.modelOnDisk ? (
                        <div className="flex items-center gap-1 text-blue-600">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                          pulled, loading...
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-orange-600">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400" />
                          not pulled
                        </div>
                      )
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={container.status} />
                  </td>
                  <td className="py-3 space-x-1">
                    {container.status === 'running' ? (
                      <>
                        <button
                          onClick={() => onStop(role)}
                          className="bg-red-500 hover:bg-red-600 text-white rounded-md px-2 py-1 text-xs font-medium"
                        >
                          Stop
                        </button>
                        {container.config?.type === 'ollama' && container.config?.model && (
                          <>
                            {onPull && (
                              <button
                                onClick={() => onPull(role)}
                                className="bg-purple-500 hover:bg-purple-600 text-white rounded-md px-2 py-1 text-xs font-medium"
                              >
                                Pull
                              </button>
                            )}
                            {onPullAndLoad && (
                              <button
                                onClick={() => onPullAndLoad(role)}
                                className="bg-indigo-500 hover:bg-indigo-600 text-white rounded-md px-2 py-1 text-xs font-medium"
                              >
                                Pull &amp; Load
                              </button>
                            )}
                            {onLoad && (!container.loadedModels || container.loadedModels.length === 0) && (
                              <button
                                onClick={() => onLoad(role)}
                                className="bg-amber-500 hover:bg-amber-600 text-white rounded-md px-2 py-1 text-xs font-medium"
                              >
                                Load
                              </button>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => onStart(role)}
                        className="bg-blue-500 hover:bg-blue-600 text-white rounded-md px-2 py-1 text-xs font-medium"
                      >
                        Start
                      </button>
                    )}
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
