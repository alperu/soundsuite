'use client';

interface StatsGridProps {
  activeRequests: number;
  mode: string;
  wsCommandCount: number;
  wsConnected: boolean;
}

export default function StatsGrid({
  activeRequests,
  mode,
  wsCommandCount,
  wsConnected,
}: StatsGridProps) {
  const cells = [
    { label: 'Active Requests', value: String(activeRequests) },
    { label: 'Mode', value: mode },
    { label: 'WS Commands', value: String(wsCommandCount) },
    { label: 'WS Connected', value: wsConnected ? 'Yes' : 'No' },
  ];

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Overview</h2>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="rounded-lg border border-slate-200 p-4 text-center"
          >
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              {cell.label}
            </p>
            <p className="mt-1 text-xl font-bold text-slate-800">{cell.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
