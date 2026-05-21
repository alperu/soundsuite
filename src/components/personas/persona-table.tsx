'use client';

import { MarkerChip } from './persona-chips';
import type { Persona } from '@/lib/personas/client';

interface Props {
  personas: Persona[];
  selectedId: string | null;
  onSelect: (p: Persona) => void;
  onOpen: (p: Persona) => void;
}

export function PersonaTable({ personas, selectedId, onSelect, onOpen }: Props) {
  if (personas.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <svg className="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6 5.87a4 4 0 10-8 0M16 3.13a4 4 0 010 7.75M12 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <p className="text-sm text-gray-600 font-medium">No personas yet.</p>
          <p className="text-xs text-gray-500 mt-1">
            Extract from a file or create one manually.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
          <tr className="text-left text-[11px] uppercase tracking-wider text-gray-500">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Markers</th>
            <th className="px-3 py-2 font-medium">Bar #</th>
            <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Juris.</th>
            <th className="px-3 py-2 font-medium text-right">Roles</th>
          </tr>
        </thead>
        <tbody>
          {personas.map((p) => {
            const selected = p.id === selectedId;
            return (
              <tr
                key={p.id}
                onClick={() => onSelect(p)}
                onDoubleClick={() => onOpen(p)}
                className={`cursor-pointer border-b border-gray-100 transition-colors ${
                  selected ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <td className="px-4 py-2 font-medium text-gray-900">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(p); }}
                    className="hover:underline hover:text-blue-700 text-left"
                  >
                    {p.displayName}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {p.markers.map((m) => (
                      <MarkerChip key={m} marker={m} size="xs" />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-gray-700 font-mono text-xs">
                  {p.barNumber || <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2 text-gray-700 text-xs">
                  {p.email || <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2 text-gray-700 text-xs">
                  {p.jurisdiction || <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[11px]">
                    {p.rolesCount ?? 0} {p.rolesCount === 1 ? 'role' : 'roles'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
