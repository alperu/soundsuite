'use client';

import { useState } from 'react';
import {
  INTRINSIC_TAGS,
  type IntrinsicTag,
} from './extract-types';

export interface ManualPersonaRow {
  displayName: string;
  barNumber?: string;
  email?: string;
  intrinsicTags: IntrinsicTag[];
}

interface Props {
  documentId?: string;
  onSubmit(rows: ManualPersonaRow[]): void;
  onCancel(): void;
  submitting?: boolean;
}

const emptyRow = (): ManualPersonaRow => ({
  displayName: '',
  barNumber: '',
  email: '',
  intrinsicTags: [],
});

/**
 * Batch manual-entry form for state D (manual-fallback).
 * Lets the operator define multiple Personas in one POST when extraction
 * returned nothing.
 */
export function ExtractManualForm({ onSubmit, onCancel, submitting }: Props) {
  const [rows, setRows] = useState<ManualPersonaRow[]>([emptyRow()]);

  const updateRow = (i: number, patch: Partial<ManualPersonaRow>) => {
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const toggleTag = (i: number, tag: IntrinsicTag) => {
    setRows(rs =>
      rs.map((r, idx) => {
        if (idx !== i) return r;
        const has = r.intrinsicTags.includes(tag);
        return {
          ...r,
          intrinsicTags: has
            ? r.intrinsicTags.filter(t => t !== tag)
            : [...r.intrinsicTags, tag],
        };
      }),
    );
  };

  const addRow = () => setRows(rs => [...rs, emptyRow()]);
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const validRows = rows.filter(r => r.displayName.trim().length > 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        No candidates auto-detected. Define personas manually below.
      </p>
      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="border border-gray-300 rounded-lg p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={row.displayName}
                  onChange={e => updateRow(i, { displayName: e.target.value })}
                  placeholder="Display name"
                  aria-label={`Display name row ${i + 1}`}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
                <input
                  type="text"
                  value={row.barNumber ?? ''}
                  onChange={e => updateRow(i, { barNumber: e.target.value })}
                  placeholder="Bar number"
                  aria-label={`Bar number row ${i + 1}`}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
                <input
                  type="email"
                  value={row.email ?? ''}
                  onChange={e => updateRow(i, { email: e.target.value })}
                  placeholder="Email"
                  aria-label={`Email row ${i + 1}`}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                aria-label={`Remove row ${i + 1}`}
                className="text-gray-400 hover:text-red-600 disabled:opacity-30 px-2 py-1"
              >
                ×
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {INTRINSIC_TAGS.map(t => {
                const active = row.intrinsicTags.includes(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => toggleTag(i, t.name)}
                    className={
                      'px-2 py-0.5 rounded-full text-xs border ' +
                      (active
                        ? 'bg-blue-100 border-blue-400 text-blue-800'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50')
                    }
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRow}
        className="text-sm text-blue-600 hover:underline"
      >
        + Add another persona
      </button>
      <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={validRows.length === 0 || submitting}
          onClick={() => onSubmit(validRows)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : `Submit batch (${validRows.length})`}
        </button>
      </div>
    </div>
  );
}
