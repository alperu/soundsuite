'use client';

import { useEffect, useState } from 'react';

interface Props {
  stages?: string[];
}

const DEFAULT_STAGES = [
  'Searching document chunks…',
  'Pattern-matching names and bar numbers…',
  'Deduplicating against existing Personas…',
];

/**
 * Spinner + rotating stage status shown in state B (extracting).
 * If `stages` is empty, falls back to canned messages on a timer.
 */
export function ExtractProgress({ stages }: Props) {
  const [tick, setTick] = useState(0);
  const labels = stages && stages.length > 0 ? stages : DEFAULT_STAGES;

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1500);
    return () => clearInterval(t);
  }, []);

  const currentIndex = stages && stages.length > 0
    ? Math.max(0, stages.length - 1)
    : tick % labels.length;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center py-12 gap-4"
    >
      <div
        className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"
        aria-hidden
      />
      <div className="text-sm text-gray-700 min-h-[1.25rem]">
        {labels[currentIndex]}
      </div>
      <ul className="text-xs text-gray-400 space-y-0.5">
        {labels.map((s, i) => (
          <li key={s} className={i === currentIndex ? 'text-gray-600' : ''}>
            {i < currentIndex ? '✓ ' : i === currentIndex ? '• ' : '  '}{s}
          </li>
        ))}
      </ul>
    </div>
  );
}
