'use client';

import { useState } from 'react';

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

interface MCPExecutionHistoryProps {
  records: ExecutionRecord[];
  onReplay: (toolName: string, params: Record<string, any>) => void;
}

export function MCPExecutionHistory({ records, onReplay }: MCPExecutionHistoryProps) {
  const [expanded, setExpanded] = useState(false);

  if (records.length === 0) return null;

  return (
    <div className="border-t border-gray-200 bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <span>Execution History ({records.length})</span>
        <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      {expanded && (
        <div className="max-h-60 overflow-y-auto border-t border-gray-100">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-1.5">Tool</th>
                <th className="px-4 py-1.5">Status</th>
                <th className="px-4 py-1.5">Time</th>
                <th className="px-4 py-1.5">Results</th>
                <th className="px-4 py-1.5">When</th>
                <th className="px-4 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-1.5 font-medium text-gray-900">{r.toolName}</td>
                  <td className="px-4 py-1.5">
                    <span className={`inline-flex w-2 h-2 rounded-full ${r.success ? 'bg-green-500' : 'bg-red-500'}`} />
                  </td>
                  <td className="px-4 py-1.5 text-gray-600">{r.executionTimeMs.toFixed(0)}ms</td>
                  <td className="px-4 py-1.5 text-gray-600">{r.resultCount}</td>
                  <td className="px-4 py-1.5 text-gray-400">{new Date(r.timestamp).toLocaleTimeString()}</td>
                  <td className="px-4 py-1.5">
                    <button
                      onClick={() => onReplay(r.toolName, r.params)}
                      className="text-blue-600 hover:underline"
                    >
                      Replay
                    </button>
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
