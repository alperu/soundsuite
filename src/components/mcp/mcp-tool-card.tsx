'use client';

import { MCPCategoryBadge } from './mcp-category-badge';
import { MCPHealthIndicator } from './mcp-health-indicator';

interface ToolCardData {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  ready: boolean;
  readyReasons: string[];
  totalExecutions: number;
}

interface MCPToolCardProps {
  tool: ToolCardData;
  selected: boolean;
  onSelect: (toolName: string) => void;
  onToggle: (toolName: string, enabled: boolean) => void;
}

export function MCPToolCard({ tool, selected, onSelect, onToggle }: MCPToolCardProps) {
  const healthStatus = !tool.enabled ? 'disabled' : tool.ready ? 'ready' : 'not_ready';
  const healthTooltip = !tool.enabled ? 'Disabled' : tool.ready ? 'Ready' : tool.readyReasons.join(', ');

  return (
    <div
      onClick={() => onSelect(tool.name)}
      className={`p-3 rounded-lg border cursor-pointer transition-all ${
        selected ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MCPHealthIndicator status={healthStatus} tooltip={healthTooltip} />
          <h3 className="text-sm font-medium text-gray-900 truncate">{tool.displayName}</h3>
        </div>
        {/* Toggle switch */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(tool.name, !tool.enabled); }}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer ${
            tool.enabled ? 'bg-blue-600' : 'bg-gray-200'
          }`}
        >
          <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
            tool.enabled ? 'translate-x-4' : 'translate-x-0'
          }`} />
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{tool.description}</p>
      <div className="flex items-center justify-between mt-2">
        <MCPCategoryBadge category={tool.category} />
        {tool.totalExecutions > 0 && (
          <span className="text-xs text-gray-400">{tool.totalExecutions} runs</span>
        )}
      </div>
    </div>
  );
}
