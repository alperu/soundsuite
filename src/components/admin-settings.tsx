'use client';

/**
 * Admin Settings Component
 * 
 * Provides UI for configuring embedding providers, models, and API keys.
 * Includes model download management for transformers.js models.
 * 
 * Requirements: 18.1, 18.3, 18.4, 18.5, 18.9, 18.10, 18.11, 18.12, 18.13, 18.14, 18.15, 18.16
 */

import { useState, useEffect } from 'react';
import { AppConfig, ModelDownloadInfo } from '@/lib/db/config';

interface AdminSettingsProps {
  initialConfig: AppConfig;
  initialModelDownloads: ModelDownloadInfo[];
}

// Available models for each provider
const PROVIDER_MODELS: Record<string, Array<{ name: string; label: string; size: number }>> = {
  transformers: [
    { name: 'Xenova/all-MiniLM-L6-v2', label: 'all-MiniLM-L6-v2 (384 dims, ~90MB)', size: 90 * 1024 * 1024 },
    { name: 'Xenova/all-mpnet-base-v2', label: 'all-mpnet-base-v2 (768 dims, ~420MB)', size: 420 * 1024 * 1024 },
  ],
  openai: [
    { name: 'text-embedding-3-small', label: 'text-embedding-3-small (1536 dims)', size: 0 },
    { name: 'text-embedding-3-large', label: 'text-embedding-3-large (3072 dims)', size: 0 },
    { name: 'text-embedding-ada-002', label: 'text-embedding-ada-002 (1536 dims)', size: 0 },
  ],
  claude: [
    { name: 'claude-3-opus-20240229', label: 'Claude 3 Opus', size: 0 },
    { name: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet', size: 0 },
    { name: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku', size: 0 },
  ],
  ollama: [
    { name: 'qwen3-embedding:0.6b', label: 'Qwen3 Embedding 0.6B (1024 dims, 32K context) — Best for Legal', size: 639 * 1024 * 1024 },
    { name: 'qwen3-embedding:4b', label: 'Qwen3 Embedding 4B (1024 dims, 40K context) — Highest Quality', size: 2500 * 1024 * 1024 },
    { name: 'qwen3-embedding:8b', label: 'Qwen3 Embedding 8B (1024 dims, 32K context) — #1 MTEB (MLEB: 85.0, ~5GB)', size: 5000 * 1024 * 1024 },
    { name: 'nomic-embed-text', label: 'nomic-embed-text (768 dims, 8K context)', size: 274 * 1024 * 1024 },
    { name: 'snowflake-arctic-embed2', label: 'snowflake-arctic-embed2 (1024 dims, 8K context)', size: 1200 * 1024 * 1024 },
    { name: 'bge-m3', label: 'bge-m3 (1024 dims, 8K context, multilingual)', size: 1200 * 1024 * 1024 },
    { name: 'all-minilm', label: 'all-minilm (384 dims, lightweight)', size: 46 * 1024 * 1024 },
  ],
};

export default function AdminSettings({ initialConfig, initialModelDownloads }: AdminSettingsProps) {
  const [config, setConfig] = useState<AppConfig>(initialConfig);
  const [modelDownloads, setModelDownloads] = useState<ModelDownloadInfo[]>(initialModelDownloads);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showModelChangeWarning, setShowModelChangeWarning] = useState(false);
  const [originalModel, setOriginalModel] = useState(initialConfig.embeddingModel);

  // Get available models for current provider
  const availableModels = PROVIDER_MODELS[config.embeddingProvider] || [];

  // Check if API key is required
  const requiresApiKey = config.embeddingProvider === 'openai' || config.embeddingProvider === 'claude';
  const requiresOllamaHost = config.embeddingProvider === 'ollama';

  // Handle provider change
  const handleProviderChange = (provider: 'transformers' | 'openai' | 'claude' | 'ollama') => {
    const newModels = PROVIDER_MODELS[provider];
    const defaultModel = newModels[0]?.name || '';
    
    setConfig({
      ...config,
      embeddingProvider: provider,
      embeddingModel: defaultModel,
      // Keep ollamaModel in sync when switching to ollama
      ...(provider === 'ollama' ? { ollamaModel: defaultModel } : {}),
    });
    
    // Show warning if changing from original model
    if (defaultModel !== originalModel) {
      setShowModelChangeWarning(true);
    }
  };

  // Handle model change
  const handleModelChange = (model: string) => {
    setConfig({
      ...config,
      embeddingModel: model,
      // Keep ollamaModel in sync when provider is ollama
      ...(config.embeddingProvider === 'ollama' ? { ollamaModel: model } : {}),
    });
    
    // Show warning if changing from original model
    if (model !== originalModel) {
      setShowModelChangeWarning(true);
    } else {
      setShowModelChangeWarning(false);
    }
  };

  // Handle save
  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save configuration');
      }

      setSaveMessage({ type: 'success', text: 'Configuration saved successfully!' });
      setOriginalModel(config.embeddingModel);
      setShowModelChangeWarning(false);
    } catch (error: any) {
      setSaveMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  // Handle model download
  const handleDownloadModel = async (modelName: string) => {
    try {
      const response = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start download');
      }

      // Start polling for progress
      pollDownloadProgress(modelName);
    } catch (error: any) {
      setSaveMessage({ type: 'error', text: error.message });
    }
  };

  // Handle model deletion
  const handleDeleteModel = async (modelName: string) => {
    if (!confirm(`Are you sure you want to delete ${modelName}? This will free up disk space.`)) {
      return;
    }

    try {
      const response = await fetch('/api/models/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete model');
      }

      // Refresh model downloads
      const statusResponse = await fetch('/api/models/status');
      const downloads = await statusResponse.json();
      setModelDownloads(downloads);

      setSaveMessage({ type: 'success', text: 'Model deleted successfully!' });
    } catch (error: any) {
      setSaveMessage({ type: 'error', text: error.message });
    }
  };

  // Poll for download progress
  const pollDownloadProgress = (modelName: string) => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch('/api/models/status');
        const downloads = await response.json();
        setModelDownloads(downloads);

        // Check if download is complete or failed
        const download = downloads.find((d: ModelDownloadInfo) => d.modelName === modelName);
        if (download && (download.status === 'downloaded' || download.status === 'error')) {
          clearInterval(interval);
          
          if (download.status === 'downloaded') {
            setSaveMessage({ type: 'success', text: `Model ${modelName} downloaded successfully!` });
          } else {
            setSaveMessage({ type: 'error', text: `Failed to download ${modelName}: ${download.errorMessage}` });
          }
        }
      } catch (error) {
        clearInterval(interval);
      }
    }, 1000);
  };

  // Get download info for a model
  const getModelDownloadInfo = (modelName: string): ModelDownloadInfo | undefined => {
    return modelDownloads.find(d => d.modelName === modelName);
  };

  // Format bytes to human-readable size
  const formatBytes = (bytes: number | bigint): string => {
    const num = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    if (num === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(num) / Math.log(k));
    return Math.round(num / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="space-y-8">
      {/* Save Message */}
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

      {/* Model Change Warning */}
      {showModelChangeWarning && (
        <div className="p-4 rounded-md bg-yellow-50 text-yellow-800 border border-yellow-200">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium">Model Change Warning</h3>
              <p className="mt-1 text-sm">
                Changing the embedding model will require reprocessing all existing documents for consistency.
                Documents indexed with the old model may not be searchable until reprocessed.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Embedding Provider Selection */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Embedding Provider</h2>
        <p className="text-sm text-gray-600 mb-4">
          Choose how embeddings are generated for semantic search.
        </p>

        <div className="space-y-3">
          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="provider"
              value="transformers"
              checked={config.embeddingProvider === 'transformers'}
              onChange={() => handleProviderChange('transformers')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Transformers.js (Local)</div>
              <div className="text-sm text-gray-600">
                Run embeddings locally on your machine. No API key required. Privacy-preserving.
              </div>
            </div>
          </label>

          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="provider"
              value="openai"
              checked={config.embeddingProvider === 'openai'}
              onChange={() => handleProviderChange('openai')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">OpenAI</div>
              <div className="text-sm text-gray-600">
                High-quality cloud-based embeddings. Requires API key and internet connection.
              </div>
            </div>
          </label>

          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="provider"
              value="claude"
              checked={config.embeddingProvider === 'claude'}
              onChange={() => handleProviderChange('claude')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Claude (Anthropic)</div>
              <div className="text-sm text-gray-600">
                Note: Claude does not currently provide embeddings. This option is a placeholder.
              </div>
            </div>
          </label>

          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="provider"
              value="ollama"
              checked={config.embeddingProvider === 'ollama'}
              onChange={() => handleProviderChange('ollama')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Ollama (GPU-Accelerated)</div>
              <div className="text-sm text-gray-600">
                Connect to a remote or local Ollama server for GPU-accelerated embeddings. No API key required.
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* Model Selection */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Model Selection</h2>
        <p className="text-sm text-gray-600 mb-4">
          Choose the specific model to use for {config.embeddingProvider} embeddings.
        </p>

        <select
          value={config.embeddingModel}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {availableModels.map((model) => (
            <option key={model.name} value={model.name}>
              {model.label}
            </option>
          ))}
        </select>

        {/* Ollama Model Install Instructions */}
        {config.embeddingProvider === 'ollama' && (
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex gap-2 mb-2">
              <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-blue-800">Model must be installed on your Ollama server</h4>
                <p className="text-xs text-blue-700 mt-1">
                  Run this command on the machine running Ollama to install the selected embedding model:
                </p>
                <pre className="mt-2 px-3 py-2 bg-gray-900 text-green-400 text-sm rounded font-mono select-all">
                  ollama pull {config.embeddingModel}
                </pre>
                <p className="text-xs text-blue-600 mt-2">
                  {config.embeddingModel.startsWith('qwen3-embedding')
                    ? config.embeddingModel === 'qwen3-embedding:4b'
                      ? 'Highest quality for legal docs (MLEB: 82.6). 1024 dims, 40K context. ~2.5GB download. Needs ~5GB RAM.'
                      : 'Best value for legal docs (MLEB: 76.4). 768 dims, 32K context. ~639MB download. Needs ~1.2GB RAM.'
                    : config.embeddingModel === 'nomic-embed-text'
                      ? 'Good general-purpose model. 768 dims, 8K context. ~274MB. Outperformed by Qwen3 on legal benchmarks.'
                      : `Selected model size: ~${formatBytes(availableModels.find(m => m.name === config.embeddingModel)?.size || 0)}.`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Transformers.js Model Management */}
        {config.embeddingProvider === 'transformers' && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg font-medium text-gray-900">Model Downloads</h3>
            
            {availableModels.map((model) => {
              const downloadInfo = getModelDownloadInfo(model.name);
              const isDownloaded = downloadInfo?.status === 'downloaded';
              const isDownloading = downloadInfo?.status === 'downloading';
              const hasError = downloadInfo?.status === 'error';

              return (
                <div key={model.name} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium text-gray-900">{model.name}</div>
                      <div className="text-sm text-gray-600">
                        {isDownloaded && downloadInfo.sizeBytes
                          ? `Downloaded: ${formatBytes(downloadInfo.sizeBytes)}`
                          : `Estimated size: ${formatBytes(model.size)}`}
                      </div>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                      {isDownloaded ? (
                        <>
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            Downloaded
                          </span>
                          <button
                            onClick={() => handleDeleteModel(model.name)}
                            className="px-3 py-1 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded"
                          >
                            Delete
                          </button>
                        </>
                      ) : isDownloading ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          Downloading...
                        </span>
                      ) : hasError ? (
                        <>
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Error
                          </span>
                          <button
                            onClick={() => handleDownloadModel(model.name)}
                            className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                          >
                            Retry
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleDownloadModel(model.name)}
                          className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                        >
                          Download
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  {isDownloading && downloadInfo && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                        <span>Progress</span>
                        <span>{Math.round(downloadInfo.downloadProgress)}%</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${downloadInfo.downloadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Error Message */}
                  {hasError && downloadInfo?.errorMessage && (
                    <div className="mt-2 text-sm text-red-600">
                      {downloadInfo.errorMessage}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* API Key Configuration */}
      {requiresApiKey && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">API Key</h2>
          <p className="text-sm text-gray-600 mb-4">
            Enter your {config.embeddingProvider === 'openai' ? 'OpenAI' : 'Anthropic'} API key.
          </p>

          <input
            type="password"
            value={
              config.embeddingProvider === 'openai'
                ? config.openaiApiKey || ''
                : config.claudeApiKey || ''
            }
            onChange={(e) => {
              if (config.embeddingProvider === 'openai') {
                setConfig({ ...config, openaiApiKey: e.target.value });
              } else {
                setConfig({ ...config, claudeApiKey: e.target.value });
              }
            }}
            placeholder={`Enter ${config.embeddingProvider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          
          <p className="mt-2 text-xs text-gray-500">
            Your API key is stored securely and never shared.
          </p>
        </div>
      )}

      {/* Ollama Host Configuration */}
      {requiresOllamaHost && (
        <>
          {/* Use Orchestrator Toggle */}
          <div className="bg-white shadow rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Endpoint Mode</h2>
                <p className="text-sm text-gray-600 mt-1">Use Orchestrator — endpoint auto-assigned by GPU fleet router based on sidecar availability and load.</p>
              </div>
              <button
                onClick={() => setConfig({ ...config, embeddingUseOrchestrator: !config.embeddingUseOrchestrator })}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  config.embeddingUseOrchestrator ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  config.embeddingUseOrchestrator ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>
            {config.embeddingUseOrchestrator && (
              <div className="mt-4 flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Managed by Orchestrator
                </span>
                <span className="text-xs text-green-700">Embedding endpoint is auto-resolved via GPU fleet router.</span>
              </div>
            )}
          </div>

          {!config.embeddingUseOrchestrator && (
            <OllamaHostConfig
              host={config.ollamaHost || ''}
              onHostChange={(host) => setConfig({ ...config, ollamaHost: host })}
              embeddingModel={config.embeddingModel}
            />
          )}
        </>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────── Ollama Host Config with Test Button ──────────────── */

function OllamaHostConfig({ host, onHostChange, embeddingModel }: { host: string; onHostChange: (host: string) => void; embeddingModel?: string }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string; message?: string; dimensions?: number } | null>(null);

  const handleTest = async () => {
    if (!host) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/ai-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', apiKey: host, embeddingModel }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ valid: false, error: 'Request failed' });
    }
    setTesting(false);
  };

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">Ollama Server</h2>
      <p className="text-sm text-gray-600 mb-4">
        Enter the URL of your Ollama server. Test will verify the embedding model is installed and working.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Ollama Host URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={host}
              onChange={(e) => { onHostChange(e.target.value); setTestResult(null); }}
              placeholder="http://10.10.20.5:11434"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleTest}
              disabled={!host || testing}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {testing ? 'Testing...' : 'Test Embedding'}
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            No API key needed. Example: <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-700">http://192.168.1.100:11434</code>
          </p>
        </div>

        {testResult && (
          <div className={`text-sm px-3 py-2 rounded ${
            testResult.valid ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {testResult.valid
              ? (testResult.message || `Embedding test successful — ${embeddingModel} is working`)
              : `Test failed: ${testResult.error || 'Unknown error'}`}
          </div>
        )}
      </div>
    </div>
  );
}
