'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  getPersona,
  getPersonaRoles,
  updatePersona,
  removePersonaRole,
  INTRINSIC_MARKERS,
  type IntrinsicMarker,
  type Persona,
  type PersonRoleBinding,
  PersonasApiError,
} from '@/lib/personas/client';
import { MarkerChip, RoleChip, ScopeChip } from '@/components/personas/persona-chips';
import { PersonaRoleBindingModal } from '@/components/personas/persona-role-binding-modal';
import { PersonaMergeModal } from '@/components/personas/persona-merge-modal';

export default function PersonaDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(params.id);

  const [persona, setPersona] = useState<Persona | null>(null);
  const [roles, setRoles] = useState<PersonRoleBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  // Edit draft
  const [draftName, setDraftName] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [draftBar, setDraftBar] = useState('');
  const [draftJuris, setDraftJuris] = useState('');
  const [draftMarkers, setDraftMarkers] = useState<IntrinsicMarker[]>([]);
  const [saving, setSaving] = useState(false);

  const [bindingOpen, setBindingOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([
        getPersona(id),
        getPersonaRoles(id).catch(() => ({ roles: [] as PersonRoleBinding[] })),
      ]);
      setPersona(p);
      setRoles(r.roles || []);
      setDraftName(p.displayName);
      setDraftEmail(p.email || '');
      setDraftBar(p.barNumber || '');
      setDraftJuris(p.jurisdiction || '');
      setDraftMarkers(p.markers || []);
    } catch (err) {
      if (err instanceof PersonasApiError && err.status === 404) {
        setError('Persona not found, or backend not yet available.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load persona');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleMarker = (m: IntrinsicMarker) => {
    setDraftMarkers((cur) => cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]);
  };

  const handleSave = async () => {
    if (!persona) return;
    if (!draftName.trim()) {
      showToast('Name is required');
      return;
    }
    setSaving(true);
    try {
      const updated = await updatePersona(persona.id, {
        displayName: draftName.trim(),
        email: draftEmail.trim() || null,
        barNumber: draftBar.trim() || null,
        jurisdiction: draftJuris.trim() || null,
        markers: draftMarkers,
      });
      setPersona(updated);
      setEditMode(false);
      showToast('Saved');
    } catch (err) {
      if (err instanceof PersonasApiError) {
        showToast(err.status === 404 ? 'Backend not yet available' : err.message);
      } else {
        showToast(err instanceof Error ? err.message : 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (!persona) return;
    setDraftName(persona.displayName);
    setDraftEmail(persona.email || '');
    setDraftBar(persona.barNumber || '');
    setDraftJuris(persona.jurisdiction || '');
    setDraftMarkers(persona.markers || []);
    setEditMode(false);
  };

  const handleRemoveBinding = async (b: PersonRoleBinding) => {
    if (!persona) return;
    if (!confirm('Remove this role binding?')) return;
    try {
      await removePersonaRole(persona.id, b.id);
      setRoles((cur) => cur.filter(x => x.id !== b.id));
      showToast('Removed');
    } catch (err) {
      if (err instanceof PersonasApiError) {
        showToast(err.status === 404 ? 'Backend not yet available' : err.message);
      } else {
        showToast(err instanceof Error ? err.message : 'Remove failed');
      }
    }
  };

  const handleDelete = async () => {
    if (!persona) return;
    if (!confirm(`Delete persona "${persona.displayName}"?`)) return;
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'DELETE' });
      if (res.status === 405) {
        const body = await res.json().catch(() => null);
        const msg = (body && typeof body === 'object' && 'error' in body)
          ? String((body as { error: unknown }).error)
          : 'Delete is not allowed';
        showToast(msg);
      } else if (res.ok) {
        showToast('Deleted');
        router.push('/personas');
      } else {
        showToast(`HTTP ${res.status}`);
      }
    } catch {
      showToast('Network error');
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-gray-400">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-8">
        <Link href="/personas" className="text-xs text-blue-600 hover:underline">← Personas</Link>
        <div className="mt-4 px-3 py-2 text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded">
          {error}
        </div>
      </div>
    );
  }
  if (!persona) return null;

  // Group bindings by case → motion
  const grouped = roles.reduce<Record<string, {
    caseLabel: string;
    caseLevel: PersonRoleBinding[];
    motions: Record<string, PersonRoleBinding[]>;
  }>>((acc, b) => {
    const caseKey = b.caseId || (b.scopeKind === 'case' ? b.scopeId : '_unscoped');
    const caseLabel = b.caseLabel || (b.scopeKind === 'case' ? (b.scopeLabel || b.scopeId) : '(unknown case)');
    if (!acc[caseKey]) acc[caseKey] = { caseLabel, caseLevel: [], motions: {} };
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
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs">
        <Link href="/personas" className="text-blue-600 hover:underline">← Personas</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-500 font-mono">@{persona.id}</span>
      </div>

      {/* Header card */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            {editMode ? (
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="text-xl font-semibold text-gray-900 w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <h1 className="text-xl font-semibold text-gray-900 break-words">{persona.displayName}</h1>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {INTRINSIC_MARKERS.map((m) => {
                const active = (editMode ? draftMarkers : persona.markers).includes(m);
                if (!editMode && !active) return null;
                return (
                  <MarkerChip
                    key={m}
                    marker={m}
                    active={active}
                    onToggle={editMode ? () => toggleMarker(m) : undefined}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {editMode ? (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditMode(true)}
                className="px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded border border-gray-200 transition-colors"
              >
                Edit
              </button>
            )}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="Email" editing={editMode}
            display={persona.email}
            input={<input type="email" value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />}
          />
          <Field label="Bar number" editing={editMode}
            display={persona.barNumber}
            mono
            input={<input type="text" value={draftBar} onChange={(e) => setDraftBar(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />}
          />
          <Field label="Jurisdiction" editing={editMode}
            display={persona.jurisdiction}
            input={<input type="text" value={draftJuris} onChange={(e) => setDraftJuris(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />}
          />
        </dl>
      </section>

      {/* Roles section */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Person Roles</h2>
          <button
            type="button"
            onClick={() => setBindingOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded border border-blue-200 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add role binding
          </button>
        </div>

        {roles.length === 0 ? (
          <div className="text-xs text-gray-400 italic px-3 py-2 bg-gray-50 rounded border border-gray-100">
            No role bindings yet. Add one to bind this persona to a case or motion with contextual roles.
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(grouped).map(([caseKey, group]) => (
              <div key={caseKey} className="bg-white border border-gray-200 rounded-lg">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                  <ScopeChip kind="case" label={group.caseLabel} />
                </div>
                {group.caseLevel.length > 0 && (
                  <div className="px-3 py-2 border-b border-gray-100">
                    <div className="text-[10px] text-gray-400 uppercase mb-1">Case-level bindings</div>
                    {group.caseLevel.map(b => (
                      <BindingRow key={b.id} b={b} onRemove={() => handleRemoveBinding(b)} />
                    ))}
                  </div>
                )}
                {Object.entries(group.motions).map(([mk, bindings]) => (
                  <div key={mk} className="px-3 py-2 border-b border-gray-100 last:border-b-0">
                    <div className="mb-1">
                      <ScopeChip kind="motion" label={bindings[0].motionLabel || bindings[0].scopeLabel || mk} size="xs" />
                    </div>
                    {bindings.map(b => (
                      <BindingRow key={b.id} b={b} onRemove={() => handleRemoveBinding(b)} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Activity placeholder */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Activity</h2>
        <div className="text-xs text-gray-400 italic px-3 py-2 bg-gray-50 rounded border border-gray-100">
          Appears in 0 documents. Link-back to source documents is v2.
        </div>
      </section>

      {/* Danger zone */}
      <section className="border border-red-200 rounded-lg bg-red-50/50">
        <div className="px-3 py-2 border-b border-red-100">
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wider">Danger Zone</h2>
        </div>
        <div className="px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-gray-700">Merge another persona INTO this one.</div>
            <button
              type="button"
              onClick={() => setMergeOpen(true)}
              className="px-3 py-1 text-xs bg-white border border-red-300 text-red-700 rounded hover:bg-red-100 transition-colors"
            >
              Merge…
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-gray-700">Delete this persona (backend currently returns 405).</div>
            <button
              type="button"
              onClick={handleDelete}
              className="px-3 py-1 text-xs bg-white border border-red-300 text-red-700 rounded hover:bg-red-100 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </section>

      {/* Modals */}
      <PersonaRoleBindingModal
        open={bindingOpen}
        personaId={persona.id}
        onClose={() => setBindingOpen(false)}
        onAdded={(b) => { setRoles((cur) => [...cur, b]); setBindingOpen(false); showToast('Binding added'); }}
      />
      <PersonaMergeModal
        open={mergeOpen}
        keep={persona}
        onClose={() => setMergeOpen(false)}
        onMerged={(p) => { setPersona(p); setMergeOpen(false); loadAll(); showToast('Merged'); }}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white text-xs px-3 py-1.5 rounded shadow-lg z-50 pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  );
}

function Field({
  label, display, editing, input, mono,
}: {
  label: string;
  display: string | null | undefined;
  editing: boolean;
  input: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className="mt-0.5">
        {editing ? input : (
          display
            ? <span className={`text-gray-800 ${mono ? 'font-mono text-xs' : ''}`}>{display}</span>
            : <span className="text-gray-300">—</span>
        )}
      </dd>
    </div>
  );
}

function BindingRow({ b, onRemove }: { b: PersonRoleBinding; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap gap-1">
          {b.roles.map((r, i) => (
            <RoleChip key={`${b.id}-${i}-${r}`} role={r} size="xs" />
          ))}
        </div>
        {(b.appearedOn || b.withdrewOn) && (
          <div className="mt-1 text-[10px] text-gray-500">
            {b.appearedOn && <>appeared {b.appearedOn}</>}
            {b.appearedOn && b.withdrewOn && <> · </>}
            {b.withdrewOn && <>withdrew {b.withdrewOn}</>}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-[10px] text-gray-400 hover:text-red-600 px-1.5 py-0.5"
        title="Remove binding"
      >
        Remove
      </button>
    </div>
  );
}
