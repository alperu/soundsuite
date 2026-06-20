'use client';

import { useState } from 'react';
import { AppConfig } from '@/lib/db/config';
import WeightSection from '@/components/admin/weight-section';

interface Props {
  initialConfig: AppConfig;
}

const RERANK_MODELS: Array<{ name: string; label: string }> = [
  { name: 'Qwen/Qwen3-Reranker-8B', label: 'Qwen3 Reranker 8B (instruction-aware, highest quality)' },
  { name: 'Qwen/Qwen3-Reranker-4B', label: 'Qwen3 Reranker 4B (instruction-aware)' },
  { name: 'Qwen/Qwen3-Reranker-0.6B', label: 'Qwen3 Reranker 0.6B (instruction-aware, lightweight)' },
  { name: 'BAAI/bge-reranker-v2-m3', label: 'BGE Reranker v2 M3 (568M, multilingual)' },
  { name: 'BAAI/bge-reranker-large', label: 'BGE Reranker Large (560M)' },
  { name: 'BAAI/bge-reranker-base', label: 'BGE Reranker Base (278M, lightweight)' },
  { name: 'cross-encoder/ms-marco-MiniLM-L-6-v2', label: 'MS MARCO MiniLM L6 v2 (22M, fastest)' },
];

const FALLBACK_MODELS: Array<{ name: string; label: string }> = [
  { name: '', label: 'None (no fallback)' },
  { name: 'BAAI/bge-reranker-v2-m3', label: 'BGE Reranker v2 M3 — Reliable fallback (568M)' },
  { name: 'BAAI/bge-reranker-large', label: 'BGE Reranker Large (560M)' },
  { name: 'cross-encoder/ms-marco-MiniLM-L-6-v2', label: 'MiniLM — Fastest fallback (22M)' },
];

export default function AdminRerankingSettings({ initialConfig }: Props) {
  const [enabled, setEnabled] = useState(initialConfig.rerankEnabled);
  const [provider, setProvider] = useState(initialConfig.rerankProvider);
  const [model, setModel] = useState(initialConfig.rerankModel);
  const [host, setHost] = useState(initialConfig.rerankHost || 'http://10.10.20.5:8099');
  const [topN, setTopN] = useState(initialConfig.rerankTopN);
  const [autoManage, setAutoManage] = useState(initialConfig.rerankAutoManage);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(initialConfig.rerankIdleTimeoutMin);
  const [fallbackModel, setFallbackModel] = useState(initialConfig.rerankFallbackModel || '');
  const [scoreValidation, setScoreValidation] = useState(initialConfig.rerankScoreValidation);
  const [rerankUseOrchestrator, setRerankUseOrchestrator] = useState(!!initialConfig.rerankUseOrchestrator);
  const [gpuMemUtil, setGpuMemUtil] = useState(initialConfig.gpuMemUtilReranker ?? 0.6);
  const [gpuIdleEmbedding, setGpuIdleEmbedding] = useState(initialConfig.gpuIdleEmbeddingMin);
  const [gpuIdleCompletion, setGpuIdleCompletion] = useState(initialConfig.gpuIdleCompletionMin);
  const [gpuIdleOcr, setGpuIdleOcr] = useState(initialConfig.gpuIdleOcrMin);
  const [gpuIdleReranker, setGpuIdleReranker] = useState(initialConfig.gpuIdleRerankerMin);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Pass through existing embedding config so the route doesn't reject
          embeddingProvider: initialConfig.embeddingProvider,
          embeddingModel: initialConfig.embeddingModel,
          openaiApiKey: initialConfig.openaiApiKey,
          claudeApiKey: initialConfig.claudeApiKey,
          ollamaHost: initialConfig.ollamaHost,
          ollamaModel: initialConfig.ollamaModel,
          // Reranking fields
          rerankEnabled: enabled,
          rerankProvider: provider,
          rerankModel: model,
          rerankHost: host,
          rerankTopN: topN,
          rerankAutoManage: autoManage,
          rerankIdleTimeoutMin: idleTimeoutMin,
          rerankFallbackModel: fallbackModel,
          rerankScoreValidation: scoreValidation,
          gpuIdleEmbeddingMin: gpuIdleEmbedding,
          gpuIdleCompletionMin: gpuIdleCompletion,
          gpuIdleOcrMin: gpuIdleOcr,
          gpuIdleRerankerMin: gpuIdleReranker,
          rerankUseOrchestrator,
          gpuMemUtilReranker: gpuMemUtil,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save');
      }
      setSaveMessage({ type: 'success', text: 'Reranking configuration saved.' });
    } catch (e: any) {
      setSaveMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {saveMessage && (
        <div className={`p-4 rounded-md ${
          saveMessage.type === 'success'
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          {saveMessage.text}
        </div>
      )}

      {/* Enable / Disable Toggle */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Reranking</h2>
            <p className="text-sm text-gray-600 mt-1">
              Re-score search results using a cross-encoder model for higher relevance accuracy.
            </p>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              enabled ? 'bg-blue-600' : 'bg-gray-200'
            }`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>
      </div>

      {/* Provider Selection */}
      <div className={`bg-white shadow rounded-lg p-6 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Reranking Provider</h2>
        <p className="text-sm text-gray-600 mb-4">
          Choose the backend for cross-encoder reranking.
        </p>
        <div className="space-y-3">
          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="rerank-provider"
              value="vllm"
              checked={provider === 'vllm'}
              onChange={() => setProvider('vllm')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">vLLM Server (GPU-Accelerated)</div>
              <div className="text-sm text-gray-600">
                Connect to a vLLM server running a cross-encoder reranking model. Supports Jina/Cohere-compatible /v1/rerank endpoint.
              </div>
            </div>
          </label>

          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="rerank-provider"
              value="none"
              checked={provider === 'none'}
              onChange={() => setProvider('none')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Disabled</div>
              <div className="text-sm text-gray-600">
                No reranking — use raw vector similarity scores only.
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* Model Selection */}
      {provider === 'vllm' && (
        <div className={`bg-white shadow rounded-lg p-6 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Reranking Model</h2>
          <p className="text-sm text-gray-600 mb-4">
            Choose the cross-encoder model served by vLLM.
          </p>

          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {RERANK_MODELS.map((m) => (
              <option key={m.name} value={m.name}>{m.label}</option>
            ))}
          </select>

          {/* Install instructions */}
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex gap-2 mb-2">
              <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-blue-800">Start the model on your vLLM server</h4>
                <p className="text-xs text-blue-700 mt-1">
                  Run this command on the machine running vLLM (e.g. Windows WSL2 with GPU):
                </p>
                <pre className="mt-2 px-3 py-2 bg-gray-900 text-green-400 text-sm rounded font-mono select-all">
                  vllm serve {model} --host 0.0.0.0 --port 8099
                </pre>
                <p className="text-xs text-blue-600 mt-2">
                  The model will auto-download from HuggingFace on first launch. Exposes /v1/rerank endpoint.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fallback Model + Score Validation */}
      {provider === 'vllm' && (
        <div className={`bg-white shadow rounded-lg p-6 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Fallback &amp; Score Validation</h2>
          <p className="text-sm text-gray-600 mb-4">
            Protect against bad reranker output. If the primary model fails or returns degenerate scores,
            fall back to a different model or use the original vector search order.
          </p>

          <div className="space-y-4">
            {/* Fallback Model */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fallback Reranking Model</label>
              <select
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {FALLBACK_MODELS.map((m) => (
                  <option key={m.name} value={m.name}>{m.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                If the primary model (e.g. Qwen3-Reranker) returns an error, retry with this model.
                BAAI models are standard cross-encoders that work reliably with vLLM without needing hf_overrides.
                The fallback model must be loaded on the same vLLM server.
              </p>
            </div>

            {/* Score Validation Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <div className="font-medium text-gray-900">Score Validation</div>
                <div className="text-sm text-gray-600">
                  Check reranker output for degenerate scores (all zeros, all identical, near-zero variance).
                  If detected, discard reranked order and keep original vector similarity ranking.
                </div>
              </div>
              <button
                onClick={() => setScoreValidation(!scoreValidation)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  scoreValidation ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  scoreValidation ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* Warning about fallback model needing to be loaded */}
            {fallbackModel && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-xs text-amber-800">
                  <strong>Note:</strong> The fallback model must be loaded on the same vLLM instance.
                  vLLM serves one model at a time by default — use <code className="px-1 py-0.5 bg-amber-100 rounded">--served-model-name</code> or
                  run a separate vLLM process for the fallback. Alternatively, rely on score validation alone
                  to detect bad output without needing a second model.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Use Orchestrator Toggle */}
      {provider === 'vllm' && (
        <div className={`bg-white shadow rounded-lg p-6 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-gray-900 text-sm">Use Orchestrator</div>
              <div className="text-xs text-gray-500 mt-0.5">
                Endpoint auto-assigned by GPU fleet router based on sidecar availability and load.
              </div>
            </div>
            <button
              onClick={() => setRerankUseOrchestrator(!rerankUseOrchestrator)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                rerankUseOrchestrator ? 'bg-blue-600' : 'bg-gray-200'
              }`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                rerankUseOrchestrator ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>
          {rerankUseOrchestrator && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Managed by Orchestrator
              </span>
              <span className="text-xs text-green-700">Reranker endpoint is auto-resolved via GPU fleet router.</span>
            </div>
          )}
        </div>
      )}

      {/* GPU Weight (memory allocation) */}
      {provider === 'vllm' && (
        <WeightSection
          role="reranker"
          value={gpuMemUtil}
          onChange={setGpuMemUtil}
          disabled={!enabled}
        />
      )}

      {/* vLLM Host + Top N */}
      {provider === 'vllm' && !rerankUseOrchestrator && (
        <VllmHostConfig
          host={host}
          onHostChange={setHost}
          model={model}
          topN={topN}
          onTopNChange={setTopN}
          disabled={!enabled}
        />
      )}

      {/* Container Lifecycle Management */}
      {provider === 'vllm' && (
        <div className={`bg-white shadow rounded-lg p-6 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">GPU Memory Management</h2>
              <p className="text-sm text-gray-600 mt-1">
                Auto-stop the Docker container after idle to free GPU VRAM for other models (e.g. Ollama).
                Restarts automatically on next search (~30-60s cold start).
              </p>
            </div>
            <button
              onClick={() => setAutoManage(!autoManage)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                autoManage ? 'bg-blue-600' : 'bg-gray-200'
              }`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                autoManage ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>

          {autoManage && (
            <ContainerAgentConfig
              host={host}
              idleTimeoutMin={idleTimeoutMin}
              onIdleTimeoutChange={setIdleTimeoutMin}
              gpuIdleEmbedding={gpuIdleEmbedding}
              onGpuIdleEmbeddingChange={setGpuIdleEmbedding}
              gpuIdleCompletion={gpuIdleCompletion}
              onGpuIdleCompletionChange={setGpuIdleCompletion}
              gpuIdleOcr={gpuIdleOcr}
              onGpuIdleOcrChange={setGpuIdleOcr}
              gpuIdleReranker={gpuIdleReranker}
              onGpuIdleRerankerChange={setGpuIdleReranker}
            />
          )}
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Reranking Configuration'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────── vLLM Host Config with Test Button ──────────────── */

function VllmHostConfig({
  host,
  onHostChange,
  model,
  topN,
  onTopNChange,
  disabled,
}: {
  host: string;
  onHostChange: (h: string) => void;
  model: string;
  topN: number;
  onTopNChange: (n: number) => void;
  disabled: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string; message?: string } | null>(null);

  const handleTest = async () => {
    if (!host) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/rerank-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, model }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ valid: false, error: 'Request failed' });
    }
    setTesting(false);
  };

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <h2 className="text-xl font-semibold text-gray-900 mb-4">vLLM Server Connection</h2>
      <p className="text-sm text-gray-600 mb-4">
        Enter the URL of your vLLM server. Test will send a reranking request to verify the model is loaded and responding.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">vLLM Host URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={host}
              onChange={(e) => { onHostChange(e.target.value); setTestResult(null); }}
              placeholder="http://10.10.20.5:8099"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleTest}
              disabled={!host || testing}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {testing ? 'Testing...' : 'Test Reranking'}
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            No API key needed. Example: <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-700">http://10.10.20.5:8099</code>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Top N Results</label>
          <input
            type="number"
            min={1}
            max={100}
            value={topN}
            onChange={(e) => onTopNChange(Math.max(1, parseInt(e.target.value) || 10))}
            className="w-32 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Number of results to keep after reranking (default: 10).
          </p>
        </div>

        {testResult && (
          <div className={`text-sm px-3 py-2 rounded ${
            testResult.valid ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {testResult.valid
              ? (testResult.message || `Reranking test successful — ${model} is working`)
              : `Test failed: ${testResult.error || 'Unknown error'}`}
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────── Container Agent Config with Test / Start / Stop ──────────────── */

function ContainerAgentConfig({
  host,
  idleTimeoutMin,
  onIdleTimeoutChange,
  gpuIdleEmbedding,
  onGpuIdleEmbeddingChange,
  gpuIdleCompletion,
  onGpuIdleCompletionChange,
  gpuIdleOcr,
  onGpuIdleOcrChange,
  gpuIdleReranker,
  onGpuIdleRerankerChange,
}: {
  host: string;
  idleTimeoutMin: number;
  onIdleTimeoutChange: (n: number) => void;
  gpuIdleEmbedding: number;
  onGpuIdleEmbeddingChange: (n: number) => void;
  gpuIdleCompletion: number;
  onGpuIdleCompletionChange: (n: number) => void;
  gpuIdleOcr: number;
  onGpuIdleOcrChange: (n: number) => void;
  gpuIdleReranker: number;
  onGpuIdleRerankerChange: (n: number) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null);
  const [containerStatus, setContainerStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const agentUrl = host ? (() => {
    try { return `http://${new URL(host).hostname}:8098`; }
    catch { return null; }
  })() : null;

  const handleTest = async () => {
    if (!host) return;
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/agent-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      const data = await res.json();
      if (data.valid) {
        setContainerStatus(data.containerStatus || null);
        setMessage({ type: 'success', text: data.message });
      } else {
        setContainerStatus(null);
        setMessage({ type: 'error', text: data.error || 'Test failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Request failed' });
    }
    setTesting(false);
  };

  const handleAction = async (action: 'start' | 'stop') => {
    if (!host) return;
    setActionLoading(action);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/agent-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, action }),
      });
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setContainerStatus(data.status || null);
        setMessage({ type: 'success', text: data.message });
      }
    } catch {
      setMessage({ type: 'error', text: `Failed to ${action} container` });
    }
    setActionLoading(null);
  };

  const statusBadge = containerStatus ? (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
      containerStatus === 'running'
        ? 'bg-green-100 text-green-700'
        : containerStatus === 'exited'
        ? 'bg-gray-100 text-gray-600'
        : 'bg-amber-100 text-amber-700'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        containerStatus === 'running' ? 'bg-green-500' : containerStatus === 'exited' ? 'bg-gray-400' : 'bg-amber-500'
      }`} />
      {containerStatus}
    </span>
  ) : null;

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Per-Model Idle Timeouts (minutes)</label>
        <p className="text-xs text-gray-500 mb-3">
          Each GPU workload can have its own idle timeout. Set 0 to never auto-stop. Container restarts automatically on next request (~30-60s cold start).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Embedding</label>
            <input
              type="number"
              min={0}
              max={120}
              value={gpuIdleEmbedding}
              onChange={(e) => onGpuIdleEmbeddingChange(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-0.5 text-xs text-gray-400">0 = never stop</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Completion</label>
            <input
              type="number"
              min={0}
              max={120}
              value={gpuIdleCompletion}
              onChange={(e) => onGpuIdleCompletionChange(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">OCR</label>
            <input
              type="number"
              min={0}
              max={120}
              value={gpuIdleOcr}
              onChange={(e) => onGpuIdleOcrChange(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reranker</label>
            <input
              type="number"
              min={0}
              max={120}
              value={gpuIdleReranker}
              onChange={(e) => onGpuIdleRerankerChange(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Container Agent + Container Control */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Container Agent {statusBadge}
        </label>
        <div className="flex gap-2">
          <div className="flex-1 px-3 py-2 border border-gray-200 rounded-md bg-gray-50 text-sm text-gray-600">
            {agentUrl || 'Set vLLM host URL above first'}
          </div>
          <button
            onClick={handleTest}
            disabled={!host || testing}
            className="px-3 py-2 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {testing ? 'Testing...' : 'Test'}
          </button>
        </div>
      </div>

      {/* Start / Stop Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => handleAction('start')}
          disabled={!host || actionLoading !== null || containerStatus === 'running'}
          className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {actionLoading === 'start' ? (
            <span className="flex items-center gap-1.5">
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Starting...
            </span>
          ) : 'Start Container'}
        </button>
        <button
          onClick={() => handleAction('stop')}
          disabled={!host || actionLoading !== null || containerStatus === 'exited'}
          className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {actionLoading === 'stop' ? (
            <span className="flex items-center gap-1.5">
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Stopping...
            </span>
          ) : 'Stop Container'}
        </button>
        <span className="text-xs text-gray-500 self-center ml-1">
          {containerStatus === 'running' ? 'Free GPU VRAM by stopping' : containerStatus === 'exited' ? 'Model will take ~30-60s to load' : 'Test connection first'}
        </span>
      </div>

      {/* Status / Error Message */}
      {message && (
        <div className={`text-sm px-3 py-2 rounded ${
          message.type === 'success'
            ? 'bg-green-50 text-green-700 border border-green-200'
            : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-xs text-blue-800">
          <strong>Requires sidecar agent:</strong> Run <code className="px-1 py-0.5 bg-blue-100 rounded">sideCar/scripts/start-docker-agent.bat</code> on
          the GPU machine. The agent manages the reranker container via Docker socket — no Docker TCP daemon exposure needed.
          Override agent port with <code className="px-1 py-0.5 bg-blue-100 rounded">RERANKER_AGENT_PORT</code> env var (default: 8098).
        </p>
      </div>
    </div>
  );
}
