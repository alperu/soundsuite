'use client';

import { useState, useEffect } from 'react';
import { SearchableCombo } from '../searchable-combo';

interface ParamSchema {
  type: string;
  description?: string;
  items?: { type: string };
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

interface MCPParamFormProps {
  inputSchema: {
    type: string;
    properties: Record<string, ParamSchema>;
    required: string[];
  };
  cases: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; fileName: string }>;
  onExecute: (params: Record<string, any>) => void;
  loading: boolean;
}

export function MCPParamForm({ inputSchema, cases, documents, onExecute, loading }: MCPParamFormProps) {
  const [params, setParams] = useState<Record<string, any>>({});

  // Reset params when schema changes
  useEffect(() => {
    const initial: Record<string, any> = {};
    Object.keys(inputSchema.properties).forEach(key => {
      initial[key] = '';
    });
    setParams(initial);
  }, [inputSchema]);

  const updateParam = (key: string, value: any) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === '' || value === null || value === undefined) continue;
      const schema = inputSchema.properties[key];
      if (schema?.type === 'number' || key === 'limit') {
        filtered[key] = Number(value);
      } else if (schema?.type === 'array') {
        // Parse comma-separated strings to array
        filtered[key] = typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value;
      } else {
        filtered[key] = value;
      }
    }
    onExecute(filtered);
  };

  const renderField = (key: string, schema: ParamSchema) => {
    const isRequired = inputSchema.required.includes(key);
    const label = (
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {key}
        {isRequired && <span className="text-red-500 ml-0.5">*</span>}
      </label>
    );

    // caseId -> SearchableCombo
    if (key === 'caseId') {
      const caseOptions = cases.map(c => c.name);
      const caseMap = new Map(cases.map(c => [c.name, c.id]));
      return (
        <div key={key}>
          {label}
          <SearchableCombo
            value={cases.find(c => c.id === params[key])?.name || ''}
            onChange={(name) => updateParam(key, caseMap.get(name) || '')}
            options={caseOptions}
            placeholder="Search cases..."
          />
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // documentId, documentId1, documentId2 -> SearchableCombo
    if (key.startsWith('documentId')) {
      const docOptions = documents.map(d => d.fileName);
      const docMap = new Map(documents.map(d => [d.fileName, d.id]));
      return (
        <div key={key}>
          {label}
          <SearchableCombo
            value={documents.find(d => d.id === params[key])?.fileName || ''}
            onChange={(name) => updateParam(key, docMap.get(name) || '')}
            options={docOptions}
            placeholder="Search documents..."
          />
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // confidence_threshold -> range slider
    if (key === 'confidence_threshold') {
      const val = params[key] || 0.5;
      return (
        <div key={key}>
          {label}
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={val}
              onChange={(e) => updateParam(key, parseFloat(e.target.value))}
              className="flex-1"
            />
            <span className="text-sm text-gray-600 w-10 text-right">{Number(val).toFixed(2)}</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // date inputs
    if (key.includes('date_range') || key.includes('Date') || key.includes('deadline')) {
      return (
        <div key={key}>
          {label}
          <input
            type="date"
            value={params[key] || ''}
            onChange={(e) => updateParam(key, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // limit -> number input
    if (key === 'limit' || schema.type === 'number') {
      return (
        <div key={key}>
          {label}
          <input
            type="number"
            min={schema.minimum ?? 1}
            max={schema.maximum ?? 100}
            value={params[key] || ''}
            onChange={(e) => updateParam(key, e.target.value)}
            placeholder={schema.description}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // boolean -> toggle
    if (schema.type === 'boolean') {
      return (
        <div key={key} className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-gray-700">{key}</span>
            {schema.description && <p className="text-xs text-gray-400">{schema.description}</p>}
          </div>
          <button
            type="button"
            onClick={() => updateParam(key, !params[key])}
            className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${params[key] ? 'bg-blue-600' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${params[key] ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      );
    }

    // enum -> select
    if (schema.enum) {
      return (
        <div key={key}>
          {label}
          <select
            value={params[key] || ''}
            onChange={(e) => updateParam(key, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">Select...</option>
            {schema.enum.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // query, description, claim, topic -> textarea
    if (['query', 'description', 'claim', 'topic'].includes(key)) {
      return (
        <div key={key}>
          {label}
          <textarea
            value={params[key] || ''}
            onChange={(e) => updateParam(key, e.target.value)}
            placeholder={schema.description}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
          />
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // pattern -> text input with regex indicator
    if (key === 'pattern') {
      const isValid = (() => {
        if (!params[key]) return true;
        try { new RegExp(params[key]); return true; } catch { return false; }
      })();
      return (
        <div key={key}>
          {label}
          <div className="relative">
            <input
              type="text"
              value={params[key] || ''}
              onChange={(e) => updateParam(key, e.target.value)}
              placeholder={schema.description}
              className={`w-full px-3 py-2 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono ${
                !isValid ? 'border-red-300 bg-red-50' : 'border-gray-300'
              }`}
            />
            {params[key] && (
              <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs ${isValid ? 'text-green-600' : 'text-red-600'}`}>
                {isValid ? 'valid regex' : 'invalid regex'}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
        </div>
      );
    }

    // Default text input
    return (
      <div key={key}>
        {label}
        <input
          type="text"
          value={params[key] || ''}
          onChange={(e) => updateParam(key, e.target.value)}
          placeholder={schema.description}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <p className="text-xs text-gray-400 mt-1">{schema.description}</p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {Object.entries(inputSchema.properties).map(([key, schema]) => renderField(key, schema))}
      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2.5 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Executing...' : 'Execute Tool'}
      </button>
    </div>
  );
}
