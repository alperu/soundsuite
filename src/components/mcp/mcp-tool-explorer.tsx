'use client';

import { useState, useEffect, useCallback } from 'react';
import { MCPParamForm } from './mcp-param-form';
import { MCPResultRenderer } from './mcp-result-renderer';
import { MCPExecutionHistory } from './mcp-execution-history';
import { MCPCategoryBadge } from './mcp-category-badge';
import { MCPHealthIndicator } from './mcp-health-indicator';

interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  ready: boolean;
  readyReasons: string[];
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
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

interface MCPToolExplorerProps {
  tools: ToolInfo[];
  cases: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; fileName: string }>;
}

export function MCPToolExplorer({ tools, cases, documents }: MCPToolExplorerProps) {
  const [selectedTool, setSelectedTool] = useState<ToolInfo | null>(null);
  const [result, setResult] = useState<{ toolName: string; data: any; executionTimeMs: number; resultCount: number; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ExecutionRecord[]>([]);

  // Load execution history
  useEffect(() => {
    fetch('/api/mcp/execution-history?limit=50')
      .then(r => r.ok ? r.json() : { records: [] })
      .then(d => setHistory(d.records || []))
      .catch(() => {});
  }, []);

  // Only show enabled tools
  const enabledTools = tools.filter(t => t.enabled);

  const handleExecute = useCallback(async (params: Record<string, any>) => {
    if (!selectedTool) return;
    setLoading(true);
    const start = performance.now();

    try {
      const response = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: selectedTool.name, params }),
      });

      const executionTimeMs = performance.now() - start;
      const data = await response.json();

      if (!response.ok) {
        setResult({
          toolName: selectedTool.name,
          data: null,
          executionTimeMs,
          resultCount: 0,
          error: data.error?.message || 'Execution failed',
        });
      } else {
        const resultCount = Array.isArray(data.results) ? data.results.length : 0;
        setResult({ toolName: selectedTool.name, data, executionTimeMs, resultCount });
      }

      // Refresh history
      fetch('/api/mcp/execution-history?limit=50')
        .then(r => r.ok ? r.json() : { records: [] })
        .then(d => setHistory(d.records || []))
        .catch(() => {});
    } catch (err: any) {
      setResult({
        toolName: selectedTool.name,
        data: null,
        executionTimeMs: performance.now() - start,
        resultCount: 0,
        error: err.message || 'An error occurred',
      });
    } finally {
      setLoading(false);
    }
  }, [selectedTool]);

  const handleReplay = useCallback((toolName: string, params: Record<string, any>) => {
    const tool = enabledTools.find(t => t.name === toolName);
    if (tool) {
      setSelectedTool(tool);
      // Trigger execution after a tick so the form can update
      setTimeout(() => handleExecute(params), 0);
    }
  }, [enabledTools, handleExecute]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 overflow-auto">
        {/* Left: Tool list + params */}
        <div className="space-y-4 overflow-auto">
          {/* Tool selector */}
          <div className="bg-white rounded-lg border border-gray-200">
            <div className="p-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">Select Tool</h3>
            </div>
            <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
              {enabledTools.map(tool => (
                <button
                  key={tool.name}
                  onClick={() => { setSelectedTool(tool); setResult(null); }}
                  className={`w-full text-left px-3 py-2 transition-colors flex items-center gap-2 ${
                    selectedTool?.name === tool.name ? 'bg-blue-50 border-l-2 border-blue-500' : 'hover:bg-gray-50'
                  }`}
                >
                  <MCPHealthIndicator status={tool.ready ? 'ready' : 'not_ready'} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{tool.displayName}</p>
                    <p className="text-xs text-gray-500 truncate">{tool.description}</p>
                  </div>
                  <MCPCategoryBadge category={tool.category} />
                </button>
              ))}
            </div>
          </div>

          {/* Parameter form */}
          {selectedTool && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Parameters — {selectedTool.displayName}</h3>
              <MCPParamForm
                inputSchema={selectedTool.inputSchema}
                cases={cases}
                documents={documents}
                onExecute={handleExecute}
                loading={loading}
              />
            </div>
          )}
        </div>

        {/* Right: Results */}
        <div className="overflow-auto">
          {result ? (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              {result.error ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-red-800">Error</h3>
                  <p className="text-sm text-red-700 mt-1">{result.error}</p>
                </div>
              ) : (
                <MCPResultRenderer
                  toolName={result.toolName}
                  data={result.data}
                  executionTimeMs={result.executionTimeMs}
                  resultCount={result.resultCount}
                />
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-gray-400 text-sm">Select a tool and execute it to see results</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom: Execution history */}
      <MCPExecutionHistory records={history} onReplay={handleReplay} />
    </div>
  );
}
