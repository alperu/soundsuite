'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { op, gridHasError, firstRow } from '@/lib/haystack-client';

/**
 * Haystack ETL panel.
 *
 * Plan → review → apply, and the model never runs twice: the plan the reviewer
 * edits here is exactly the object `ssAutoIngestApply` receives. Every verdict
 * the model made shows its evidence and its confidence, and where it disagrees
 * with the deterministic detector both answers are visible, so disagreeing is
 * a glance rather than an investigation.
 *
 * Apply is two-step (dry run, then apply) and the apply button asks once more
 * inline — no browser dialog — because it moves files and writes litigation
 * records.
 */

const FILING_TYPES = [
  'Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit',
  'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree',
  "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Other',
];

const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

type Confidence = 'high' | 'medium' | 'low';

interface PlannedFile {
  path: string;
  name: string;
  relDir: string;
  size: number;
  hash: string | null;
  existing: { documentId: string; status: string; filingId: string | null; caseId: string } | null;
  detector: { filingType: string; title: string; confidence: number };
  filingType: string;
  kind: string;
  title: string;
  filedOn: string | null;
  signedOn: string | null;
  filedBy: string;
  author: string | null;
  stampEvidence: string | null;
  confidence: Confidence;
  evidence: string;
  disagreesWithDetector: boolean;
  answersTitle: string | null;
  answersPath: string | null;
  targetDir: string;
  accepted: boolean;
  readError?: string;
}

interface Plan {
  version: 1;
  createdAt: string;
  model: string;
  path: string;
  case: {
    existingCaseId: string | null;
    name: string;
    caseNumber: string | null;
    court: string | null;
    parties: string[];
    county: string | null;
    state: string | null;
    confidence: Confidence;
    evidence: string;
    disagreement: Array<{ caseNumber: string; files: string[] }>;
  };
  files: PlannedFile[];
  unplanned: Array<{ path: string; name: string }>;
  warnings: string[];
}

interface ApplyRow {
  path: string;
  name: string;
  filingType: string;
  title: string;
  movedTo: string | null;
  filing: string | null;
  filingAction: string;
  entity: string | null;
  document: string | null;
  documentAction: string;
  link: string | null;
  linkAction: string;
  warnings: string[];
}

const CONF_STYLE: Record<Confidence, string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-red-50 text-red-700 border-red-200',
};

export function EtlPanel() {
  const search = useSearchParams();
  const presetCase = search.get('case');

  const [path, setPath] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxFiles, setMaxFiles] = useState(60);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planMeta, setPlanMeta] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [organize, setOrganize] = useState(false);
  const [queue, setQueue] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ meta: Record<string, unknown>; rows: ApplyRow[]; dryRun: boolean } | null>(null);
  const [armed, setArmed] = useState(false);

  // `?case=<id>` from the landing page: prefill the path from the case row.
  useEffect(() => {
    if (!presetCase) return;
    let cancelled = false;
    op('ssScopeGraph', { caseId: presetCase, limit: 1 })
      .then((g) => {
        if (cancelled || gridHasError(g)) return;
        const p = (g.meta as { path?: string } | undefined)?.path;
        if (typeof p === 'string') setPath(p);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [presetCase]);

  const runPlan = useCallback(async () => {
    setError(null);
    setApplyResult(null);
    setArmed(false);
    setPlanning(true);
    try {
      const grid = await op('ssAutoIngestPlan', { path: path.trim(), model: model.trim() || undefined, maxFiles });
      const err = gridHasError(grid);
      if (err) throw new Error(err);
      const row = firstRow<{ plan: Plan }>(grid);
      if (!row?.plan) throw new Error('plan missing from response');
      setPlan(row.plan);
      setPlanMeta((grid.meta ?? {}) as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  }, [path, model, maxFiles]);

  const runApply = useCallback(async (dryRun: boolean) => {
    if (!plan) return;
    setError(null);
    setApplying(true);
    try {
      const grid = await op('ssAutoIngestApply', { plan, organize, queue, dryRun });
      const err = gridHasError(grid);
      if (err) throw new Error(err);
      setApplyResult({ meta: (grid.meta ?? {}) as Record<string, unknown>, rows: (grid.rows ?? []) as unknown as ApplyRow[], dryRun });
      if (!dryRun) {
        setArmed(false);
        window.dispatchEvent(new CustomEvent('entity-updated', { detail: { kind: 'batch', id: '' } }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [plan, organize, queue]);

  const updateFile = useCallback((filePath: string, patch: Partial<PlannedFile>) => {
    setPlan((prev) => prev ? { ...prev, files: prev.files.map((f) => f.path === filePath ? { ...f, ...patch } : f) } : prev);
    setApplyResult(null);
    setArmed(false);
  }, []);

  const acceptedCount = useMemo(() => plan?.files.filter((f) => f.accepted).length ?? 0, [plan]);
  const motionsByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of plan?.files ?? []) if (f.filingType === 'Motion') m.set(f.path, f.title);
    return m;
  }, [plan]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">Haystack ETL</h1>
        <p className="mt-1 text-sm text-gray-600 max-w-3xl">
          Give a folder of court PDFs. The model reads the first two pages of each, identifies the
          case from the caption, and answers what each filing is, who filed it and when (from the
          clerk&apos;s file stamp, never the signature date), names the motion each response answers,
          and proposes a folder layout. Nothing is written until you apply — and apply never re-runs
          the model.
        </p>
      </header>

      <section className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_260px_120px]">
          <label className="text-xs text-gray-600">
            Folder path on the server
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/case-folder"
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="text-xs text-gray-600">
            OpenRouter model
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="text-xs text-gray-600">
            Max files to read
            <input
              type="number"
              min={1}
              max={400}
              value={maxFiles}
              onChange={(e) => setMaxFiles(Math.max(1, Math.min(400, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={runPlan}
            disabled={planning || !path.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {planning ? 'Reading PDFs and asking the model…' : 'Plan ingestion'}
          </button>
          <span className="text-[11px] text-gray-500">
            One model call per ~8 files plus one for the case identity. Reads only; moves and writes nothing.
          </span>
        </div>
        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      </section>

      {plan && (
        <>
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-800">Case identity</h2>
                <div className="mt-1 text-sm text-gray-900">{plan.case.name}</div>
                <div className="mt-0.5 text-xs text-gray-600 space-x-2">
                  {plan.case.caseNumber && <span className="font-mono">{plan.case.caseNumber}</span>}
                  {plan.case.court && <span>· {plan.case.court}</span>}
                  {(plan.case.county || plan.case.state) && <span>· {[plan.case.county, plan.case.state].filter(Boolean).join(', ')}</span>}
                </div>
                {plan.case.parties.length > 0 && (
                  <div className="mt-1 text-xs text-gray-600">Parties: {plan.case.parties.join('; ')}</div>
                )}
                {plan.case.evidence && (
                  <div className="mt-1 text-[11px] text-gray-500 italic">“{plan.case.evidence}”</div>
                )}
              </div>
              <div className="text-right space-y-1">
                <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${CONF_STYLE[plan.case.confidence]}`}>
                  {plan.case.confidence} confidence
                </span>
                <div className="text-[11px] text-gray-500">
                  {plan.case.existingCaseId ? 'Case already registered at this path' : 'Case will be created on apply'}
                </div>
              </div>
            </div>
            {plan.case.disagreement.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                The sampled files carry different cause numbers — this folder may hold more than one case:
                <ul className="mt-1 list-disc pl-4">
                  {plan.case.disagreement.map((d) => (
                    <li key={d.caseNumber}><span className="font-mono">{d.caseNumber}</span> — {d.files.join(', ')}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.warnings.length > 0 && (
              <ul className="mt-3 space-y-1">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-800">⚠ {w}</li>
                ))}
              </ul>
            )}
            {planMeta && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
                <span>{String(planMeta.filesOnDisk)} PDFs on disk</span>
                <span>{String(planMeta.planned)} planned</span>
                <span>{String(planMeta.alreadyInDatabase)} already in database</span>
                <span>{String(planMeta.withFileStamp)} with a clerk stamp</span>
                <span>{String(planMeta.linksResolved)} links resolved</span>
                <span>{String(planMeta.linksUnresolved)} links unresolved</span>
                <span>{String(planMeta.disagreesWithDetector)} disagree with detector</span>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
              <h2 className="text-sm font-semibold text-gray-800">
                Files <span className="font-normal text-gray-500">— {acceptedCount} of {plan.files.length} accepted</span>
              </h2>
              <div className="flex gap-2 text-[11px]">
                <button className="text-blue-700 hover:underline" onClick={() => setPlan({ ...plan, files: plan.files.map((f) => ({ ...f, accepted: true })) })}>accept all</button>
                <button className="text-blue-700 hover:underline" onClick={() => setPlan({ ...plan, files: plan.files.map((f) => ({ ...f, accepted: f.confidence !== 'low' })) })}>drop low confidence</button>
                <button className="text-blue-700 hover:underline" onClick={() => setPlan({ ...plan, files: plan.files.map((f) => ({ ...f, accepted: false })) })}>clear</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-2 py-2"></th>
                    <th className="px-2 py-2 text-left font-medium">File</th>
                    <th className="px-2 py-2 text-left font-medium">Type</th>
                    <th className="px-2 py-2 text-left font-medium">Title</th>
                    <th className="px-2 py-2 text-left font-medium">Filed by</th>
                    <th className="px-2 py-2 text-left font-medium">Filed (clerk stamp)</th>
                    <th className="px-2 py-2 text-left font-medium">Answers</th>
                    <th className="px-2 py-2 text-left font-medium">Folder</th>
                    <th className="px-2 py-2 text-left font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.files.map((f) => (
                    <tr key={f.path} className={`border-t border-gray-100 align-top ${f.accepted ? '' : 'opacity-50'}`}>
                      <td className="px-2 py-2">
                        <input type="checkbox" checked={f.accepted} onChange={(e) => updateFile(f.path, { accepted: e.target.checked })} />
                      </td>
                      <td className="px-2 py-2 max-w-[220px]">
                        <div className="truncate text-gray-800" title={f.path}>{f.name}</div>
                        <div className="text-[10px] text-gray-500">{f.relDir || '(root)'} · {Math.round(f.size / 1024)} KB</div>
                        {f.existing && (
                          <div className="text-[10px] text-blue-700">in database: {f.existing.status}{f.existing.filingId ? ', filed' : ''}</div>
                        )}
                        {f.readError && <div className="text-[10px] text-red-600">{f.readError}</div>}
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={f.filingType}
                          onChange={(e) => updateFile(f.path, { filingType: e.target.value })}
                          className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                        >
                          {FILING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        {f.disagreesWithDetector && (
                          <div className="mt-0.5 text-[10px] text-amber-700" title="The regex detector read this differently">detector: {f.detector.filingType}</div>
                        )}
                      </td>
                      <td className="px-2 py-2 min-w-[240px]">
                        <input
                          value={f.title}
                          onChange={(e) => updateFile(f.path, { title: e.target.value })}
                          className="w-full rounded border border-gray-300 px-1 py-0.5 text-xs"
                        />
                        {f.evidence && <div className="mt-0.5 text-[10px] text-gray-500 italic line-clamp-2" title={f.evidence}>“{f.evidence}”</div>}
                      </td>
                      <td className="px-2 py-2 max-w-[160px]">
                        <select
                          value={f.filedBy}
                          onChange={(e) => updateFile(f.path, { filedBy: e.target.value })}
                          className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                        >
                          {['unknown', 'plaintiff', 'defendant', 'petitioner', 'respondent', 'movant', 'court', 'third-party'].map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                        {f.author && <div className="mt-0.5 text-[10px] text-gray-600 truncate" title={f.author}>{f.author}</div>}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <input
                          value={f.filedOn ?? ''}
                          placeholder="no stamp"
                          onChange={(e) => updateFile(f.path, { filedOn: e.target.value || null })}
                          className="w-24 rounded border border-gray-300 px-1 py-0.5 text-xs"
                        />
                        {f.signedOn && f.signedOn !== f.filedOn && (
                          <div className="mt-0.5 text-[10px] text-gray-500">signed {f.signedOn}</div>
                        )}
                        {f.stampEvidence && (
                          <div className="mt-0.5 max-w-[160px] truncate text-[10px] text-gray-500 italic" title={f.stampEvidence}>“{f.stampEvidence}”</div>
                        )}
                      </td>
                      <td className="px-2 py-2 max-w-[200px]">
                        {f.answersTitle ? (
                          <>
                            <select
                              value={f.answersPath ?? ''}
                              onChange={(e) => updateFile(f.path, { answersPath: e.target.value || null })}
                              className="w-full rounded border border-gray-300 px-1 py-0.5 text-xs"
                            >
                              <option value="">— no link —</option>
                              {[...motionsByPath.entries()].map(([p, t]) => <option key={p} value={p}>{t}</option>)}
                            </select>
                            <div className="mt-0.5 text-[10px] text-gray-500 truncate" title={f.answersTitle}>model: “{f.answersTitle}”</div>
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <input
                          value={f.targetDir}
                          onChange={(e) => updateFile(f.path, { targetDir: e.target.value })}
                          className="w-28 rounded border border-gray-300 px-1 py-0.5 text-xs"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${CONF_STYLE[f.confidence]}`}>{f.confidence}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.unplanned.length > 0 && (
              <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-500">
                {plan.unplanned.length} more PDF(s) were found but not read (max files). Raise the cap or plan again after applying.
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-800">Apply</h2>
            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-700">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={organize} onChange={(e) => setOrganize(e.target.checked)} />
                Tidy the folder — move each file into its per-kind subfolder
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
                Queue for ingestion (DISCOVERED → QUEUED)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => runApply(true)}
                disabled={applying || acceptedCount === 0}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
              >
                {applying ? 'Working…' : 'Dry run'}
              </button>
              {!armed ? (
                <button
                  onClick={() => setArmed(true)}
                  disabled={applying || acceptedCount === 0 || !applyResult?.dryRun}
                  title={!applyResult?.dryRun ? 'Run the dry run first' : undefined}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Apply…
                </button>
              ) : (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-gray-700">
                    This writes {acceptedCount} filing(s){organize ? ', moves files' : ''}{queue ? ' and queues ingestion' : ''}. Sure?
                  </span>
                  <button onClick={() => runApply(false)} disabled={applying} className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    Yes, apply
                  </button>
                  <button onClick={() => setArmed(false)} className="text-gray-600 hover:underline">cancel</button>
                </span>
              )}
            </div>

            {applyResult && (
              <div className="space-y-2">
                <div className={`rounded-md border px-3 py-2 text-xs ${applyResult.dryRun ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
                  <b>{applyResult.dryRun ? 'Dry run' : 'Applied'}</b> — case {String(applyResult.meta.caseAction)} ·{' '}
                  filings {String(applyResult.meta.filingsCreated)} created / {String(applyResult.meta.filingsFound)} found ·{' '}
                  documents {String(applyResult.meta.documentsCreated)} created / {String(applyResult.meta.documentsUpdated)} updated ·{' '}
                  moved {String(applyResult.meta.moved)} · links {String(applyResult.meta.linksWritten)} ·{' '}
                  {String(applyResult.meta.rowsWithWarnings)} row(s) with warnings
                  <div className="mt-1 text-[11px] opacity-80">{String(applyResult.meta.note)}</div>
                </div>
                <div className="overflow-x-auto rounded-md border border-gray-200">
                  <table className="min-w-full text-[11px]">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium">File</th>
                        <th className="px-2 py-1.5 text-left font-medium">Move</th>
                        <th className="px-2 py-1.5 text-left font-medium">Filing</th>
                        <th className="px-2 py-1.5 text-left font-medium">Entity</th>
                        <th className="px-2 py-1.5 text-left font-medium">Document</th>
                        <th className="px-2 py-1.5 text-left font-medium">Link</th>
                        <th className="px-2 py-1.5 text-left font-medium">Warnings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {applyResult.rows.map((r) => (
                        <tr key={r.path} className="border-t border-gray-100 align-top">
                          <td className="px-2 py-1.5 max-w-[220px] truncate" title={r.path}>{r.name}</td>
                          <td className="px-2 py-1.5 font-mono">{r.movedTo ? r.movedTo.replace(plan.path + '/', '') : '—'}</td>
                          <td className="px-2 py-1.5">{r.filingAction}</td>
                          <td className="px-2 py-1.5">{r.entity ?? '—'}</td>
                          <td className="px-2 py-1.5">{r.documentAction}</td>
                          <td className="px-2 py-1.5">{r.linkAction}</td>
                          <td className="px-2 py-1.5 text-amber-700">{r.warnings.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
