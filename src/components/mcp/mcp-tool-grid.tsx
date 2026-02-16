'use client';

import { useState } from 'react';
import { MCPToolCard } from './mcp-tool-card';
import { MCPCategoryBadge } from './mcp-category-badge';

// ToolCardData shape (same as in mcp-tool-card)
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

interface MCPToolGridProps {
  tools: ToolCardData[];
  selectedTool: string | null;
  onSelectTool: (toolName: string) => void;
  onToggleTool: (toolName: string, enabled: boolean) => void;
}

const CATEGORY_ORDER = ['search', 'contradiction', 'argument', 'timeline', 'entity', 'review'];

export function MCPToolGrid({ tools, selectedTool, onSelectTool, onToggleTool }: MCPToolGridProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Group tools by category
  const grouped = new Map<string, ToolCardData[]>();
  for (const cat of CATEGORY_ORDER) {
    grouped.set(cat, []);
  }
  for (const tool of tools) {
    const list = grouped.get(tool.category) || [];
    list.push(tool);
    grouped.set(tool.category, list);
  }

  const toggleCategory = (cat: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {CATEGORY_ORDER.map((cat) => {
        const catTools = grouped.get(cat) || [];
        if (catTools.length === 0) return null;
        const isCollapsed = collapsed.has(cat);
        const enabledCount = catTools.filter(t => t.enabled).length;

        return (
          <div key={cat}>
            <button
              onClick={() => toggleCategory(cat)}
              className="w-full flex items-center justify-between py-2 px-1 text-left group"
            >
              <div className="flex items-center gap-2">
                <svg className={`w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <MCPCategoryBadge category={cat} />
                <span className="text-xs text-gray-400">{enabledCount}/{catTools.length} enabled</span>
              </div>
            </button>
            {!isCollapsed && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                {catTools.map(tool => (
                  <MCPToolCard
                    key={tool.name}
                    tool={tool}
                    selected={selectedTool === tool.name}
                    onSelect={onSelectTool}
                    onToggle={onToggleTool}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
