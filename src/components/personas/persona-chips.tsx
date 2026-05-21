'use client';

/**
 * Shared chip styling for the Personas pages.
 * Palette aligns with the tag-spec.ts / tag-panel.tsx convention:
 *   markers  → green
 *   refs     → blue
 *   values   → gray
 *   roles    → purple (contextual)
 */

import type { IntrinsicMarker, ContextualRole } from '@/lib/personas/client';

type ChipSize = 'xs' | 'sm';

const sizeClass: Record<ChipSize, string> = {
  xs: 'text-[10px] px-1.5 py-0.5',
  sm: 'text-[11px] px-2 py-0.5',
};

export function MarkerChip({
  marker,
  size = 'sm',
  onRemove,
  active = true,
  onToggle,
}: {
  marker: IntrinsicMarker;
  size?: ChipSize;
  onRemove?: () => void;
  active?: boolean;
  onToggle?: () => void;
}) {
  const interactive = !!onToggle;
  const base = `inline-flex items-center gap-1 rounded-full border ${sizeClass[size]}`;
  const palette = active
    ? 'bg-green-100 text-green-800 border-green-200'
    : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100';
  if (interactive) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={`${base} ${palette} transition-colors`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-gray-300'}`} />
        {marker}
      </button>
    );
  }
  return (
    <span className={`${base} ${palette}`}>
      {marker}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 text-green-700 hover:text-red-600"
          aria-label={`Remove ${marker}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

export function RoleChip({
  role,
  size = 'sm',
  onRemove,
  active = true,
  onToggle,
}: {
  role: ContextualRole;
  size?: ChipSize;
  onRemove?: () => void;
  active?: boolean;
  onToggle?: () => void;
}) {
  const base = `inline-flex items-center gap-1 rounded-full border ${sizeClass[size]}`;
  const palette = active
    ? 'bg-purple-100 text-purple-800 border-purple-200'
    : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100';
  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={`${base} ${palette} transition-colors`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-purple-500' : 'bg-gray-300'}`} />
        {role}
      </button>
    );
  }
  return (
    <span className={`${base} ${palette}`}>
      {role}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 text-purple-700 hover:text-red-600"
          aria-label={`Remove ${role}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

export function ScopeChip({
  label,
  kind,
  size = 'sm',
}: {
  label: string;
  kind: 'case' | 'motion';
  size?: ChipSize;
}) {
  const palette =
    kind === 'case'
      ? 'bg-blue-100 text-blue-800 border-blue-200'
      : 'bg-indigo-100 text-indigo-800 border-indigo-200';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${sizeClass[size]} ${palette}`}
      title={`${kind}: ${label}`}
    >
      <span className="uppercase tracking-wider text-[9px] opacity-70">{kind}</span>
      <span className="truncate max-w-[180px]">{label}</span>
    </span>
  );
}
