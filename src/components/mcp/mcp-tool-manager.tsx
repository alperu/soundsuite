'use client';

import { useState, useEffect, useCallback } from 'react';
import { MCPToolGrid } from './mcp-tool-grid';
import { MCPToolConfigPanel } from './mcp-tool-config-panel';
import { MCPToolExplorer } from './mcp-tool-explorer';
import { MCPAnalyticsDashboard } from './mcp-analytics-dashboard';

type Tab = 'manager' | 'explorer' | 'analytics';

interface ToolData {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  ready: boolean;
  readyReasons: string[];
  totalExecutions: number;
  rateLimitPerMinute: number;
  settings: Record<string, any>;
  dependencies: Array<{ key: string; label: string; required: boolean; satisfied: boolean }>;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

interface MCPToolManagerProps {
  initialTab: Tab;
  initialTools: ToolData[];
  cases: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; fileName: string }>;
}

const TAB_ITEMS: { key: Tab; label: string }[] = [
  { key: 'manager', label: 'Manager' },
  { key: 'explorer', label: 'Explorer' },
  { key: 'analytics', label: 'Analytics' },
];

export function MCPToolManager({ initialTab, initialTools, cases, documents }: MCPToolManagerProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [tools, setTools] = useState<ToolData[]>(initialTools);
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);

  const selectedTool = tools.find(t => t.name === selectedToolName) || null;

  // Update URL when tab changes
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    window.history.replaceState(null, '', `/mcp-explorer/${tab}`);
  };

  // Toggle tool enabled
  const handleToggleTool = useCallback(async (toolName: string, enabled: boolean) => {
    // Optimistic update
    setTools(prev => prev.map(t => t.name === toolName ? { ...t, enabled } : t));

    try {
      await fetch(`/api/mcp/tool-config/${toolName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      // Revert on failure
      setTools(prev => prev.map(t => t.name === toolName ? { ...t, enabled: !enabled } : t));
    }
  }, []);

  // Save tool config
  const handleSaveConfig = useCallback(async (toolName: string, config: { enabled: boolean; rateLimitPerMinute: number; settings: Record<string, any> }) => {
    try {
      const resp = await fetch(`/api/mcp/tool-config/${toolName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (resp.ok) {
        setTools(prev => prev.map(t => t.name === toolName ? { ...t, ...config } : t));
      }
    } catch { /* ignore */ }
  }, []);

  // Refresh tools from server
  const refreshTools = useCallback(async () => {
    try {
      const resp = await fetch('/api/mcp/tools');
      if (resp.ok) {
        const data = await resp.json();
        if (data.tools) setTools(data.tools);
      }
    } catch { /* ignore */ }
  }, []);

  // Periodic refresh
  useEffect(() => {
    const id = setInterval(refreshTools, 30_000);
    return () => clearInterval(id);
  }, [refreshTools]);

  return (
    <div className="flex h-full bg-gray-50">
      {/* Left nav */}
      <div className="w-44 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-sm font-bold text-gray-900">Tools</h2>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {TAB_ITEMS.map(item => (
            <button
              key={item.key}
              onClick={() => handleTabChange(item.key)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === item.key ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Center content */}
      <div className="flex-1 overflow-auto">
        <div className="p-6">
          {activeTab === 'manager' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Tool Manager</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Configure and manage MCP tools</p>
                </div>
                <div className="text-sm text-gray-400">
                  {tools.filter(t => t.enabled).length}/{tools.length} enabled
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                <div className="xl:col-span-2">
                  <MCPToolGrid
                    tools={tools}
                    selectedTool={selectedToolName}
                    onSelectTool={setSelectedToolName}
                    onToggleTool={handleToggleTool}
                  />
                </div>
                <div>
                  {selectedTool ? (
                    <MCPToolConfigPanel
                      tool={selectedTool}
                      onSave={handleSaveConfig}
                      onClose={() => setSelectedToolName(null)}
                    />
                  ) : (
                    <div className="bg-white rounded-lg border border-gray-200 p-6 text-center text-gray-400 text-sm">
                      Select a tool to view configuration
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'explorer' && (
            <div className="space-y-4">
              <div>
                <h1 className="text-xl font-bold text-gray-900">Tool Explorer</h1>
                <p className="text-sm text-gray-500 mt-0.5">Test and explore MCP tools</p>
              </div>
              <MCPToolExplorer tools={tools} cases={cases} documents={documents} />
            </div>
          )}

          {activeTab === 'analytics' && (
            <div className="space-y-4">
              <div>
                <h1 className="text-xl font-bold text-gray-900">Analytics</h1>
                <p className="text-sm text-gray-500 mt-0.5">Execution statistics and performance metrics</p>
              </div>
              <MCPAnalyticsDashboard />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
