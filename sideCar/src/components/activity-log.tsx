'use client';

import { useEffect, useRef } from 'react';

interface LogEntry {
  time: string;
  message: string;
}

interface ActivityLogProps {
  entries: LogEntry[];
}

export default function ActivityLog({ entries }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Activity Log</h2>

      <div
        ref={scrollRef}
        className="max-h-52 overflow-y-auto rounded-lg bg-slate-900 p-4 font-mono text-xs leading-relaxed"
      >
        {entries.length === 0 ? (
          <p className="text-slate-500">No activity yet.</p>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="text-slate-300">
              <span className="text-slate-500">[{entry.time}]</span>{' '}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
