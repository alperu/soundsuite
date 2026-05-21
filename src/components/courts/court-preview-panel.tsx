'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getCourt, type Court } from '@/lib/courts/client';

interface Props {
  court: Court | null;
}

export function CourtPreviewPanel({ court }: Props) {
  const [detail, setDetail] = useState<Court | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!court) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getCourt(court.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(court);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [court?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!court) {
    return (
      <aside
        style={{ width: 320, minWidth: 320 }}
        className="border-l border-gray-200 bg-gray-50 flex items-center justify-center"
      >
        <p className="text-sm text-gray-400 px-4 text-center">
          Select a court to preview.
        </p>
      </aside>
    );
  }

  const c = detail || court;
  const cases = c.cases || [];

  return (
    <aside
      style={{ width: 320, minWidth: 320 }}
      className="border-l border-gray-200 bg-gray-50 flex flex-col overflow-y-auto"
    >
      <div className="p-4 border-b border-gray-200 bg-white">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{c.name}</h3>
            {c.shortName && (
              <p className="text-xs text-gray-500 mt-0.5">{c.shortName}</p>
            )}
          </div>
          <Link
            href={`/courts/${encodeURIComponent(c.id)}`}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
          >
            Open
          </Link>
        </div>
        <dl className="mt-3 text-xs space-y-1">
          <Row k="Type" v={c.courtType} />
          <Row k="Jurisdiction" v={c.jurisdictionId} mono />
          <Row k="Address" v={c.address} />
          <Row k="Phone" v={c.phone} />
          <Row k="Website" v={c.website} />
        </dl>
      </div>

      <div className="p-4 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
          Cases ({c.casesCount ?? cases.length})
        </p>
        {loading && (
          <p className="text-xs text-gray-400">Loading…</p>
        )}
        {!loading && cases.length === 0 && (
          <p className="text-xs text-gray-400">No cases reference this court yet.</p>
        )}
        <ul className="space-y-1">
          {cases.map((cs) => (
            <li key={cs.id} className="text-xs">
              <span className="text-gray-900">{cs.name}</span>
              {cs.caseNumber && (
                <span className="text-gray-500"> · {cs.caseNumber}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function Row({ k, v, mono = false }: { k: string; v: unknown; mono?: boolean }) {
  if (v == null || v === '') return null;
  return (
    <div className="flex gap-2">
      <dt className="text-gray-400 w-24 shrink-0">{k}</dt>
      <dd className={`text-gray-800 truncate ${mono ? 'font-mono' : ''}`}>{String(v)}</dd>
    </div>
  );
}
