'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { op, gridHasError } from '@/lib/haystack-client';

/**
 * Haystack Management — the landing page for everything that reads or writes
 * the case graph through Haystack ops: the block-view editor, the ETL page,
 * and the live op catalogue (what the MCP bridge exposes, generated from the
 * same `ops` grid).
 */

interface OpRow {
  name: string;
  dis: string;
  doc?: string;
  ssExposure?: 'read' | 'write' | 'llm';
  params?: Record<string, { type: string; required?: boolean; description: string }>;
}

interface CaseSummary {
  id: string;
  name: string;
  caseNumber: string | null;
  filings: number;
  unconnected: number;
  documents: number;
  indexed: number;
  filingsWithoutEntityRow: number;
}

const EXPOSURE_STYLE: Record<string, string> = {
  read: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  write: 'bg-amber-50 text-amber-700 border-amber-200',
  llm: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  standard: 'bg-gray-50 text-gray-600 border-gray-200',
};

export default function HaystackManagementPage() {
  const [ops, setOps] = useState<OpRow[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [opsGrid, graph] = await Promise.all([op('ops'), op('ssScopeGraph')]);
        const e = gridHasError(opsGrid) ?? gridHasError(graph);
        if (e) throw new Error(e);
        if (cancelled) return;
        setOps((opsGrid.rows ?? []) as unknown as OpRow[]);
        setCases((graph.rows ?? []) as unknown as CaseSummary[]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">Haystack Management</h1>
        <p className="mt-1 text-sm text-gray-600 max-w-3xl">
          Every case, filing, tag and link in Sound Suite is reachable through Haystack ops — the
          same ops the MCP bridge exposes to an AI client. This page is the operator side of that:
          the editor for mapping by hand, the ETL page for letting a model propose the mapping, and
          the live catalogue of what the ops can do.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card
          href="/haystack-management/etl"
          title="Haystack ETL"
          body="Point the model at a folder of PDFs. It reads the captions, proposes the case, the kind and title of each filing, which motion each response answers, and a tidy folder layout — then you review and apply."
          accent="indigo"
        />
        <Card
          href="/scope?tab=editor"
          title="Block View editor"
          body="The mapping workbench: filings whose defining link is empty, with the deterministic suggestion pre-filled. Draw or confirm links by hand."
          accent="blue"
        />
        <Card
          href="/scope"
          title="Scope filtering"
          body="Select cases and filings into a search scope; cascade selection walks the links the ETL and the editor write."
          accent="gray"
        />
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Cases</h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Case</th>
                <th className="px-3 py-2 text-right font-medium">Filings</th>
                <th className="px-3 py-2 text-right font-medium">No entity row</th>
                <th className="px-3 py-2 text-right font-medium">Unconnected</th>
                <th className="px-3 py-2 text-right font-medium">Documents</th>
                <th className="px-3 py-2 text-right font-medium">Indexed</th>
                <th className="px-3 py-2 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-800">
                    <div className="font-medium">{c.name}</div>
                    {c.caseNumber && <div className="text-gray-500">{c.caseNumber}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.filings}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.filingsWithoutEntityRow}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={c.unconnected > 0 ? 'text-amber-700 font-medium' : ''}>{c.unconnected}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.documents}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.indexed}</td>
                  <td className="px-3 py-2">
                    <Link href={`/scope?tab=editor&case=${c.id}`} className="text-blue-700 hover:underline">editor</Link>
                    <span className="text-gray-300 mx-1">·</span>
                    <Link href={`/haystack-management/etl?case=${c.id}`} className="text-indigo-700 hover:underline">etl</Link>
                  </td>
                </tr>
              ))}
              {cases.length === 0 && !error && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          “Unconnected” counts filings whose defining link is empty (what a response responds to,
          what an order rules on) — the ETL worklist, not “has no ref at all”.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Op catalogue</h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Op</th>
                <th className="px-3 py-2 text-left font-medium">Exposure</th>
                <th className="px-3 py-2 text-left font-medium">Parameters</th>
                <th className="px-3 py-2 text-left font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((o) => {
                const exposure = o.ssExposure ?? 'standard';
                return (
                  <tr key={o.name} className="border-t border-gray-100 align-top">
                    <td className="px-3 py-2 font-mono text-gray-800 whitespace-nowrap">{o.name}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${EXPOSURE_STYLE[exposure]}`}>{exposure}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-600">
                      {Object.entries(o.params ?? {}).map(([k, p]) => (
                        <div key={k}>{k}{p.required ? '*' : ''}: {p.type}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-gray-700 max-w-xl">{o.doc || o.dis}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          <b>read</b> ops are exposed to both MCP profiles. <b>write</b> and <b>llm</b> ops are routed-only, and a
          write with <code>dryRun=false</code> from MCP additionally needs <code>SS_HAYSTACK_WRITE=1</code> on the server.
          Applying from this dashboard is always allowed — you are the review gate.
        </p>
      </section>
    </div>
  );
}

function Card({ href, title, body, accent }: { href: string; title: string; body: string; accent: 'indigo' | 'blue' | 'gray' }) {
  const ring = accent === 'indigo' ? 'border-indigo-200 hover:bg-indigo-50' : accent === 'blue' ? 'border-blue-200 hover:bg-blue-50' : 'border-gray-200 hover:bg-gray-50';
  return (
    <Link href={href} className={`block rounded-lg border bg-white p-4 transition-colors ${ring}`}>
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      <p className="mt-1 text-xs text-gray-600">{body}</p>
    </Link>
  );
}
