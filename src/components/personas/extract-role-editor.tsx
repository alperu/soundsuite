'use client';

import { CONTEXTUAL_ROLES, type ContextualRole, type ProposedRole } from './extract-types';

interface Props {
  role: ProposedRole | undefined;
  onChange(role: ProposedRole | undefined): void;
}

/**
 * Contextual-role chip editor for state C cards.
 * Shows the scope label (e.g. "Cause 12345 / MTD") and lets the user
 * toggle which contextual roles bind the Persona to that scope.
 * "Detach" removes the role binding entirely.
 */
export function ExtractRoleEditor({ role, onChange }: Props) {
  if (!role) {
    return (
      <div className="text-xs text-gray-500 italic">
        No proposed role binding.
      </div>
    );
  }

  const toggle = (tag: ContextualRole) => {
    const has = role.contextualTags.includes(tag);
    const next: ContextualRole[] = has
      ? role.contextualTags.filter(t => t !== tag)
      : [...role.contextualTags, tag];
    onChange({ ...role, contextualTags: next });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-600">
          <span className="font-medium">Proposed role:</span>{' '}
          <span className="text-gray-500">{role.scopeLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="text-xs text-red-600 hover:underline"
        >
          Detach
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CONTEXTUAL_ROLES.map(c => {
          const active = role.contextualTags.includes(c.name);
          return (
            <button
              key={c.name}
              type="button"
              onClick={() => toggle(c.name)}
              className={
                'px-2 py-0.5 rounded-full text-xs border transition-colors ' +
                (active
                  ? 'bg-purple-100 border-purple-400 text-purple-800'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50')
              }
              aria-pressed={active}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
