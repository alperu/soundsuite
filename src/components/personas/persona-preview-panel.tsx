'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MarkerChip, RoleChip, ScopeChip } from './persona-chips';
import {
  getPersonaRoles,
  type Persona,
  type PersonRoleBinding,
  PersonasApiError,
} from '@/lib/personas/client';

interface Props {
  persona: Persona | null;
  onClose?: () => void;
}

/**
 * Right-rail collapsible preview of a selected Persona.
 * Mirrors the chevron-collapse pattern from TagPanel.
 */
export function PersonaPreviewPanel({ persona }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [roles, setRoles] = useState<PersonRoleBinding[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!persona) {
      setRoles(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPersonaRoles(persona.id)
      .then((r) => { if (!cancelled) setRoles(r.roles || []); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PersonasApiError && err.status === 404) {
          setError('Backend not yet available');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load roles');
        }
        setRoles([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [persona?.id]);

  if (collapsed) {
    return (
      <div className="w-8 border-l border-gray-200 bg-gray-50 flex flex-col items-center py-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand preview"
          className="p-1 text-gray-400 hover:text-blue-600"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div
          className="mt-2 text-[10px] text-gray-500 uppercase tracking-wider"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Preview
        </div>
      </div>
    );
  }

  // Group bindings by case → motion
  const grouped = (roles || []).reduce<Record<string, {
    caseLabel: string;
    motions: Record<string, PersonRoleBinding[]>;
    caseLevel: PersonRoleBinding[];
  }>>((acc, b) => {
    const caseKey = b.caseId || (b.scopeKind === 'case' ? b.scopeId : '_unscoped');
    const caseLabel = b.caseLabel || (b.scopeKind === 'case' ? (b.scopeLabel || b.scopeId) : '(unknown case)');
    if (!acc[caseKey]) acc[caseKey] = { caseLabel, motions: {}, caseLevel: [] };
    if (b.scopeKind === 'motion' && b.motionId) {
      const mk = b.motionId;
      if (!acc[caseKey].motions[mk]) acc[caseKey].motions[mk] = [];
      acc[caseKey].motions[mk].push(b);
    } else {
      acc[caseKey].caseLevel.push(b);
    }
    return acc;
  }, {});

  return (
    <div className="w-80 border-l border-gray-200 bg-gray-50 flex flex-col flex-shrink-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-center gap-2">
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse"
          className="p-0.5 text-gray-400 hover:text-blue-600 flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex-1 truncate">
          Persona
        </h2>
      </div>

      {!persona ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-400 text-center">Select a persona to preview.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Identity card */}
          <div className="bg-white border-b border-gray-200 p-3">
            <div className="text-sm font-semibold text-gray-900 truncate" title={persona.displayName}>
              {persona.displayName}
            </div>
            {persona.markers.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {persona.markers.map((m) => (
                  <MarkerChip key={m} marker={m} size="xs" />
                ))}
              </div>
            )}
            <dl className="mt-2 text-[11px] text-gray-600 space-y-0.5">
              {persona.email && (
                <div className="flex gap-1"><dt className="text-gray-400 w-12">email</dt><dd className="break-all">{persona.email}</dd></div>
              )}
              {persona.barNumber && (
                <div className="flex gap-1"><dt className="text-gray-400 w-12">bar</dt><dd className="font-mono">{persona.barNumber}</dd></div>
              )}
              {persona.jurisdiction && (
                <div className="flex gap-1"><dt className="text-gray-400 w-12">juris.</dt><dd>{persona.jurisdiction}</dd></div>
              )}
            </dl>
          </div>

          {/* Bindings */}
          <div className="p-2 space-y-2">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Role bindings
            </div>
            {loading && <div className="text-xs text-gray-400 px-2 py-1">Loading…</div>}
            {error && (
              <div className="px-2 py-1.5 text-[11px] text-amber-700 bg-amber-50 rounded">
                {error}
              </div>
            )}
            {!loading && !error && Object.keys(grouped).length === 0 && (
              <div className="text-xs text-gray-400 px-2 py-1">No role bindings yet.</div>
            )}
            {Object.entries(grouped).map(([caseKey, group]) => (
              <div key={caseKey} className="bg-white border border-gray-200 rounded">
                <div className="px-2 py-1 border-b border-gray-100 text-[11px] font-medium text-gray-700 flex items-center gap-1.5">
                  <ScopeChip kind="case" label={group.caseLabel} size="xs" />
                </div>
                {group.caseLevel.length > 0 && (
                  <div className="px-2 py-1.5 border-b border-gray-100">
                    <div className="text-[10px] text-gray-400 uppercase mb-0.5">case-level</div>
                    <div className="flex flex-wrap gap-1">
                      {group.caseLevel.flatMap(b => b.roles).map((r, i) => (
                        <RoleChip key={`${caseKey}-cl-${i}-${r}`} role={r} size="xs" />
                      ))}
                    </div>
                  </div>
                )}
                {Object.entries(group.motions).map(([motionKey, bindings]) => (
                  <div key={motionKey} className="px-2 py-1.5 border-b border-gray-100 last:border-b-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <ScopeChip kind="motion" label={bindings[0].motionLabel || bindings[0].scopeLabel || motionKey} size="xs" />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {bindings.flatMap(b => b.roles).map((r, i) => (
                        <RoleChip key={`${motionKey}-${i}-${r}`} role={r} size="xs" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Detail link */}
          <div className="px-3 py-2 border-t border-gray-200 bg-white">
            <Link
              href={`/personas/${encodeURIComponent(persona.id)}`}
              className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
            >
              View full detail →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
