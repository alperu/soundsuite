'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MCPResultRendererProps {
  toolName: string;
  data: any;
  executionTimeMs: number;
  resultCount: number;
}

export function MCPResultRenderer({ toolName, data, executionTimeMs, resultCount }: MCPResultRendererProps) {
  const [showRaw, setShowRaw] = useState(false);

  const renderMetrics = () => (
    <div className="flex items-center gap-4 mb-4 text-sm">
      <span className="text-gray-500">Time: <strong className="text-gray-900">{executionTimeMs.toFixed(0)}ms</strong></span>
      <span className="text-gray-500">Results: <strong className="text-gray-900">{resultCount}</strong></span>
      <button onClick={() => setShowRaw(!showRaw)} className="ml-auto text-xs text-blue-600 hover:underline">
        {showRaw ? 'Structured View' : 'Show Raw'}
      </button>
    </div>
  );

  // If the LLM returned markdown instead of JSON, render it directly
  if (data?._markdown) {
    return (
      <div>
        {renderMetrics()}
        <div className="bg-amber-50 border border-amber-200 rounded px-3 py-1.5 mb-3 text-xs text-amber-700">
          The AI returned a text response instead of structured data. Showing as markdown.
        </div>
        {showRaw ? (
          <pre className="bg-gray-50 rounded-lg p-4 text-xs overflow-x-auto max-h-[500px] overflow-y-auto whitespace-pre-wrap">
            {data._markdown}
          </pre>
        ) : (
          <div className="prose prose-sm max-w-none prose-headings:text-gray-900 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-900">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data._markdown}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  if (showRaw) {
    return (
      <div>
        {renderMetrics()}
        <pre className="bg-gray-50 rounded-lg p-4 text-xs overflow-x-auto max-h-[500px] overflow-y-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  }

  // Tools return results under different keys — normalize to a single array
  const RESULT_KEY_MAP: Record<string, string> = {
    detect_contradictions: 'contradictions',
    track_claim_evolution: 'evolution',
    reconstruct_timeline: 'events',
    extract_obligations: 'obligations',
    extract_entities: 'entities',
    analyze_citations: 'citations',
  };
  const resultKey = RESULT_KEY_MAP[toolName] || 'results';
  const results = data?.[resultKey] ?? data?.results;

  // query_case_knowledge -> table with score bar
  if (toolName === 'query_case_knowledge' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-3">Document</th>
                <th className="py-2 pr-3 w-16">Page</th>
                <th className="py-2 pr-3 w-28">Score</th>
                <th className="py-2">Text</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium text-gray-900 whitespace-nowrap">{r.document}</td>
                  <td className="py-2 pr-3 text-gray-600">{r.page}</td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(r.score * 100).toFixed(0)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-10 text-right">{(r.score * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="py-2 text-gray-600 text-xs max-w-md">
                    <details>
                      <summary className="cursor-pointer truncate">{r.text?.slice(0, 80)}...</summary>
                      <p className="mt-1 whitespace-pre-wrap">{r.text}</p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // scan_for_pattern -> table with highlighted match
  if (toolName === 'scan_for_pattern' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-3">Match</th>
                <th className="py-2 pr-3">Document</th>
                <th className="py-2 pr-3 w-16">Page</th>
                <th className="py-2">Context</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2 pr-3">
                    <span className="bg-yellow-100 text-yellow-800 px-1 rounded font-mono text-xs">{r.match}</span>
                  </td>
                  <td className="py-2 pr-3 font-medium text-gray-900 whitespace-nowrap">{r.document}</td>
                  <td className="py-2 pr-3 text-gray-600">{r.page}</td>
                  <td className="py-2 text-gray-600 text-xs max-w-md">
                    <details>
                      <summary className="cursor-pointer truncate">{r.text?.slice(0, 80)}...</summary>
                      <p className="mt-1 whitespace-pre-wrap">{r.text}</p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // retrieve_exhibit -> card grid
  if (toolName === 'retrieve_exhibit' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {results.map((r: any, i: number) => (
            <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
              {r.imagePath && (
                <div className="bg-gray-100 p-2">
                  <img src={r.imagePath} alt="Exhibit" className="max-h-48 mx-auto object-contain" />
                </div>
              )}
              <div className="p-3 space-y-1">
                <p className="text-sm font-medium text-gray-900">{r.document} — p.{r.page}</p>
                <p className="text-xs text-gray-600 line-clamp-3">{r.ocrText}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // detect_contradictions -> cards with severity
  if (toolName === 'detect_contradictions' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="space-y-3">
          {results.map((r: any, i: number) => (
            <div key={i} className="border border-red-200 rounded-lg p-4 bg-red-50/30">
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  r.severity === 'high' ? 'bg-red-100 text-red-700' :
                  r.severity === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-700'
                }`}>{r.severity || 'unknown'}</span>
                {r.confidence && <span className="text-xs text-gray-500">Confidence: {(r.confidence * 100).toFixed(0)}%</span>}
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-white rounded p-2 border border-gray-200">
                  <p className="text-xs text-gray-500 mb-1">Statement A</p>
                  <p className="text-gray-700">{r.statementA || r.statement1}</p>
                </div>
                <div className="bg-white rounded p-2 border border-gray-200">
                  <p className="text-xs text-gray-500 mb-1">Statement B</p>
                  <p className="text-gray-700">{r.statementB || r.statement2}</p>
                </div>
              </div>
              {r.explanation && <p className="text-xs text-gray-600 mt-2">{r.explanation}</p>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // track_claim_evolution -> vertical timeline
  if (toolName === 'track_claim_evolution' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="relative pl-6 space-y-4">
          <div className="absolute left-2 top-0 bottom-0 w-0.5 bg-gray-200" />
          {results.map((r: any, i: number) => (
            <div key={i} className="relative">
              <div className="absolute -left-4 top-1 w-3 h-3 rounded-full bg-blue-500 border-2 border-white" />
              <div className="bg-white border border-gray-200 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  {r.date && <span className="text-xs font-medium text-gray-900">{r.date}</span>}
                  {r.classification && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700">{r.classification}</span>
                  )}
                </div>
                <p className="text-sm text-gray-700">{r.text || r.claim || r.statement}</p>
                {(r.delta || r.change) && <p className="text-xs text-gray-500 mt-1">Change: {r.delta || r.change}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // reconstruct_timeline -> chronological list
  if (toolName === 'reconstruct_timeline' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="space-y-2">
          {results.map((r: any, i: number) => (
            <div key={i} className={`flex items-start gap-3 p-2 rounded ${r.anomaly ? 'bg-amber-50 border border-amber-200' : 'bg-white border border-gray-100'}`}>
              <span className="text-xs font-mono text-gray-500 whitespace-nowrap pt-0.5">{r.date || '—'}</span>
              <div>
                <p className="text-sm text-gray-800">{r.event || r.description}</p>
                {r.source && <p className="text-xs text-gray-400">{r.source}</p>}
              </div>
              {r.anomaly && <span className="ml-auto px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">anomaly</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // extract_obligations -> table
  if (toolName === 'extract_obligations' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-3">Obligation</th>
                <th className="py-2 pr-3">Party</th>
                <th className="py-2 pr-3">Deadline</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2 pr-3 text-gray-900">{r.obligation || r.description || r.text}</td>
                  <td className="py-2 pr-3 text-gray-600">{r.party || '—'}</td>
                  <td className="py-2 pr-3 text-gray-600">{r.deadline || '—'}</td>
                  <td className="py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      r.status === 'met' ? 'bg-green-100 text-green-700' :
                      r.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                      r.status === 'overdue' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>{r.status || '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // extract_entities -> grouped tags
  if (toolName === 'extract_entities' && Array.isArray(results)) {
    const grouped = new Map<string, string[]>();
    for (const r of results) {
      const type = r.type || r.entityType || 'other';
      const list = grouped.get(type) || [];
      list.push(r.name || r.text || r.entity);
      grouped.set(type, list);
    }
    return (
      <div>
        {renderMetrics()}
        <div className="space-y-3">
          {Array.from(grouped).map(([type, entities]) => (
            <div key={type}>
              <h4 className="text-xs font-medium text-gray-500 uppercase mb-1">{type}</h4>
              <div className="flex flex-wrap gap-1.5">
                {entities.map((e, i) => (
                  <span key={i} className="px-2 py-0.5 bg-green-50 text-green-700 rounded-full text-xs">{e}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // analyze_citations -> table
  if (toolName === 'analyze_citations' && Array.isArray(results)) {
    return (
      <div>
        {renderMetrics()}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-3">Citation</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Context</th>
                <th className="py-2">Validity</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-mono text-xs text-gray-900">{r.citation}</td>
                  <td className="py-2 pr-3 text-gray-600">{r.source || '—'}</td>
                  <td className="py-2 pr-3 text-gray-600 text-xs max-w-xs truncate">{r.context || '—'}</td>
                  <td className="py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      r.valid === true ? 'bg-green-100 text-green-700' :
                      r.valid === false ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>{r.valid === true ? 'Valid' : r.valid === false ? 'Invalid' : 'Unknown'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Default fallback -> formatted JSON
  return (
    <div>
      {renderMetrics()}
      <pre className="bg-gray-50 rounded-lg p-4 text-xs overflow-x-auto max-h-[500px] overflow-y-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
