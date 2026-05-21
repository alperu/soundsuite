'use client';

import { useEffect, useState } from 'react';
import {
  addPersonaRole,
  searchHaystackScopes,
  type ContextualRole,
  type HaystackHit,
  type PersonRoleBinding,
  PersonasApiError,
} from '@/lib/personas/client';
import { RoleChip, ScopeChip } from './persona-chips';

const CONTEXTUAL_ROLES: ContextualRole[] = [
  'movant', 'respondent', 'plaintiff', 'defendant',
  'lawyerMovant', 'lawyerRespondent', 'lawyerPlaintiff', 'lawyerDefendant',
  'witness', 'expert',
];

interface Props {
  open: boolean;
  personaId: string;
  onClose: () => void;
  onAdded?: (b: PersonRoleBinding) => void;
}

export function PersonaRoleBindingModal({ open, personaId, onClose, onAdded }: Props) {
  const [scopeKind, setScopeKind] = useState<'case' | 'motion'>('case');
  const [scopeQ, setScopeQ] = useState('');
  const [scopeHits, setScopeHits] = useState<HaystackHit[]>([]);
  const [selectedScope, setSelectedScope] = useState<HaystackHit | null>(null);
  const [roles, setRoles] = useState<ContextualRole[]>([]);
  const [appearedOn, setAppearedOn] = useState('');
  const [withdrewOn, setWithdrewOn] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setScopeKind('case');
    setScopeQ('');
    setScopeHits([]);
    setSelectedScope(null);
    setRoles([]);
    setAppearedOn('');
    setWithdrewOn('');
    setError(null);
  }, [open]);

  // Debounced typeahead
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      searchHaystackScopes(scopeKind, scopeQ)
        .then(setScopeHits)
        .catch(() => setScopeHits([]));
    }, 200);
    return () => window.clearTimeout(id);
  }, [open, scopeKind, scopeQ]);

  if (!open) return null;

  const toggleRole = (r: ContextualRole) => {
    setRoles((cur) => cur.includes(r) ? cur.filter(x => x !== r) : [...cur, r]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedScope) {
      setError('Pick a scope (case or motion).');
      return;
    }
    if (roles.length === 0) {
      setError('Pick at least one role.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const b = await addPersonaRole(personaId, {
        scopeKind,
        scopeId: selectedScope.id,
        roles,
        appearedOn: appearedOn || null,
        withdrewOn: withdrewOn || null,
      });
      onAdded?.(b);
      onClose();
    } catch (err) {
      if (err instanceof PersonasApiError) {
        setError(err.status === 404 ? 'Backend not yet available' : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to add role');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 p-6"
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Role Binding</h3>

        {/* Scope kind tabs */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Scope</label>
          <div className="flex gap-1 mb-2">
            {(['case', 'motion'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setScopeKind(k); setSelectedScope(null); }}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  scopeKind === k
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={scopeQ}
            onChange={(e) => setScopeQ(e.target.value)}
            placeholder={`Search ${scopeKind}…`}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-1 max-h-32 overflow-y-auto border border-gray-100 rounded">
            {scopeHits.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-gray-400">No matches.</div>
            ) : (
              scopeHits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedScope(h)}
                  className={`w-full text-left px-2 py-1 text-xs hover:bg-blue-50 ${
                    selectedScope?.id === h.id ? 'bg-blue-100' : ''
                  }`}
                >
                  <span className="font-mono text-gray-400 mr-1">@{h.id}</span>
                  {h.label}
                </button>
              ))
            )}
          </div>
          {selectedScope && (
            <div className="mt-2">
              <ScopeChip kind={scopeKind} label={selectedScope.label} />
            </div>
          )}
        </div>

        {/* Roles */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Roles</label>
          <div className="flex flex-wrap gap-1.5">
            {CONTEXTUAL_ROLES.map((r) => (
              <RoleChip
                key={r}
                role={r}
                active={roles.includes(r)}
                onToggle={() => toggleRole(r)}
              />
            ))}
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Appeared on</label>
            <input
              type="date"
              value={appearedOn}
              onChange={(e) => setAppearedOn(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Withdrew on</label>
            <input
              type="date"
              value={withdrewOn}
              onChange={(e) => setWithdrewOn(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Adding…' : 'Add Binding'}
          </button>
        </div>
      </form>
    </div>
  );
}
