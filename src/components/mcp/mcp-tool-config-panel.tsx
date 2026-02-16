'use client';

import { useState } from 'react';
import { MCPCategoryBadge } from './mcp-category-badge';
import { MCPToolDependencyChecker } from './mcp-tool-dependency-checker';

interface ToolDetailData {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  rateLimitPerMinute: number;
  settings: Record<string, any>;
  dependencies: Array<{ key: string; label: string; required: boolean; satisfied: boolean }>;
  ready: boolean;
  readyReasons: string[];
}

interface MCPToolConfigPanelProps {
  tool: ToolDetailData;
  onSave: (toolName: string, config: { enabled: boolean; rateLimitPerMinute: number; settings: Record<string, any> }) => void;
  onClose: () => void;
}

export function MCPToolConfigPanel({ tool, onSave, onClose }: MCPToolConfigPanelProps) {
  const [enabled, setEnabled] = useState(tool.enabled);
  const [rateLimit, setRateLimit] = useState(tool.rateLimitPerMinute);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave(tool.name, { enabled, rateLimitPerMinute: rateLimit, settings: tool.settings });
    setSaving(false);
  };

  const handleReset = () => {
    setEnabled(tool.enabled);
    setRateLimit(tool.rateLimitPerMinute);
  };

  const hasChanges = enabled !== tool.enabled || rateLimit !== tool.rateLimitPerMinute;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">{tool.displayName}</h3>
            <MCPCategoryBadge category={tool.category} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">v{tool.version}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="p-4 space-y-5">
        {/* Description */}
        <p className="text-sm text-gray-600">{tool.description}</p>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-gray-700">Enabled</label>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform mt-0.5 ${enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {/* Rate limit */}
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1">Rate Limit (per minute)</label>
          <input
            type="number"
            min={0}
            value={rateLimit}
            onChange={(e) => setRateLimit(parseInt(e.target.value) || 0)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="0 = unlimited"
          />
          <p className="text-xs text-gray-400 mt-1">Set to 0 for no rate limiting</p>
        </div>

        {/* Dependencies */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Dependencies</h4>
          <MCPToolDependencyChecker dependencies={tool.dependencies} />
        </div>

        {/* Readiness */}
        {!tool.ready && tool.readyReasons.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
            <h4 className="text-sm font-medium text-yellow-800 mb-1">Not Ready</h4>
            <ul className="text-xs text-yellow-700 space-y-0.5">
              {tool.readyReasons.map((r, i) => <li key={i}>- {r}</li>)}
            </ul>
          </div>
        )}

        {/* Save/Reset */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
