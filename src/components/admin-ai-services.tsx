'use client';

/**
 * AdminAIServices — admin panel for selecting the AI model used by:
 *   - MCP tools
 * - AI search
 * - Document summarization
 * - Document analysis
 * - Tag-fill (upcoming)
 *
 * Persistence: Config table keys
 *   ai.primaryProvider, ai.primaryModel,
 *   ai.fallbackEnabled, ai.fallbackProvider, ai.fallbackModel
 *
 * The endpoint contract is the existing /api/config POST — we GET full config,
 * overlay our changes, and POST it back (mirrors the LocalAIPanel pattern).
 */

import { useCallback, useEffect, useState } from 'react';
import { AI_PROVIDERS, AI_PROVIDER_KEYS, type AIProviderKey } from '@/lib/ai/models';
import { isTextGenerationTag } from '@/lib/mcp/model-capabilities';

interface OllamaModelEntry {
  id: string;
  label: string;
  size?: number;
  /** Ollama `details.family` / `details.families` — used to spot OCR/vision builds. */
  family?: string;
  families?: string[];
}

interface OllamaModelsResponse {
  models?: OllamaModelEntry[];
  host?: string;
  error?: string;
}

interface TestResult {
  valid: boolean;
  error?: string;
  message?: string;
}

const RECOMMENDED_LOCAL_MODEL = 'qwen3.5:9b';

// Cloud providers — derived from the canonical registry (src/lib/ai/models.ts).
// Note: registry has Grok (xAI), not OpenRouter; we surface what's wired up.
const CLOUD_PROVIDER_KEYS = AI_PROVIDER_KEYS.filter(k => k !== 'ollama') as AIProviderKey[];

export default function AdminAIServices() {
  // Loaded full config (so we can overlay AI service fields and POST back)
  const [fullConfig, setFullConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  // Sidecar Ollama models
  const [ollamaModels, setOllamaModels] = useState<OllamaModelEntry[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(true);

  // Primary (local) selection
  const [primaryProvider, setPrimaryProvider] = useState<string>('ollama');
  const [primaryModel, setPrimaryModel] = useState<string>('');

  // MCP local-profile helper models. '' means "Auto" — fall back to the
  // resolution chain in routing-defaults.ts rather than pinning a tag.
  const [decomposeModel, setDecomposeModel] = useState<string>('');
  const [outlineModel, setOutlineModel] = useState<string>('');
  // What the resolver returns today for those two roles (admin config → env →
  // host tags). Fetched from /api/config?resolve=localModels.
  const [resolvedLocal, setResolvedLocal] = useState<{ decompose: string | null; outline: string | null } | null>(null);

  // Cloud fallback
  const [fallbackEnabled, setFallbackEnabled] = useState<boolean>(false);
  // Anthropic prompt-cache TTL for the deep-search shared-prefix breakpoint
  // (task #15). '1h' default — TTL runs from request start, so long streamed
  // sections can outlive a 5m window.
  const [cacheTtl, setCacheTtl] = useState<'5m' | '1h'>('1h');
  const [fallbackProvider, setFallbackProvider] = useState<string>('openai');
  const [fallbackModel, setFallbackModel] = useState<string>('');

  // Save indicators (one per logical section)
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // Test connection state
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, TestResult | null>>({});

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const cfg = (await res.json()) as Record<string, unknown>;
        setFullConfig(cfg);
        if (typeof cfg.aiPrimaryProvider === 'string') setPrimaryProvider(cfg.aiPrimaryProvider);
        if (typeof cfg.aiPrimaryModel === 'string') setPrimaryModel(cfg.aiPrimaryModel);
        if (typeof cfg.aiFallbackEnabled === 'boolean') setFallbackEnabled(cfg.aiFallbackEnabled);
        if (typeof cfg.aiFallbackProvider === 'string') setFallbackProvider(cfg.aiFallbackProvider);
        if (typeof cfg.aiFallbackModel === 'string') setFallbackModel(cfg.aiFallbackModel);
        if (cfg.cacheTtl === '5m' || cfg.cacheTtl === '1h') setCacheTtl(cfg.cacheTtl);
        setDecomposeModel(typeof cfg.ollamaDecomposeModel === 'string' ? cfg.ollamaDecomposeModel : '');
        setOutlineModel(typeof cfg.ollamaOutlineModel === 'string' ? cfg.ollamaOutlineModel : '');
      }
    } catch {
      /* silent */
    }
    setLoading(false);
  }, []);

  /** Ask the server what the local profile resolves to right now. Never throws. */
  const loadResolvedLocal = useCallback(async () => {
    try {
      const res = await fetch('/api/config?resolve=localModels');
      if (!res.ok) return setResolvedLocal(null);
      const body = (await res.json()) as { decompose?: string | null; outline?: string | null };
      setResolvedLocal({ decompose: body.decompose ?? null, outline: body.outline ?? null });
    } catch {
      setResolvedLocal(null);
    }
  }, []);

  const loadOllamaModels = useCallback(async () => {
    setOllamaLoading(true);
    setOllamaError(null);
    try {
      const res = await fetch('/api/ollama/models');
      if (!res.ok) {
        const body: OllamaModelsResponse = await res.json().catch(() => ({}));
        setOllamaError(body.error || `Sidecar offline (HTTP ${res.status})`);
        setOllamaModels([]);
      } else {
        const body: OllamaModelsResponse = await res.json();
        setOllamaModels(body.models || []);
      }
    } catch (e) {
      setOllamaError(e instanceof Error ? e.message : 'Sidecar offline');
      setOllamaModels([]);
    }
    setOllamaLoading(false);
  }, []);

  useEffect(() => {
    loadConfig();
    loadOllamaModels();
    loadResolvedLocal();
  }, [loadConfig, loadOllamaModels, loadResolvedLocal]);

  const recordSaved = (section: string) => {
    setSavedAt(prev => ({ ...prev, [section]: Date.now() }));
    setTimeout(() => {
      setSavedAt(prev => {
        const next = { ...prev };
        delete next[section];
        return next;
      });
    }, 2500);
  };

  /** Overlay AI service fields onto the loaded config and POST. */
  const persist = useCallback(
    async (
      patch: Partial<{
        aiPrimaryProvider: string;
        aiPrimaryModel: string;
        cacheTtl: '5m' | '1h';
        aiFallbackEnabled: boolean;
        aiFallbackProvider: string;
        aiFallbackModel: string;
        ollamaDecomposeModel: string;
        ollamaOutlineModel: string;
      }>,
      section: string,
    ) => {
      setSaveError(null);
      try {
        // Always refetch the latest config to minimize race with other panels.
        const cfgRes = await fetch('/api/config');
        if (!cfgRes.ok) throw new Error(`config GET ${cfgRes.status}`);
        const cfg = (await cfgRes.json()) as Record<string, unknown>;
        const body = { ...cfg, ...patch };
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${res.status}`);
        }
        setFullConfig(body);
        recordSaved(section);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Save failed');
      }
    },
    [],
  );

  // --- Handlers --------------------------------------------------------------

  const handlePrimaryModelChange = (modelId: string) => {
    setPrimaryProvider('ollama');
    setPrimaryModel(modelId);
    persist({ aiPrimaryProvider: 'ollama', aiPrimaryModel: modelId }, 'primary');
  };

  // Deliberately NOT reusing handlePrimaryModelChange: that one pins
  // aiPrimaryProvider to 'ollama', which has nothing to do with these two.
  const handleDecomposeModelChange = async (modelId: string) => {
    setDecomposeModel(modelId);
    await persist({ ollamaDecomposeModel: modelId }, 'localhelpers');
    await loadResolvedLocal();
  };

  const handleOutlineModelChange = async (modelId: string) => {
    setOutlineModel(modelId);
    await persist({ ollamaOutlineModel: modelId }, 'localhelpers');
    await loadResolvedLocal();
  };

  const handleFallbackToggle = (enabled: boolean) => {
    setFallbackEnabled(enabled);
    persist({ aiFallbackEnabled: enabled }, 'fallback');
  };

  const handleFallbackProviderChange = (providerKey: string) => {
    setFallbackProvider(providerKey);
    // When switching providers, default to the first model in the registry
    // so we never persist a model that belongs to the wrong provider.
    const firstModel = AI_PROVIDERS[providerKey as AIProviderKey]?.models[0]?.id ?? '';
    setFallbackModel(firstModel);
    persist(
      { aiFallbackProvider: providerKey, aiFallbackModel: firstModel },
      'fallback',
    );
  };

  const handleFallbackModelChange = (modelId: string) => {
    setFallbackModel(modelId);
    persist({ aiFallbackModel: modelId, aiFallbackProvider: fallbackProvider }, 'fallback');
  };

  // --- Test connection -------------------------------------------------------

  const handleTestLocal = async () => {
    setTesting(prev => ({ ...prev, local: true }));
    setTestResult(prev => ({ ...prev, local: null }));
    try {
      const res = await fetch('/api/ollama/models');
      if (res.ok) {
        const body: OllamaModelsResponse = await res.json();
        setTestResult(prev => ({
          ...prev,
          local: {
            valid: true,
            message: `Sidecar Ollama OK — ${body.models?.length ?? 0} model(s) available`,
          },
        }));
      } else {
        const body: OllamaModelsResponse = await res.json().catch(() => ({}));
        setTestResult(prev => ({
          ...prev,
          local: { valid: false, error: body.error || `HTTP ${res.status}` },
        }));
      }
    } catch (e) {
      setTestResult(prev => ({
        ...prev,
        local: { valid: false, error: e instanceof Error ? e.message : 'Request failed' },
      }));
    }
    setTesting(prev => ({ ...prev, local: false }));
  };

  const handleTestCloud = async () => {
    setTesting(prev => ({ ...prev, cloud: true }));
    setTestResult(prev => ({ ...prev, cloud: null }));
    try {
      // Read the configured API key for this provider from the AI-Keys admin.
      // We don't have direct access to the key on the client, so we use the
      // server-side /api/admin/ai-keys/test endpoint with the stored key.
      // That endpoint expects the key in the request body, so we first GET
      // /api/config which exposes API keys to the admin UI.
      const cfgRes = await fetch('/api/config');
      const cfg = (await cfgRes.json()) as Record<string, unknown>;
      const keyByProvider: Record<string, string | undefined> = {
        openai: typeof cfg.openaiApiKey === 'string' ? cfg.openaiApiKey : undefined,
        anthropic: typeof cfg.claudeApiKey === 'string' ? cfg.claudeApiKey : undefined,
        gemini: typeof cfg.geminiApiKey === 'string' ? cfg.geminiApiKey : undefined,
        groq: typeof cfg.groqApiKey === 'string' ? cfg.groqApiKey : undefined,
        grok: typeof cfg.grokApiKey === 'string' ? cfg.grokApiKey : undefined,
      };
      const apiKey = keyByProvider[fallbackProvider];
      if (!apiKey) {
        setTestResult(prev => ({
          ...prev,
          cloud: {
            valid: false,
            error: 'No API key configured — set it under AI Keys $.',
          },
        }));
      } else {
        const res = await fetch('/api/admin/ai-keys/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: fallbackProvider, apiKey }),
        });
        const result = (await res.json()) as TestResult;
        setTestResult(prev => ({ ...prev, cloud: result }));
      }
    } catch (e) {
      setTestResult(prev => ({
        ...prev,
        cloud: { valid: false, error: e instanceof Error ? e.message : 'Request failed' },
      }));
    }
    setTesting(prev => ({ ...prev, cloud: false }));
  };

  // --- Render ----------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-500 text-sm">
        Loading AI services…
      </div>
    );
  }

  const recommendedInstalled = ollamaModels.some(m => m.id === RECOMMENDED_LOCAL_MODEL);
  // Decompose and the outline are constrained JSON generation over text: an
  // OCR/vision build cannot do them, so offering one would be a trap. Filters
  // fail open — anything not clearly vision/embedding stays listed.
  const helperModels = ollamaModels.filter(isTextGenerationTag);
  const hiddenHelperCount = ollamaModels.length - helperModels.length;
  /**
   * A pinned tag must stay visible even when it is not in `helperModels`, so it
   * can be seen and changed rather than silently reverting to Auto. The two
   * cases are different and the label says which: the host no longer has it, or
   * the host has it but it is the wrong kind of model.
   */
  const stalePinNote = (value: string): string | null => {
    if (!value || helperModels.some(m => m.id === value)) return null;
    return ollamaModels.some(m => m.id === value) ? 'not a text model' : 'not installed';
  };
  const fallbackModels = AI_PROVIDERS[fallbackProvider as AIProviderKey]?.models ?? [];

  return (
    <div className="space-y-6">
      {/* Header chip — "What this controls" */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-blue-900">
        <span className="font-semibold">Used for:</span> MCP tools, AI search, document
        summarization, analysis, and the upcoming tag-fill feature.
      </div>

      {saveError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {/* 1. Local model (sidecar Ollama) */}
      <section className="bg-white shadow rounded-lg p-5 border-2 border-blue-100">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Local model (sidecar Ollama)</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">
              Free
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">
              Private
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestLocal}
              disabled={testing.local}
              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium disabled:opacity-50"
            >
              {testing.local ? 'Testing…' : 'Test connection'}
            </button>
            {savedAt.primary && (
              <span className="text-xs text-green-700 font-medium">Saved</span>
            )}
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Pick the Ollama model used by the sidecar for chat, analysis, and the upcoming
          tag-fill flow.
        </p>

        {ollamaLoading ? (
          <div className="text-sm text-gray-500">Loading models…</div>
        ) : ollamaError ? (
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
            Sidecar offline: {ollamaError}
          </div>
        ) : ollamaModels.length === 0 ? (
          <div className="text-sm text-gray-500">
            No models installed. Run e.g. <code className="px-1 py-0.5 bg-gray-100 rounded">ollama pull {RECOMMENDED_LOCAL_MODEL}</code>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 w-24">Model</label>
              <select
                value={primaryModel || ''}
                onChange={e => handlePrimaryModelChange(e.target.value)}
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                <option value="" disabled>
                  Select a model…
                </option>
                {ollamaModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.id === RECOMMENDED_LOCAL_MODEL ? '  (Recommended)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {recommendedInstalled ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
                  Recommended: {RECOMMENDED_LOCAL_MODEL}
                </span>
                <span className="text-gray-600">
                  8 GB VRAM, free, runs on your machine.
                </span>
              </div>
            ) : (
              <div className="text-xs text-gray-600">
                Recommended <code className="px-1 py-0.5 bg-gray-100 rounded">{RECOMMENDED_LOCAL_MODEL}</code> is
                not installed. Run <code className="px-1 py-0.5 bg-gray-100 rounded">ollama pull {RECOMMENDED_LOCAL_MODEL}</code> on the sidecar host.
              </div>
            )}

            {primaryModel && (
              <div className="text-xs text-gray-500">
                Currently selected: <span className="font-mono text-gray-700">{primaryModel}</span>
              </div>
            )}

            {testResult.local && (
              <div
                className={`text-xs rounded-md p-2 ${
                  testResult.local.valid
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}
              >
                {testResult.local.valid
                  ? testResult.local.message || 'OK'
                  : `Failed: ${testResult.local.error || 'unknown error'}`}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 1b. MCP local-profile helper models (decompose + evidence outline) */}
      <section className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">MCP local research models</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
              Advanced
            </span>
          </div>
          {savedAt.localhelpers && <span className="text-xs text-green-700 font-medium">Saved</span>}
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Two short, JSON-shaped steps the <code className="px-1 py-0.5 bg-gray-100 rounded">local</code> MCP
          profile runs before it answers: splitting the question into sub-queries, and outlining the
          evidence it retrieved. Both are fine on a small instruct model and are much faster there
          than on the full completion model. Leave on <span className="font-medium">Auto</span> to let
          the server pick from what is installed.
        </p>

        {ollamaError && (
          <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
            Model list unavailable: {ollamaError}. Auto still works — it resolves on the server.
          </div>
        )}

        <div className="space-y-4">
          {([
            {
              key: 'decompose' as const,
              label: 'Decompose',
              value: decomposeModel,
              onChange: handleDecomposeModelChange,
              hint: 'Splits the query into sub-queries before retrieval.',
            },
            {
              key: 'outline' as const,
              label: 'Outline',
              value: outlineModel,
              onChange: handleOutlineModelChange,
              hint: 'Extracts a structured outline over the retrieved excerpts.',
            },
          ]).map(row => (
            <div key={row.key}>
              <div className="flex items-center gap-3">
                <label htmlFor={`mcp-local-${row.key}`} className="text-sm font-medium text-gray-700 w-24">
                  {row.label}
                </label>
                <select
                  id={`mcp-local-${row.key}`}
                  value={row.value}
                  onChange={e => void row.onChange(e.target.value)}
                  disabled={ollamaLoading}
                  className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-gray-50"
                >
                  <option value="">Auto (resolve from host)</option>
                  {/* A saved tag that isn't offered still has to be visible. */}
                  {stalePinNote(row.value) && (
                    <option value={row.value}>{row.value} ({stalePinNote(row.value)})</option>
                  )}
                  {helperModels.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-1 ml-[7.5rem] text-xs text-gray-500">
                {row.hint}
                {resolvedLocal?.[row.key] && (
                  <>
                    {' '}Currently resolves to{' '}
                    <span className="font-mono text-gray-700">{resolvedLocal[row.key]}</span>.
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {!ollamaLoading && !ollamaError && hiddenHelperCount > 0 && (
          <p className="mt-3 text-xs text-gray-500">
            {hiddenHelperCount} OCR/vision model{hiddenHelperCount === 1 ? '' : 's'} on this host{' '}
            {hiddenHelperCount === 1 ? 'is' : 'are'} not listed here — they cannot do constrained JSON
            generation.
          </p>
        )}
        {!ollamaLoading && !ollamaError && helperModels.length === 0 && (
          <p className="mt-3 text-xs text-gray-600">
            No text-generation model is installed on this host, so only Auto is available. Pull a
            small instruct model — e.g.{' '}
            <code className="px-1 py-0.5 bg-gray-100 rounded">ollama pull qwen3:1.7b</code> — to pin one.
          </p>
        )}
      </section>

      {/* Prompt caching (Anthropic direct API) */}
      <section className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Prompt caching</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">
              Saves cost
            </span>
          </div>
          {savedAt.cache && (
            <span className="text-xs text-green-700 font-medium">Saved</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700 w-24">Cache TTL</label>
          <select
            value={cacheTtl}
            onChange={e => {
              const v = e.target.value === '5m' ? '5m' : '1h';
              setCacheTtl(v);
              void persist({ cacheTtl: v }, 'cache');
            }}
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="1h">1 hour (default — best for long streamed reports; 2× write, 0.1× reads)</option>
            <option value="5m">5 minutes (1.25× write, 0.1× reads; TTL runs from request start)</option>
          </select>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Applies to Anthropic deep-search calls: the shared document-excerpt prefix is cached
          once and re-read by each report section at 10% of input price. Verify hits via
          the <code className="px-1 py-0.5 bg-gray-100 rounded">cache usage</code> lines in the dashboard log.
        </p>
      </section>

      {/* 2. Cloud fallback */}
      <section className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Cloud fallback</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 font-medium">
              Paid
            </span>
          </div>
          {savedAt.fallback && (
            <span className="text-xs text-green-700 font-medium">Saved</span>
          )}
        </div>

        <label className="flex items-start gap-3 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={fallbackEnabled}
            onChange={e => handleFallbackToggle(e.target.checked)}
            className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <div>
            <div className="text-sm font-medium text-gray-900">
              Fall back to cloud if local is unavailable or rate-limited
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Cloud calls bill against the configured API key in <code className="px-1 py-0.5 bg-gray-100 rounded">.env</code> or AI Keys.
            </div>
          </div>
        </label>

        {fallbackEnabled && (
          <div className="space-y-3 pl-7">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 w-24">Provider</label>
              <select
                value={fallbackProvider}
                onChange={e => handleFallbackProviderChange(e.target.value)}
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                {CLOUD_PROVIDER_KEYS.map(k => (
                  <option key={k} value={k}>
                    {AI_PROVIDERS[k].name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 w-24">Model</label>
              <select
                value={fallbackModel || ''}
                onChange={e => handleFallbackModelChange(e.target.value)}
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                {fallbackModels.length === 0 ? (
                  <option value="">No models</option>
                ) : (
                  fallbackModels.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleTestCloud}
                disabled={testing.cloud}
                className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium disabled:opacity-50"
              >
                {testing.cloud ? 'Testing…' : 'Test connection'}
              </button>
              {testResult.cloud && (
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    testResult.cloud.valid
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}
                >
                  {testResult.cloud.valid
                    ? testResult.cloud.message || 'OK'
                    : `Failed: ${testResult.cloud.error || 'unknown'}`}
                </span>
              )}
            </div>

            <p className="text-xs text-gray-500">
              Manage API keys under the <span className="font-medium">AI Keys $</span> tab.
            </p>
          </div>
        )}
      </section>

      {/* 3. What this controls */}
      <section className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">What this controls</h3>
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
          <li>MCP tools (called from Claude Desktop, scripts, IDE plugins)</li>
          <li>AI search (semantic + RAG over case knowledge)</li>
          <li>Document summarization</li>
          <li>Document analysis (entity extraction, contradiction finding, timeline)</li>
          <li>
            Tag-fill (upcoming) — auto-fills document tags from content using the selected
            model
          </li>
        </ul>
      </section>
    </div>
  );
}
