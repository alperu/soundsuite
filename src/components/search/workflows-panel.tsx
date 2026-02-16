'use client';

import { useState, useEffect, useCallback } from 'react';

interface Workflow {
  id: string;
  title: string;
  status: string;
  templateId?: string | null;
  slug: string;
  createdAt: string;
}

interface WorkflowsPanelProps {
  caseId: string;
  selectedWorkflowIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

export function WorkflowsPanel({ caseId, selectedWorkflowIds, onSelectionChange }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseId) {
      setWorkflows([]);
      return;
    }

    setLoading(true);
    setError(null);
    fetch(`/api/workflows?caseId=${encodeURIComponent(caseId)}`)
      .then(r => r.json())
      .then(data => {
        setWorkflows(data.workflows || []);
      })
      .catch(err => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [caseId]);

  const toggleWorkflow = useCallback((id: string) => {
    onSelectionChange(
      selectedWorkflowIds.includes(id)
        ? selectedWorkflowIds.filter(wid => wid !== id)
        : [...selectedWorkflowIds, id]
    );
  }, [selectedWorkflowIds, onSelectionChange]);

  if (!caseId) {
    return (
      <div className="p-4 text-center py-12">
        <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
        </svg>
        <p className="text-sm text-gray-400 font-medium">Select a case</p>
        <p className="text-xs text-gray-400 mt-1">Choose a case to see available workflows</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-center py-8">
        <svg className="w-5 h-5 text-gray-400 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <p className="text-xs text-gray-400">Loading workflows...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="text-xs text-red-500">{error}</p>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="p-4 text-center py-12">
        <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <p className="text-sm text-gray-400 font-medium">No workflows</p>
        <p className="text-xs text-gray-400 mt-1">Create a workflow from the Workflows page</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-1">
      <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-2">
        {workflows.length} workflow{workflows.length !== 1 ? 's' : ''}
        {selectedWorkflowIds.length > 0 && (
          <span className="text-purple-500 ml-1">({selectedWorkflowIds.length} active)</span>
        )}
      </p>
      {workflows.map(w => {
        const isSelected = selectedWorkflowIds.includes(w.id);
        return (
          <label
            key={w.id}
            className={`flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
              isSelected ? 'bg-purple-50 border border-purple-200' : 'hover:bg-gray-50 border border-transparent'
            }`}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleWorkflow(w.id)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500 mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-medium truncate ${isSelected ? 'text-purple-800' : 'text-gray-700'}`}>
                {w.title}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {w.status}
              </p>
            </div>
          </label>
        );
      })}
      {selectedWorkflowIds.length > 0 && (
        <p className="text-[10px] text-purple-600 mt-2 px-2">
          Selected workflows will provide additional context to AI responses
        </p>
      )}
    </div>
  );
}
