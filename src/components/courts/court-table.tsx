'use client';

import type { Court } from '@/lib/courts/client';

interface Props {
  courts: Court[];
  selectedId: string | null;
  onSelect: (c: Court) => void;
  onOpen: (c: Court) => void;
}

export function CourtTable({ courts, selectedId, onSelect, onOpen }: Props) {
  if (!courts.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        No courts yet — click <span className="mx-1 font-medium">New Court</span> to create one.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 sticky top-0">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Name</th>
            <th className="px-3 py-2 text-left font-medium">Short</th>
            <th className="px-3 py-2 text-left font-medium">Jurisdiction</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-right font-medium">Cases</th>
          </tr>
        </thead>
        <tbody>
          {courts.map((c, idx) => {
            const isSelected = selectedId === c.id;
            const rowBg = isSelected
              ? 'bg-blue-50'
              : idx % 2 === 0
              ? 'bg-white'
              : 'bg-gray-50';
            return (
              <tr
                key={c.id}
                onClick={() => onSelect(c)}
                onDoubleClick={() => onOpen(c)}
                className={`${rowBg} hover:bg-blue-50 cursor-pointer border-b border-gray-100`}
              >
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(c);
                    }}
                    className="text-gray-900 hover:text-blue-700 hover:underline text-left"
                  >
                    {c.name}
                  </button>
                </td>
                <td className="px-3 py-2 text-gray-600">{c.shortName || '—'}</td>
                <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                  {c.jurisdictionId || '—'}
                </td>
                <td className="px-3 py-2">
                  {c.courtType ? (
                    <span className="inline-block px-1.5 py-0.5 text-[10px] rounded-full bg-gray-100 text-gray-700 capitalize">
                      {c.courtType}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-xs">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="inline-block px-1.5 py-0.5 text-[11px] rounded-full bg-blue-50 text-blue-700">
                    {c.casesCount ?? 0}
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
