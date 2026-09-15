'use client';

/**
 * AdminOpenRouter — the `/admin/openrouter` tab.
 *
 * Persistence goes through `/api/openrouter/settings` (NOT `/api/config`,
 * which is frozen for this feature and does not forward these fields — see
 * that route's header comment). The API key is write-only end to end: the
 * server never returns it, and this component never round-trips a masked
 * value back into the field.
 *
 * Catalogue browsing (`/api/openrouter/models`) and availability checks
 * (`/api/openrouter/validate`) need no API key and work whether or not
 * OpenRouter is enabled — the enable toggle only gates the inference path
 * elsewhere in the app (embedding/rerank/chat calls), not this page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicConfig } from '@/lib/db/config';
import {
  OPENROUTER_EMBEDDING_MODELS,
  OPENROUTER_RERANK_MODELS,
  OPENROUTER_CHAT_MODELS,
} from '@/lib/openrouter/models';
import type { OpenRouterCatalogueModel } from '@/app/api/openrouter/models/route';

interface Props {
  initialConfig: PublicConfig;
}

interface ModelAvailability {
  id: string;
  available: boolean;
  providers: string[];
  pricePerMTokens?: number;
  reason?: 'no-providers' | 'unknown-model';
}

interface LastCallInfo {
  at: number;
  durationMs: number;
  servedBy: string;
  success: boolean;
}

interface RoleActivity {
  role: string;
  inFlight: number;
  callsToday: number;
  tokensToday: number;
  spendTodayUsd: number;
  lastCall: LastCallInfo | null;
  callsByServedBy: Record<string, number>;
}

const ACTIVITY_ROLES = ['embedding', 'code-embedding', 'completion', 'reranker'] as const;
const ACTIVITY_ROLE_LABELS: Record<(typeof ACTIVITY_ROLES)[number], string> = {
  embedding: 'Embedding',
  'code-embedding': 'Code embedding',
  completion: 'Chat / Completion',
  reranker: 'Reranker',
};
const ACTIVITY_POLL_MS = 4000;
/** A call finished within this window still reads as "active", not just
 *  "idle with a recent history" — gives the "is it working?" glance a beat
 *  to actually catch a fast embedding round trip. */
const RECENT_MS = 5000;

function fmtServedBy(servedBy: string): string {
  if (servedBy === 'master-direct') return 'master (direct)';
  if (servedBy.startsWith('sidecar:')) return `sidecar ${servedBy.slice('sidecar:'.length)}`;
  return servedBy;
}

function fmtAgo(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

const PAGE_SIZE = 25;

type SortKey = 'id' | 'contextLength' | 'pricePromptPerMTokens' | 'priceCompletionPerMTokens';

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function fmtCtx(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

export default function AdminOpenRouter({ initialConfig }: Props) {
  // --- Settings state ---
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [enabled, setEnabled] = useState(initialConfig.openRouterEnabled ?? false);
  const [embeddingModel, setEmbeddingModel] = useState(
    initialConfig.openRouterEmbeddingModel || OPENROUTER_EMBEDDING_MODELS[0]?.id || '',
  );
  // Separate from the text embedding model: ss-embedding and ss-code-embedding
  // run different local models at different widths (1024d vs 2560d), so a single
  // setting cannot serve both.
  const [codeEmbeddingModel, setCodeEmbeddingModel] = useState(
    initialConfig.openRouterCodeEmbeddingModel || 'qwen/qwen3-embedding-4b',
  );
  const [rerankModel, setRerankModel] = useState(
    initialConfig.openRouterRerankModel || OPENROUTER_RERANK_MODELS[0]?.id || '',
  );
  const [chatModel, setChatModel] = useState(
    initialConfig.openRouterChatModel || OPENROUTER_CHAT_MODELS[0]?.id || '',
  );
  const [dailyCapUsd, setDailyCapUsd] = useState<Record<string, number>>(
    initialConfig.openRouterDailyCapUsd ?? {},
  );
  const keyConfigured = initialConfig.apiKeys?.openrouter?.configured ?? false;
  const keyLast4 = initialConfig.apiKeys?.openrouter?.last4;

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/openrouter/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Write-only: an empty field means "leave the stored key alone".
          apiKey: apiKeyInput.trim() ? apiKeyInput.trim() : undefined,
          enabled,
          embeddingModel,
          rerankModel,
          chatModel,
          dailyCapUsd,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setApiKeyInput('');
      setSaveMessage({ type: 'success', text: 'OpenRouter settings saved.' });
    } catch (e: any) {
      setSaveMessage({ type: 'error', text: e.message || 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  // --- Live activity (top-of-page "is it working?" panel) ---
  const [activity, setActivity] = useState<Record<string, RoleActivity> | null>(null);
  // `Date.now()` may not be called during render (react-hooks/purity) — the
  // "active"/"Xs ago" reads are computed against this ticking clock instead,
  // sourced from an effect, not from render itself.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/openrouter/activity');
        const body = await res.json();
        if (!cancelled && body?.byRole) setActivity(body.byRole);
      } catch {
        // Transient — the next poll tries again; don't blank out a good
        // last-known state over one dropped request.
      }
    };
    poll();
    const pollId = setInterval(poll, ACTIVITY_POLL_MS);
    const clockId = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(pollId);
      clearInterval(clockId);
    };
  }, []);

  // --- Credits / spend ---
  const [credits, setCredits] = useState<{
    configured: boolean;
    credits: { totalCredits: number; totalUsage: number; remaining: number } | null;
    spendToday: { embedding: number; reranker: number; completion: number; total: number };
  } | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(true);

  const loadCredits = useCallback(async () => {
    setCreditsLoading(true);
    try {
      const res = await fetch('/api/openrouter/credits');
      const body = await res.json();
      setCredits(body);
    } catch {
      setCredits(null);
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredits();
  }, [loadCredits]);

  // --- Curated model availability ---
  const [availability, setAvailability] = useState<Record<string, ModelAvailability>>({});
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  const checkAvailability = useCallback(async () => {
    setCheckingAvailability(true);
    try {
      const ids = [
        ...OPENROUTER_EMBEDDING_MODELS.map((m) => m.id),
        ...OPENROUTER_RERANK_MODELS.map((m) => m.id),
      ];
      const res = await fetch('/api/openrouter/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const body = await res.json();
      if (Array.isArray(body.results)) {
        const map: Record<string, ModelAvailability> = {};
        for (const r of body.results as ModelAvailability[]) map[r.id] = r;
        setAvailability(map);
      }
    } finally {
      setCheckingAvailability(false);
    }
  }, []);

  // --- Live catalogue ---
  const [catalogue, setCatalogue] = useState<OpenRouterCatalogueModel[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);

  useEffect(() => {
    (async () => {
      setCatalogueLoading(true);
      setCatalogueError(null);
      try {
        const res = await fetch('/api/openrouter/models');
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setCatalogue(body.models ?? []);
      } catch (e: any) {
        setCatalogueError(e.message || 'Failed to load catalogue');
      } finally {
        setCatalogueLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = q ? catalogue.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : catalogue;
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey] ?? (typeof a[sortKey] === 'string' ? '' : -Infinity);
      const bv = b[sortKey] ?? (typeof b[sortKey] === 'string' ? '' : -Infinity);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [catalogue, search, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  };

  return (
    <div className="space-y-8">
      {saveMessage && (
        <div
          className={`p-4 rounded-md ${
            saveMessage.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {saveMessage.text}
        </div>
      )}

      {/* --- Live activity: "is it working?" at a glance, per role --- */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Live Activity</h3>
          <span className="text-xs text-gray-400">refreshes every {ACTIVITY_POLL_MS / 1000}s</span>
        </div>

        {!activity ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {ACTIVITY_ROLES.map((role) => (
              <ActivityCard key={role} label={ACTIVITY_ROLE_LABELS[role]} data={activity[role]} nowMs={nowMs} />
            ))}
          </div>
        )}
      </section>

      {/* --- API key + enable toggle --- */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Connection</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
          <input
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={keyConfigured ? `Configured (••••${keyLast4})` : 'sk-or-v1-…'}
            className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            {keyConfigured
              ? `A key is stored (ends in ${keyLast4}). Leave blank to keep it — this field is never pre-filled with the real value.`
              : 'No key stored yet.'}
          </p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
          <span className="text-sm font-medium text-gray-700">Enable OpenRouter</span>
        </label>
        <p className="text-xs text-gray-500">
          Off by default. While off, nothing in the app calls out to OpenRouter — embedding, rerank, and chat all stay
          on their local/other configured providers regardless of the model pickers below. Browsing the catalogue and
          checking availability on this page work either way.
        </p>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </section>

      {/* --- Credits + spend --- */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Credits &amp; Spend</h3>
          <button onClick={loadCredits} className="text-sm text-blue-600 hover:underline">
            Refresh
          </button>
        </div>

        {creditsLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !credits?.configured ? (
          <p className="text-sm text-gray-500">No API key configured yet — set one above to see balance.</p>
        ) : credits.credits ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Remaining" value={`$${credits.credits.remaining.toFixed(2)}`} />
            <Stat label="Total credits" value={`$${credits.credits.totalCredits.toFixed(2)}`} />
            <Stat label="Total usage" value={`$${credits.credits.totalUsage.toFixed(2)}`} />
            <Stat label="Spent today (all roles)" value={`$${credits.spendToday.total.toFixed(4)}`} />
          </div>
        ) : (
          <p className="text-sm text-red-600">Could not reach OpenRouter to read the balance.</p>
        )}

        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Daily spend caps (USD, per role — 0 or blank = uncapped)</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg">
            {(['embedding', 'reranker', 'completion'] as const).map((role) => (
              <div key={role}>
                <label className="block text-xs text-gray-500 capitalize mb-1">{role}</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={dailyCapUsd[role] ?? ''}
                  onChange={(e) =>
                    setDailyCapUsd((prev) => ({
                      ...prev,
                      [role]: e.target.value === '' ? 0 : Number(e.target.value),
                    }))
                  }
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                />
                {credits && (
                  <p className="text-xs text-gray-400 mt-0.5">today: ${credits.spendToday[role].toFixed(4)}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- Model pickers --- */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Model Selection</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          {/* ss-embedding — any curated model is offered, but none matches the
              local 0.6b's 1024 dims, so every choice implies a re-index. */}
          <Picker
            label="Text embedding (ss-embedding)"
            hint="Local: qwen3-embedding:0.6b (1024d). No hosted model matches that width — switching means a full re-index."
            value={embeddingModel}
            onChange={setEmbeddingModel}
            options={OPENROUTER_EMBEDDING_MODELS.map((m) => ({
              id: m.id,
              label: `${m.label} · ${m.dims}d${m.codeCapable ? '' : ' · text-only'}`,
            }))}
          />
          {/* ss-code-embedding — restricted to code-capable models. Offering a
              text-only embedder here would quietly degrade code search. */}
          <Picker
            label="Code embedding (ss-code-embedding)"
            hint="Local: qwen3-embedding:4b (2560d). The 4B below matches that width exactly — no re-index."
            value={codeEmbeddingModel}
            onChange={setCodeEmbeddingModel}
            options={OPENROUTER_EMBEDDING_MODELS.filter((m) => m.codeCapable).map((m) => ({
              id: m.id,
              label: `${m.label} · ${m.dims}d${m.dropInFor === 'code-embedding' ? ' · drop-in' : ''}`,
            }))}
          />
          <Picker label="Reranker" value={rerankModel} onChange={setRerankModel} options={OPENROUTER_RERANK_MODELS.map((m) => ({ id: m.id, label: m.label }))} />
          <Picker label="Chat" value={chatModel} onChange={setChatModel} options={OPENROUTER_CHAT_MODELS.map((m) => ({ id: m.id, label: m.label }))} />
        </div>
      </section>

      {/* --- Curated embedding/rerank models --- */}
      <section className="bg-amber-50 border border-amber-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Curated Embedding &amp; Rerank Models</h3>
            <p className="text-xs text-amber-800 mt-1">
              Hand-maintained — OpenRouter&apos;s catalogue lists zero embedding and zero rerank models
              (<code>?category=embedding</code> returns 400), so these are probed and measured separately.
            </p>
          </div>
          <button
            onClick={checkAvailability}
            disabled={checkingAvailability}
            className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap"
          >
            {checkingAvailability ? 'Checking…' : 'Check availability'}
          </button>
        </div>

        {/*
          Code vs text, and drop-in status, are the two things an operator needs
          before switching a role. `ss-embedding` (qwen3-embedding:0.6b, 1024d)
          and `ss-code-embedding` (qwen3-embedding:4b, 2560d) have different
          widths, so a model that is a drop-in for one is a re-index for the
          other. Saying which is which here prevents picking by price alone and
          discovering the mismatch at ingestion time.
        */}
        <CuratedTable
          title="Embedding models — code vs text"
          rows={OPENROUTER_EMBEDDING_MODELS.map((m) => ({
            id: m.id,
            label: `${m.label}  ${m.codeCapable ? '[Code + Text]' : '[Text]'}`,
            detail: [
              `${m.dims} dims`,
              fmtCtx(m.contextTokens) + ' ctx',
              fmtPrice(m.pricePerMTokens) + '/M',
              `pinned: ${m.pinProvider}`,
              m.dropInFor
                ? `drop-in for ss-${m.dropInFor} (same ${m.dims}d — no re-index)`
                : 'new vector space only — dimensions match no current role',
            ].join(' · '),
          }))}
          availability={availability}
        />
        <CuratedTable
          title="Rerank models"
          rows={OPENROUTER_RERANK_MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            detail: `${fmtCtx(m.contextTokens)} ctx · ${fmtPrice(m.pricePerMTokens)}/M · pinned: ${m.pinProvider}`,
          }))}
          availability={availability}
        />
      </section>

      {/* --- Live catalogue browser --- */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Chat Model Catalogue</h3>
        <p className="text-xs text-gray-500">
          Live from OpenRouter — {catalogue.length || '…'} models. Cached ~1h server-side.
        </p>

        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search by id or name…"
          className="w-full max-w-sm px-3 py-2 border border-gray-300 rounded-md text-sm"
        />

        {catalogueLoading ? (
          <p className="text-sm text-gray-500">Loading catalogue…</p>
        ) : catalogueError ? (
          <p className="text-sm text-red-600">{catalogueError}</p>
        ) : (
          <>
            <div className="overflow-x-auto border border-gray-200 rounded-md">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <Th label="Model ID" onClick={() => toggleSort('id')} active={sortKey === 'id'} dir={sortDir} />
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Modality</th>
                    <Th label="Context" onClick={() => toggleSort('contextLength')} active={sortKey === 'contextLength'} dir={sortDir} />
                    <Th label="Input $/M" onClick={() => toggleSort('pricePromptPerMTokens')} active={sortKey === 'pricePromptPerMTokens'} dir={sortDir} />
                    <Th label="Output $/M" onClick={() => toggleSort('priceCompletionPerMTokens')} active={sortKey === 'priceCompletionPerMTokens'} dir={sortDir} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pageRows.map((m) => (
                    <tr key={m.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs text-gray-800">{m.id}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {m.modality || '—'}
                        {m.inputModalities.length > 1 && (
                          <span className="text-gray-400"> ({m.inputModalities.join(', ')})</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{fmtCtx(m.contextLength)}</td>
                      <td className="px-3 py-2 text-gray-600">{fmtPrice(m.pricePromptPerMTokens)}</td>
                      <td className="px-3 py-2 text-gray-600">{fmtPrice(m.priceCompletionPerMTokens)}</td>
                    </tr>
                  ))}
                  {pageRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                        No models match &quot;{search}&quot;.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between text-sm text-gray-600">
              <span>
                Page {page + 1} of {pageCount} ({filtered.length} models)
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2 py-1 border border-gray-300 rounded disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-2 py-1 border border-gray-300 rounded disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ActivityCard({ label, data, nowMs }: { label: string; data: RoleActivity | undefined; nowMs: number }) {
  if (!data) {
    return (
      <div className="border border-gray-200 rounded-md p-4">
        <div className="text-sm font-medium text-gray-700">{label}</div>
        <p className="text-xs text-gray-400 mt-2">no data yet</p>
      </div>
    );
  }

  const active = data.inFlight > 0 || (data.lastCall != null && nowMs - data.lastCall.at < RECENT_MS);
  const everCalled = data.callsToday > 0 || data.lastCall != null;
  const sourceEntries = Object.entries(data.callsByServedBy).sort((a, b) => b[1] - a[1]);

  return (
    <div
      className={`border rounded-md p-4 space-y-3 ${
        active ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-800">{label}</div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            active
              ? 'bg-green-100 text-green-800'
              : everCalled
                ? 'bg-gray-100 text-gray-600'
                : 'bg-gray-50 text-gray-400'
          }`}
        >
          {active ? `active${data.inFlight > 0 ? ` · ${data.inFlight} in flight` : ''}` : everCalled ? 'idle' : 'never called'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-400">Calls today</div>
          <div className="text-gray-900 font-semibold">{data.callsToday}</div>
        </div>
        <div>
          <div className="text-gray-400">Tokens today</div>
          <div className="text-gray-900 font-semibold">{data.tokensToday.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-gray-400">Spent today</div>
          <div className="text-gray-900 font-semibold">${data.spendTodayUsd.toFixed(4)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500">
        {data.lastCall ? (
          <>
            Last call: {fmtAgo(data.lastCall.at, nowMs)} · {data.lastCall.durationMs}ms ·{' '}
            <span className={data.lastCall.success ? 'text-gray-700' : 'text-red-600'}>
              {data.lastCall.success ? fmtServedBy(data.lastCall.servedBy) : 'failed'}
            </span>
          </>
        ) : (
          'No calls yet'
        )}
      </div>

      {sourceEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sourceEntries.map(([servedBy, count]) => (
            <span
              key={servedBy}
              className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100"
              title={servedBy}
            >
              {fmtServedBy(servedBy)}: {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function Picker({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  /** Short note under the control — used to state the local model and width, so
   *  the re-index consequence of a mismatch is visible at the point of choice. */
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function Th({
  label,
  onClick,
  active,
  dir,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  dir: 'asc' | 'desc';
}) {
  return (
    <th
      onClick={onClick}
      className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer select-none hover:text-gray-900"
    >
      {label}
      {active && <span className="ml-1">{dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

function CuratedTable({
  title,
  rows,
  availability,
}: {
  title: string;
  rows: { id: string; label: string; detail: string }[];
  availability: Record<string, ModelAvailability>;
}) {
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">{title}</h4>
      <div className="space-y-2">
        {rows.map((r) => {
          const a = availability[r.id];
          return (
            <div key={r.id} className="flex items-center justify-between bg-white border border-amber-100 rounded-md px-3 py-2">
              <div>
                <div className="font-mono text-xs text-gray-800">{r.id}</div>
                <div className="text-xs text-gray-500">{r.detail}</div>
              </div>
              {a ? (
                a.available ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                    available via {a.providers.join(', ')}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {a.reason === 'unknown-model' ? 'unknown model id' : 'listed but no provider right now'}
                  </span>
                )
              ) : (
                <span className="text-xs text-gray-400">not checked</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
