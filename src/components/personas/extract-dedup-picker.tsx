'use client';

import type { DedupMatch } from './extract-types';

interface Props {
  matches: DedupMatch[];
  value: string; // personaId or "__new__"
  onChange(v: string): void;
}

export const NEW_PERSONA_VALUE = '__new__';

/**
 * Dedup-match dropdown for state C (reviewing) candidate cards.
 * Default selection is the highest-scoring match (caller controls initial value).
 */
export function ExtractDedupPicker({ matches, value, onChange }: Props) {
  if (!matches || matches.length === 0) {
    return (
      <div className="text-xs text-gray-500 italic">
        No existing Persona match — will create new.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-medium text-gray-600">Dedup:</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 bg-white"
      >
        {matches.map(m => (
          <option key={m.personaId} value={m.personaId}>
            Merge with {m.displayName} (score {m.score.toFixed(2)}, {m.matchReason})
          </option>
        ))}
        <option value={NEW_PERSONA_VALUE}>Create as new Persona</option>
      </select>
    </div>
  );
}
