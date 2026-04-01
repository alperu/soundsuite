'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useDraftStream } from '@/hooks/use-draft-stream';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  category?: string;
  description?: string;
}

interface DraftChatPanelProps {
  caseId: string;
  documentContent: string;
  selectedText: string;
  hasSelection: boolean;
  provider: string;
  model: string;
  onInsertText?: (text: string) => void;
  onReplaceSelection?: (text: string) => void;
}

export default function DraftChatPanel({
  caseId,
  documentContent,
  selectedText,
  hasSelection,
  provider,
  model,
  onInsertText,
  onReplaceSelection,
}: DraftChatPanelProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'workflows'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { send, tokens, isStreaming, result, error, abort } = useDraftStream();

  // Load workflow templates
  useEffect(() => {
    fetch('/api/workflow-templates')
      .then(r => r.json())
      .then(data => setTemplates(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tokens]);

  // When streaming completes, add assistant message
  useEffect(() => {
    if (result?.text) {
      setMessages(prev => [...prev, { role: 'assistant', content: result.text }]);
    }
  }, [result]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const query = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: query }]);

    const history = messages.map(m => ({ role: m.role, content: m.content }));

    await send('/api/draft/chat', {
      query,
      caseId: caseId || undefined,
      documentContent: documentContent.slice(0, 12000),
      selectedText: hasSelection ? selectedText : undefined,
      history: history.slice(-10),
      provider,
      model,
    });
  }, [input, isStreaming, messages, caseId, documentContent, selectedText, hasSelection, provider, model, send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-gray-200 shrink-0">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex-1 px-3 py-2 text-sm font-medium ${
            activeTab === 'chat'
              ? 'text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => setActiveTab('workflows')}
          className={`flex-1 px-3 py-2 text-sm font-medium ${
            activeTab === 'workflows'
              ? 'text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Workflows
        </button>
      </div>

      {activeTab === 'chat' ? (
        <>
          {/* Selection indicator */}
          {hasSelection && (
            <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-600 flex items-center gap-1.5 shrink-0">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              Editing selected text
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {messages.length === 0 && !isStreaming && (
              <div className="text-xs text-gray-400 text-center py-8">
                Ask questions about your document or case.
                {hasSelection ? ' Selected text will be used as context.' : ''}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {m.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                      {/* Action buttons for assistant messages */}
                      <div className="flex gap-1.5 mt-2 pt-2 border-t border-gray-200 not-prose">
                        {onInsertText && (
                          <button
                            onClick={() => onInsertText(m.content)}
                            className="text-[11px] px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 text-gray-700"
                          >
                            Insert
                          </button>
                        )}
                        {onReplaceSelection && hasSelection && (
                          <button
                            onClick={() => onReplaceSelection(m.content)}
                            className="text-[11px] px-2 py-0.5 rounded bg-blue-100 hover:bg-blue-200 text-blue-700"
                          >
                            Replace Selection
                          </button>
                        )}
                        <button
                          onClick={() => navigator.clipboard.writeText(m.content)}
                          className="text-[11px] px-2 py-0.5 rounded bg-gray-200 hover:bg-gray-300 text-gray-700"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
            {/* Streaming indicator */}
            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown>{tokens || '...'}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="text-xs text-red-500 px-2 py-1 bg-red-50 rounded">
                Error: {error}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2 border-t border-gray-200 shrink-0">
            <div className="flex gap-1.5">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={hasSelection ? 'Ask about selected text...' : 'Ask about your document...'}
                className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md resize-none"
                rows={2}
              />
              <div className="flex flex-col gap-1">
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
                >
                  {isStreaming ? '...' : 'Send'}
                </button>
                {isStreaming && (
                  <button
                    onClick={abort}
                    className="px-3 py-1.5 text-sm text-red-600 border border-red-300 rounded-md hover:bg-red-50"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        /* Workflows tab */
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <label className="text-xs text-gray-500 font-medium mb-1 block">Document Workflow</label>
          <select
            value={selectedWorkflow}
            onChange={e => setSelectedWorkflow(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md bg-white mb-3"
          >
            <option value="">Select a workflow...</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>
                {t.name} {t.category ? `(${t.category})` : ''}
              </option>
            ))}
          </select>

          {selectedWorkflow && (() => {
            const tmpl = templates.find(t => t.id === selectedWorkflow);
            if (!tmpl) return null;
            return (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">{tmpl.name}</h3>
                {tmpl.description && (
                  <p className="text-xs text-gray-500">{tmpl.description}</p>
                )}
                <button
                  onClick={() => {
                    setActiveTab('chat');
                    setInput(`Help me write a ${tmpl.name} for this case. Guide me through the structure and key sections.`);
                  }}
                  className="w-full px-3 py-1.5 text-sm font-medium text-blue-700 border border-blue-300 rounded-md hover:bg-blue-50"
                >
                  Start with this workflow
                </button>
              </div>
            );
          })()}

          {templates.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">
              No workflow templates found. Create them in the Workflows page.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
