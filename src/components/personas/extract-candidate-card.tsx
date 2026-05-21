'use client';

import {
  INTRINSIC_TAGS,
  type ExtractCandidate,
  type IntrinsicTag,
  type ProposedRole,
} from './extract-types';
import { ExtractDedupPicker, NEW_PERSONA_VALUE } from './extract-dedup-picker';
import { ExtractRoleEditor } from './extract-role-editor';

interface Props {
  candidate: ExtractCandidate;
  onChange(next: ExtractCandidate): void;
}

/**
 * Per-candidate card in state C (reviewing).
 * Top-right "Confirm" checkbox controls inclusion in the bulk POST.
 */
export function ExtractCandidateCard({ candidate, onChange }: Props) {
  const update = <K extends keyof ExtractCandidate>(key: K, value: ExtractCandidate[K]) => {
    onChange({ ...candidate, [key]: value });
  };

  const toggleIntrinsic = (tag: IntrinsicTag) => {
    const has = candidate.intrinsicTags.includes(tag);
    const next = has
      ? candidate.intrinsicTags.filter(t => t !== tag)
      : [...candidate.intrinsicTags, tag];
    update('intrinsicTags', next);
  };

  const confirmed = candidate.confirmed !== false;
  const dedupChoice =
    candidate.dedupChoice
    ?? (candidate.dedupMatches[0]?.personaId)
    ?? NEW_PERSONA_VALUE;

  return (
    <div
      data-testid="extract-candidate-card"
      className={
        'border rounded-lg p-4 space-y-3 transition-colors ' +
        (confirmed ? 'border-gray-300 bg-white' : 'border-gray-200 bg-gray-50 opacity-70')
      }
    >
      {/* Header: name + confirm checkbox */}
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <input
            type="text"
            value={candidate.displayName}
            onChange={e => update('displayName', e.target.value)}
            placeholder="Display name"
            aria-label="Display name"
            className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={candidate.barNumber ?? ''}
              onChange={e => update('barNumber', e.target.value)}
              placeholder="Bar number"
              aria-label="Bar number"
              className="text-xs border border-gray-300 rounded px-2 py-1"
            />
            <input
              type="email"
              value={candidate.email ?? ''}
              onChange={e => update('email', e.target.value)}
              placeholder="Email"
              aria-label="Email"
              className="text-xs border border-gray-300 rounded px-2 py-1"
            />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => update('confirmed', e.target.checked)}
            aria-label={`Confirm ${candidate.displayName}`}
          />
          Confirm
        </label>
      </div>

      {/* Intrinsic marker chips */}
      <div className="space-y-1">
        <div className="text-xs font-medium text-gray-600">Markers</div>
        <div className="flex flex-wrap gap-1.5" data-testid="intrinsic-chips">
          {INTRINSIC_TAGS.map(t => {
            const active = candidate.intrinsicTags.includes(t.name);
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => toggleIntrinsic(t.name)}
                className={
                  'px-2 py-0.5 rounded-full text-xs border transition-colors ' +
                  (active
                    ? 'bg-blue-100 border-blue-400 text-blue-800'
                    : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50')
                }
                aria-pressed={active}
                data-tag={t.name}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Source quote */}
      {candidate.sourceQuote && (
        <div className="text-xs text-gray-500 italic border-l-2 border-gray-200 pl-2">
          “{candidate.sourceQuote}”
          {candidate.sourceChunkId && (
            <button
              type="button"
              className="ml-2 not-italic text-blue-600 hover:underline"
              onClick={() => {
                // v2: deep-link to document viewer scrolled to chunk
                window.open(`/documents/${candidate.sourceChunkId}`, '_blank');
              }}
            >
              Show in doc →
            </button>
          )}
        </div>
      )}

      {/* Dedup picker */}
      <ExtractDedupPicker
        matches={candidate.dedupMatches}
        value={dedupChoice}
        onChange={v => update('dedupChoice', v)}
      />

      {/* Proposed role */}
      <ExtractRoleEditor
        role={candidate.proposedRole}
        onChange={(r: ProposedRole | undefined) => update('proposedRole', r)}
      />
    </div>
  );
}
