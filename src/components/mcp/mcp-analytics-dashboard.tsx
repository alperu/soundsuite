'use client';

import { useState, useEffect } from 'react';

interface ToolStat {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  avgExecutionTimeMs: number;
  lastExecutedAt: string | null;
}

interface ExecutionRecord {
  id: string;
  toolName: string;
  params: Record<string, any>;
  success: boolean;
  errorCode?: string;
  executionTimeMs: number;
  resultCount: number;
  timestamp: string;
}

export function MCPAnalyticsDashboard() {
  const [stats, setStats] = useState<ToolStat[]>([]);
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [statsRes, historyRes] = await Promise.all([
          fetch('/api/mcp/stats'),
          fetch('/api/mcp/execution-history?limit=20'),
        ]);
        if (statsRes.ok) setStats(await statsRes.json());
        if (historyRes.ok) {
          const data = await historyRes.json();
          setRecords(data.records || []);
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    load();
  }, []);

  if (loading) {
    return <div className="text-center py-8 text-gray-400 text-sm">Loading analytics...</div>;
  }

  const totalExec = stats.reduce((s, t) => s + t.totalExecutions, 0);
  const avgTime = stats.length > 0 ? Math.round(stats.reduce((s, t) => s + t.avgExecutionTimeMs * t.totalExecutions, 0) / (totalExec || 1)) : 0;
  const totalErrors = stats.reduce((s, t) => s + t.errorCount, 0);
  const errorRate = totalExec > 0 ? ((totalErrors / totalExec) * 100).toFixed(1) : '0';
  const activeTools = stats.filter(t => t.totalExecutions > 0).length;

  const maxExec = Math.max(...stats.map(s => s.totalExecutions), 1);
  const maxTime = Math.max(...stats.map(s => s.avgExecutionTimeMs), 1);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Executions', value: totalExec },
          { label: 'Avg Time', value: `${avgTime}ms` },
          { label: 'Error Rate', value: `${errorRate}%` },
          { label: 'Active Tools', value: activeTools },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Execution count per tool */}
      {stats.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Executions by Tool</h3>
          <div className="space-y-2">
            {stats.sort((a, b) => b.totalExecutions - a.totalExecutions).map(s => (
              <div key={s.toolName} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-44 truncate">{s.toolName}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${(s.totalExecutions / maxExec) * 100}%` }} />
                </div>
                <span className="text-xs text-gray-500 w-10 text-right">{s.totalExecutions}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Avg time per tool */}
      {stats.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Average Execution Time</h3>
          <div className="space-y-2">
            {stats.sort((a, b) => b.avgExecutionTimeMs - a.avgExecutionTimeMs).map(s => (
              <div key={s.toolName} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-44 truncate">{s.toolName}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${(s.avgExecutionTimeMs / maxTime) * 100}%` }} />
                </div>
                <span className="text-xs text-gray-500 w-14 text-right">{s.avgExecutionTimeMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent executions table */}
      {records.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Recent Executions</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-2">Tool</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Results</th>
                  <th className="px-4 py-2">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-medium text-gray-900">{r.toolName}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${
                        r.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                      }`}>
                        {r.success ? 'OK' : r.errorCode || 'Error'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-600">{r.executionTimeMs.toFixed(0)}ms</td>
                    <td className="px-4 py-2 text-gray-600">{r.resultCount}</td>
                    <td className="px-4 py-2 text-gray-400">{new Date(r.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {stats.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">No execution data yet</p>
          <p className="text-sm mt-1">Execute some tools to see analytics here</p>
        </div>
      )}
    </div>
  );
}
