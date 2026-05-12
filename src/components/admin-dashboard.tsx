'use client';

/**
 * AdminDashboard — Tabbed admin interface.
 *
 * Tabs: System Health | Embedding Config | Workers | Redis Cache | Filing Types | Jobs | Action Log
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import AdminSettings from '@/components/admin-settings';
import AdminRerankingSettings from '@/components/admin-reranking-settings';
import GpuFleetPanel from '@/components/admin-gpu-fleet';
import AdminRoleTypes from '@/components/admin-role-types';
import AdminRoleAssignments from '@/components/admin-role-assignments';
import CacheManager from '@/components/admin/cache-manager';
import { CopyButton } from '@/components/copy-button';
import { AppConfig, ModelDownloadInfo } from '@/lib/db/config';

interface Props {
  initialConfig: AppConfig;
  initialModelDownloads: ModelDownloadInfo[];
  initialTab?: TabKey;
}

type TabKey = 'general' | 'health' | 'embedding' | 'reranking' | 'gpu' | 'roletypes' | 'roleassign' | 'ocr' | 'localai' | 'aikeys' | 'workers' | 'redis' | 'cache' | 'filings' | 'jobs' | 'actionlog' | 'drafts';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'general', label: 'General', icon: '⊞' },
  { key: 'health', label: 'System Health', icon: '♥' },
  { key: 'embedding', label: 'Embedding', icon: '⬡' },
  { key: 'reranking', label: 'Reranking', icon: '⇅' },
  { key: 'gpu', label: 'GPU Fleet', icon: '⊛' },
  { key: 'roletypes', label: 'Mode Types', icon: '◆' },
  { key: 'roleassign', label: 'Role Assignments', icon: '⇆' },
  { key: 'ocr', label: 'OCR', icon: '◉' },
  { key: 'localai', label: 'Local AI', icon: '⊚' },
  { key: 'aikeys', label: 'AI Keys $', icon: '⚷' },
  { key: 'workers', label: 'Workers', icon: '⚙' },
  { key: 'redis', label: 'Redis Cache', icon: '⧫' },
  { key: 'cache', label: 'Cache Manager', icon: '⟲' },
  { key: 'filings', label: 'Filing Types', icon: '▤' },
  { key: 'jobs', label: 'Jobs', icon: '▶' },
  { key: 'actionlog', label: 'Action Log', icon: '☰' },
  { key: 'drafts', label: 'Drafts', icon: '✎' },
];

const TAB_DOCS: Record<TabKey, { title: string; description: string; details: string[] }> = {
  general: {
    title: 'General',
    description: 'Server identity, network addresses, and MCP endpoint information.',
    details: [
      'MCP Endpoint URL — the address external tools (Claude Desktop, scripts) should use to call MCP tools',
      'Server hostname, primary IP, and listening port',
      'All network interfaces with IPv4/IPv6 addresses',
      'Platform info: OS, architecture, Node.js version, CPUs, memory',
    ],
  },
  health: {
    title: 'System Health',
    description: 'Overview of all running services, database statistics, and document processing status.',
    details: [
      'Uptime and database record counts (cases, documents, action logs)',
      'Service status for FileWatcher, JobQueue, MCP Server, and Redis',
      'Document breakdown by processing status (QUEUED, PROCESSING, INDEXED, ERROR)',
    ],
  },
  embedding: {
    title: 'Embedding Configuration',
    description: 'Configure the embedding model used for document vector indexing and semantic search.',
    details: [
      'Qwen3 Embedding 0.6B is recommended for legal docs — 32K context, MLEB score 76.4, ~639MB',
      'Qwen3 Embedding 4B is highest quality — 40K context, MLEB score 82.6, needs ~5GB RAM',
      'nomic-embed-text is a lighter alternative — 8K context, 768 dims, ~274MB',
      'Ollama models need GPU — install with: ollama pull <model-name>',
      'Changing models requires re-indexing all documents',
      'MLEB (Massive Legal Embedding Benchmark) measures legal retrieval accuracy',
    ],
  },
  reranking: {
    title: 'Reranking Configuration',
    description: 'Configure cross-encoder reranking to improve search result relevance beyond vector similarity.',
    details: [
      'Reranking re-scores search results using a cross-encoder model for higher precision',
      'Runs on a vLLM server — typically a GPU machine (e.g. Windows WSL2)',
      'Qwen3-Reranker-8B is the default — instruction-aware, high quality',
      'Lighter options: BGE Reranker Base (278M) or MS MARCO MiniLM (22M)',
      'Start vLLM: vllm serve Qwen/Qwen3-Reranker-8B --host 0.0.0.0 --port 8099',
      'Uses /v1/rerank endpoint (Jina/Cohere-compatible)',
      'Top N controls how many results survive reranking (default: 10)',
    ],
  },
  gpu: {
    title: 'GPU Fleet Management',
    description: 'Register, monitor, and control GPU sidecar agents across your fleet.',
    details: [
      'Register sidecar agents by URL — they run on GPU machines alongside Docker',
      'Dual-mode communication: direct HTTP or WebSocket tunnel (for NAT/firewall)',
      'Start/stop containers remotely with one click',
      'Per-model idle timeouts auto-stop containers to free GPU VRAM',
      'Push timeout config to all connected sidecars at once',
    ],
  },
  roletypes: {
    title: 'Mode Types',
    description: 'Fixed catalog of 4 GPU workload modes. Sidecars auto-resolve image/port/VRAM by host OS.',
    details: [
      'ss-embedding — document and query embeddings (vector search)',
      'ss-completion — chat / completion model for agent calls',
      'ss-ocr — vision-LLM OCR for scanned PDFs and exhibit images',
      'ss-reranker — cross-encoder reranking (Linux + NVIDIA only; vllm-metal lacks cross-encoders)',
      'To assign modes to hosts, see the Role Assignments tab',
    ],
  },
  roleassign: {
    title: 'Role Assignments',
    description: 'Pick which modes each sidecar should run. Per-host model and runtime overrides.',
    details: [
      'Click a chip to toggle a mode on/off — auto-syncs within a few seconds',
      'Unavailable modes (e.g. ss-reranker on macOS) are greyed out with a tooltip',
      'Click the gear on an enabled chip to override model / minOnline / idle timeout',
      'Reset to defaults restores per-OS sensible assignments for a sidecar',
    ],
  },
  ocr: {
    title: 'OCR Provider & Image Preprocessing',
    description: 'Configure the OCR engine and image preprocessing pipeline for extracting text from scanned pages.',
    details: [
      'Local PaddleOCR runs on CPU with no external dependencies',
      'Ollama Vision offloads OCR to a remote GPU via vision models like olmOCR-2',
      'Image Preprocessing: upscale + grayscale + normalize + CLAHE + sharpen + resize',
      'Smart Upscale: images < 1000px or < 150 DPI are upscaled 2x with Lanczos3',
      'CLAHE fixes shadows and uneven lighting (+10-15% on poor scans)',
      'All preprocessing steps are individually toggleable',
    ],
  },
  localai: {
    title: 'Local AI (Ollama)',
    description: 'Connect to your Ollama server for free, private, GPU-accelerated AI completions.',
    details: [
      'No API key needed — just a host URL to your Ollama server',
      'Uses your chosen Ollama model for completions (chat, analysis, document summaries)',
      'All data stays on your network — fully private',
      'When configured, Ollama is used as the primary AI provider',
      'Install models: ollama pull qwen3.5:14b',
    ],
  },
  aikeys: {
    title: 'AI Keys (Paid)',
    description: 'Manage API keys for paid cloud AI providers. Used as fallback when Ollama is not configured.',
    details: [
      'Cloud providers charge per API call ($)',
      'Configure keys for OpenAI, Anthropic, Groq, and Grok (xAI)',
      'Test keys to verify they are valid before saving',
      'Keys are used for AI-powered search (RAG) and MCP analysis tools',
      'If Local AI (Ollama) is configured, it takes priority over cloud providers',
    ],
  },
  workers: {
    title: 'Worker Pool & PID Controller',
    description: 'Monitor and tune the PID-controlled worker pool that dynamically allocates resources between UI and background tasks.',
    details: [
      'Worker allocation bar shows real-time UI vs BG worker split',
      'PID gains (Kp, Ki, Kd) can be edited live to tune responsiveness',
      'Queue activity shows request rates and queue depths',
      'Parsing workers process QUEUED documents through the ingestion pipeline',
      'Force Rebalance triggers an immediate PID recalculation',
    ],
  },
  redis: {
    title: 'Redis Cache',
    description: 'Inspect and manage the Redis cache used for folder counts, filing detection results, and worker pool state.',
    details: [
      'View all cached keys grouped by namespace',
      'See key types and TTL values',
      'Flush the entire cache when stale data needs clearing',
    ],
  },
  cache: {
    title: 'Cache Manager',
    description: 'View and clear all cache layers, manage document reindexing, and monitor ingestion checkpoints.',
    details: [
      'View Redis cache key counts by namespace (filings, folders, progress)',
      'Clear individual cache layers or flush all Redis caches',
      'Monitor active ingestion checkpoints for crash-resumed documents',
      'Reindex selected documents or all documents at once',
      'Documents preserve OCR checkpoints during reindex for faster resume',
    ],
  },
  filings: {
    title: 'Filing Types',
    description: 'Manage the list of court filing types used for automatic document classification.',
    details: [
      'Add new filing types (e.g., "Motion to Dismiss", "Exhibit")',
      'Rename existing types to correct labeling',
      'Remove types no longer needed',
      'Types are used by the semantic classifier when detecting filings in PDFs',
    ],
  },
  jobs: {
    title: 'Jobs',
    description: 'View background job queue status and historical processing logs.',
    details: [
      'Active queue shows currently running and pending jobs',
      'Job logs record each batch run with document counts and error summaries',
      'Track documents queued, processed, and failed per run',
    ],
  },
  actionlog: {
    title: 'Action Log',
    description: 'Searchable, filterable audit trail of all system actions and events.',
    details: [
      'Search actions by keyword across all fields',
      'Filter by log type (document_added, filing_created, error, etc.)',
      'Paginated table with time, action, target, status, and detail columns',
      'Export filtered results as CSV for external analysis',
    ],
  },
  drafts: {
    title: 'Draft Settings',
    description: 'Configure page size, margins, and defaults for the document drafting editor.',
    details: [
      'Page size: Letter, A4, or Legal',
      'Custom margins (top, bottom, left, right) in inches',
      'Margins apply to Page View mode in the draft editor',
    ],
  },
};

export default function AdminDashboard({ initialConfig, initialModelDownloads, initialTab = 'general' }: Props) {
  const router = useRouter();
  const activeTab = initialTab;
  const setActiveTab = (tab: TabKey) => router.push(`/admin/${tab}`);
  const docs = TAB_DOCS[activeTab];

  return (
    <div className="flex flex-col h-full">
      {/* Header row — same visual level as columns */}
      <div className="flex items-baseline gap-3 mb-3 flex-shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
        <span className="text-sm text-gray-400">/</span>
        <span className="text-sm font-medium text-blue-600">{docs.title}</span>
      </div>

      {/* 3-column layout */}
      <div className="flex flex-1 min-h-0 border border-gray-200 rounded-lg overflow-hidden bg-white">
        {/* Left: Tab navigation */}
        <nav className="flex-shrink-0 w-44 bg-gray-50 border-r border-gray-200 overflow-y-auto">
          <div className="py-2">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`w-full text-left px-4 py-2.5 text-[13px] font-medium transition-colors flex items-center gap-2.5 ${
                  activeTab === tab.key
                    ? 'bg-blue-50 text-blue-700 border-r-2 border-r-blue-500'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                }`}
              >
                <span className="text-base leading-none opacity-60">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Center: Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto p-6 min-w-0">
          {activeTab === 'general' && <GeneralPanel />}
          {activeTab === 'health' && <SystemHealthPanel />}
          {activeTab === 'embedding' && <AdminSettings initialConfig={initialConfig} initialModelDownloads={initialModelDownloads} />}
          {activeTab === 'reranking' && <AdminRerankingSettings initialConfig={initialConfig} />}
          {activeTab === 'gpu' && <GpuFleetPanel />}
          {activeTab === 'roletypes' && <AdminRoleTypes />}
          {activeTab === 'roleassign' && <AdminRoleAssignments />}
          {activeTab === 'ocr' && <OCRProviderPanel initialConfig={initialConfig} />}
          {activeTab === 'localai' && <LocalAIPanel />}
          {activeTab === 'aikeys' && <AIKeysPanel />}
          {activeTab === 'workers' && <WorkersPanel />}
          {activeTab === 'redis' && <RedisCachePanel />}
          {activeTab === 'cache' && <CacheManager />}
          {activeTab === 'filings' && <FilingTypesPanel />}
          {activeTab === 'jobs' && <JobsPanel />}
          {activeTab === 'actionlog' && <ActionLogPanel />}
          {activeTab === 'drafts' && <DraftAdminPanel initialConfig={initialConfig} />}
        </div>

        {/* Right: Documentation panel */}
        <aside className="flex-shrink-0 w-64 bg-gray-50 border-l border-gray-200 overflow-y-auto p-5">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1.5">{docs.title}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{docs.description}</p>
            </div>
            <div className="border-t border-gray-200 pt-3">
              <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Details</h4>
              <ul className="space-y-2">
                {docs.details.map((d, i) => (
                  <li key={i} className="flex gap-2 text-xs text-gray-500 leading-relaxed">
                    <span className="text-gray-300 mt-0.5 flex-shrink-0">&#8226;</span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ──────────────────────────── General Panel ──────────────────────────── */

interface ServerInfo {
  hostname: string;
  port: string;
  primaryIP: string;
  mcpEndpoint: string;
  interfaces: { name: string; address: string; family: string; internal: boolean }[];
  platform: { os: string; arch: string; nodeVersion: string; cpuCount: number; totalMemory: number; freeMemory: number };
  uptime: { os: number; process: number };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function GeneralPanel() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/server-info');
      if (res.ok) setInfo(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (!info) return <p className="text-gray-500">Failed to load server info.</p>;

  return (
    <div className="space-y-6">
      {/* MCP Endpoint — prominent card */}
      <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-lg font-semibold text-blue-900">MCP Endpoint</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">POST</span>
        </div>
        <p className="text-sm text-blue-700 mb-3">
          External tools (Claude Desktop, scripts, curl) should use this URL to call MCP tools.
        </p>
        <div className="flex items-center gap-2 bg-white border border-blue-200 rounded-lg px-4 py-2.5">
          <code className="flex-1 text-sm font-mono text-gray-800 select-all break-all">{info.mcpEndpoint}</code>
          <CopyButton text={info.mcpEndpoint} />
        </div>
        <div className="mt-3 text-xs text-blue-600">
          Example: <code className="px-1.5 py-0.5 bg-white rounded border border-blue-200 text-gray-700">
            curl -X POST {info.mcpEndpoint} -H &quot;Content-Type: application/json&quot; -d &apos;{'{"tool":"list_tools","params":{}}'}&apos;
          </code>
        </div>
      </div>

      {/* Server Identity */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Server Identity</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Hostname" value={info.hostname} />
          <Stat label="Port" value={info.port} />
          <Stat label="Primary IP" value={info.primaryIP} />
          <Stat label="Process Uptime" value={formatUptime(info.uptime.process)} />
        </div>
      </div>

      {/* Network Interfaces */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Network Interfaces</h3>
        <div className="space-y-1.5">
          {info.interfaces.map((iface, i) => (
            <div key={`${iface.name}-${iface.address}-${i}`} className="flex items-center gap-3 px-3 py-2 rounded hover:bg-gray-50 text-sm">
              <span className="font-medium text-gray-700 w-16 flex-shrink-0">{iface.name}</span>
              <code className="font-mono text-gray-800 flex-1">{iface.address}</code>
              <span className="text-xs text-gray-400">{iface.family}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                iface.internal ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'
              }`}>
                {iface.internal ? 'internal' : 'external'}
              </span>
              <CopyButton text={iface.address} />
            </div>
          ))}
        </div>
      </div>

      {/* Platform */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Platform</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Stat label="OS" value={info.platform.os} />
          <Stat label="Arch" value={info.platform.arch} />
          <Stat label="Node.js" value={info.platform.nodeVersion} />
          <Stat label="CPUs" value={info.platform.cpuCount} />
          <Stat label="Total Memory" value={formatBytes(info.platform.totalMemory)} />
          <Stat label="Free Memory" value={formatBytes(info.platform.freeMemory)} />
        </div>
      </div>

      {/* Uptime */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Uptime</h3>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="OS Uptime" value={formatUptime(info.uptime.os)} />
          <Stat label="Process Uptime" value={formatUptime(info.uptime.process)} />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── System Health Panel ─────────────────────────── */

function SystemHealthPanel() {
  const [info, setInfo] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/system-info');
      if (res.ok) setInfo(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (!info) return <p className="text-gray-500">Failed to load system info.</p>;

  const statusColor = (s: string) => {
    if (s === 'running' || s === 'healthy') return 'bg-green-100 text-green-800';
    if (s === 'stopped' || s === 'unknown' || s === 'degraded') return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
  };

  return (
    <div className="space-y-6">
      {/* Uptime */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">System Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Uptime" value={info.uptime?.formatted || '-'} />
          <Stat label="Cases" value={info.database?.cases ?? 0} />
          <Stat label="Documents" value={info.database?.documents ?? 0} />
          <Stat label="Action Logs" value={info.database?.actionLogs ?? 0} />
        </div>
      </div>

      {/* Service Status */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Services</h3>
          <button onClick={load} className="text-sm text-blue-600 hover:underline">Refresh</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {['fileWatcher', 'jobQueue', 'mcpServer'].map(key => {
            const svc = info.services?.[key];
            return (
              <div key={key} className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700 capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor(svc?.status || 'unknown')}`}>
                    {svc?.status || 'unknown'}
                  </span>
                </div>
                <p className="text-xs text-gray-500 truncate">{svc?.message || '-'}</p>
              </div>
            );
          })}
          {/* Redis */}
          <div className="border rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">Redis</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${info.redis?.available ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                {info.redis?.available ? 'connected' : 'unavailable'}
              </span>
            </div>
            <p className="text-xs text-gray-500">
              {info.redis?.available ? `${info.redis.memoryUsed} | ${info.redis.keyCount} keys` : 'Not connected'}
            </p>
          </div>
        </div>
      </div>

      {/* Document Status Breakdown */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Documents by Status</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(info.database?.documentsByStatus || {}).map(([status, count]) => (
            <div key={status} className="border rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{count as number}</div>
              <div className="text-xs text-gray-500 uppercase">{status}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── OCR Provider Panel ──────────────────────────── */

const OLLAMA_OCR_MODELS = [
  { id: 'richardyoung/olmocr2:7b-q8', label: 'olmOCR-2 Q8 (~9 GB VRAM) — Best accuracy, Apache 2.0', vram: '~9 GB' },
  { id: 'minicpm-v', label: 'MiniCPM-V 2.6 (~8 GB) — Beats GPT-4o on OCRBench', vram: '~8 GB' },
  { id: 'llama3.2-vision', label: 'Llama 3.2 Vision 11B (~12 GB) — Good general vision', vram: '~12 GB' },
];

function OCRProviderPanel({ initialConfig }: { initialConfig: AppConfig }) {
  const [provider, setProvider] = useState<'local' | 'ollama'>(initialConfig.ocrProvider || 'local');
  const [host, setHost] = useState(initialConfig.ocrOllamaHost || initialConfig.ollamaHost || '');
  const [model, setModel] = useState(initialConfig.ocrOllamaModel || 'richardyoung/olmocr2:7b-q8');
  const [ocrUseOrchestrator, setOcrUseOrchestrator] = useState(!!initialConfig.ocrUseOrchestrator);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string; extractedText?: string; durationMs?: number } | null>(null);

  // Image preprocessing settings
  const [ppUpscale, setPpUpscale] = useState(initialConfig.ocrUpscale ?? true);
  const [ppMinWidth, setPpMinWidth] = useState(initialConfig.ocrMinWidth ?? 1000);
  const [ppMinDpi, setPpMinDpi] = useState(initialConfig.ocrMinDpi ?? 150);
  const [ppGrayscale, setPpGrayscale] = useState(initialConfig.ocrGrayscale ?? true);
  const [ppNormalize, setPpNormalize] = useState(initialConfig.ocrNormalize ?? true);
  const [ppClahe, setPpClahe] = useState(initialConfig.ocrClahe ?? true);
  const [ppClaheClipLimit, setPpClaheClipLimit] = useState(initialConfig.ocrClaheClipLimit ?? 3);
  const [ppSharpen, setPpSharpen] = useState(initialConfig.ocrSharpen ?? true);
  const [ppSharpenSigma, setPpSharpenSigma] = useState(initialConfig.ocrSharpenSigma ?? 1.0);
  const [ppResize, setPpResize] = useState(initialConfig.ocrResize ?? true);
  const [ppMaxWidth, setPpMaxWidth] = useState(initialConfig.ocrMaxWidth ?? 2048);
  const [ppPngCompression, setPpPngCompression] = useState(initialConfig.ocrPngCompression ?? 6);
  const [ppSaving, setPpSaving] = useState(false);
  const [ppSaveSuccess, setPpSaveSuccess] = useState(false);

  const handleSavePreprocessing = async () => {
    setPpSaving(true);
    setPpSaveSuccess(false);
    try {
      const res = await fetch('/api/config/pipeline', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ocrUpscale: ppUpscale,
          ocrMinWidth: ppMinWidth,
          ocrMinDpi: ppMinDpi,
          ocrGrayscale: ppGrayscale,
          ocrNormalize: ppNormalize,
          ocrClahe: ppClahe,
          ocrClaheClipLimit: ppClaheClipLimit,
          ocrSharpen: ppSharpen,
          ocrSharpenSigma: ppSharpenSigma,
          ocrResize: ppResize,
          ocrMaxWidth: ppMaxWidth,
          ocrPngCompression: ppPngCompression,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setPpSaveSuccess(true);
      setTimeout(() => setPpSaveSuccess(false), 3000);
    } catch {
      setSaveError('Failed to save preprocessing settings');
    }
    setPpSaving(false);
  };

  const handleTest = async () => {
    if (!host) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/config/ocr-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, model }),
      });
      const result = await res.json();
      setTestResult(result);
    } catch {
      setTestResult({ success: false, error: 'Request failed' });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    setSaveError('');
    try {
      // Read current config, merge OCR fields, save
      const configRes = await fetch('/api/config');
      if (!configRes.ok) throw new Error('Failed to read config');
      const currentConfig = await configRes.json();

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...currentConfig,
          ocrProvider: provider,
          ocrOllamaHost: host || undefined,
          ocrOllamaModel: model,
          ocrUseOrchestrator,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save');
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      {/* Provider Selection */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">OCR Provider</h2>
        <p className="text-sm text-gray-600 mb-4">
          Choose how text is extracted from scanned pages and exhibit images.
        </p>

        <div className="space-y-3">
          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="ocrProvider"
              value="local"
              checked={provider === 'local'}
              onChange={() => setProvider('local')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Local PaddleOCR</div>
              <div className="text-sm text-gray-600">
                Fast CPU-based OCR via PaddleOCR. No GPU required. Runs as forked child processes.
              </div>
            </div>
          </label>

          <label className="flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="ocrProvider"
              value="ollama"
              checked={provider === 'ollama'}
              onChange={() => setProvider('ollama')}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="ml-3">
              <div className="font-medium text-gray-900">Ollama Vision (Remote GPU)</div>
              <div className="text-sm text-gray-600">
                GPU-accelerated OCR via Ollama vision models. Offload OCR to a remote machine with a powerful GPU.
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* Ollama OCR Configuration */}
      {provider === 'ollama' && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Ollama OCR Settings</h2>

          <div className="space-y-4">
            {/* Use Orchestrator Toggle */}
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div>
                <div className="font-medium text-gray-900 text-sm">Use Orchestrator</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Endpoint auto-assigned by GPU fleet router based on sidecar availability and load.
                </div>
              </div>
              <button
                onClick={() => setOcrUseOrchestrator(!ocrUseOrchestrator)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  ocrUseOrchestrator ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  ocrUseOrchestrator ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {ocrUseOrchestrator && (
              <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Managed by Orchestrator
                </span>
                <span className="text-xs text-green-700">OCR endpoint is auto-resolved via GPU fleet router.</span>
              </div>
            )}

            {/* Model Selection — always visible */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Vision Model</label>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {OLLAMA_OCR_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* Model info */}
            {(() => {
              const selected = OLLAMA_OCR_MODELS.find(m => m.id === model);
              if (!selected) return null;
              return (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex gap-2">
                    <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-blue-800">{selected.id}</h4>
                      <p className="text-xs text-blue-600 mt-1">VRAM: {selected.vram}</p>
                      {!ocrUseOrchestrator && (
                        <>
                          <p className="text-xs text-blue-700 mt-2 font-medium">
                            Install on your Ollama server:
                          </p>
                          <pre className="mt-1 px-3 py-2 bg-gray-900 text-green-400 text-sm rounded font-mono select-all">
                            ollama pull {model}
                          </pre>
                        </>
                      )}
                      {ocrUseOrchestrator && (
                        <p className="text-xs text-blue-600 mt-1">Model will be auto-pulled by sidecars when acquired.</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Host URL + Test — only when not using orchestrator */}
            {!ocrUseOrchestrator && (
            <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ollama Host URL</label>
              <input
                type="text"
                value={host}
                onChange={e => { setHost(e.target.value); setTestResult(null); }}
                placeholder="http://10.10.20.5:11434"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                URL of the Ollama server with a GPU. Defaults to your embedding Ollama host if not set.
              </p>
            </div>

            {/* Test Connection */}
            {testResult && (
              <div className={`text-sm px-3 py-2 rounded ${
                testResult.success
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                {testResult.success
                  ? testResult.message || 'OCR test successful'
                  : `Test failed: ${testResult.error || 'Unknown error'}`}
                {testResult.success && testResult.extractedText && (
                  <div className="mt-2 p-2 bg-white rounded border text-xs font-mono text-gray-700 whitespace-pre-wrap">
                    {testResult.extractedText}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleTest}
              disabled={!host || testing}
              className="w-full px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? 'Testing OCR...' : 'Test Connection'}
            </button>
            </>
            )}
          </div>
        </div>
      )}

      {/* Image Preprocessing Settings */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Image Preprocessing</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure how images are optimized before OCR. Each step improves accuracy at different scan quality levels.
        </p>

        <div className="space-y-5">
          {/* Step 0: Smart Upscale */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ppUpscale} onChange={e => setPpUpscale(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                  <span className="font-medium text-gray-900">Smart Upscale</span>
                </label>
                <p className="text-xs text-gray-500 ml-6">Upscale small/low-DPI images 2x with Lanczos3. Makes small text readable for OCR models.</p>
              </div>
              <span className="text-xs font-mono text-green-700 bg-green-50 px-2 py-0.5 rounded">2-4x faster inference</span>
            </div>
            {ppUpscale && (
              <div className="ml-6 mt-3 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Min Width (px)</label>
                  <input type="number" value={ppMinWidth} onChange={e => setPpMinWidth(Number(e.target.value))} min={200} max={4000} step={100}
                    className="w-full px-2 py-1 border rounded text-sm" />
                  <p className="text-[10px] text-gray-400 mt-0.5">Images narrower than this get 2x upscale</p>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Min DPI</label>
                  <input type="number" value={ppMinDpi} onChange={e => setPpMinDpi(Number(e.target.value))} min={50} max={600} step={10}
                    className="w-full px-2 py-1 border rounded text-sm" />
                  <p className="text-[10px] text-gray-400 mt-0.5">Images below this DPI get 2x upscale</p>
                </div>
              </div>
            )}
          </div>

          {/* Step 1: Grayscale */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ppGrayscale} onChange={e => setPpGrayscale(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                <span className="font-medium text-gray-900">Grayscale</span>
              </label>
              <span className="text-xs font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded">~30% fewer tokens</span>
            </div>
            <p className="text-xs text-gray-500 ml-6">1 channel vs 3. Legal docs are black text on white paper.</p>
          </div>

          {/* Step 2: Normalize */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ppNormalize} onChange={e => setPpNormalize(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                <span className="font-medium text-gray-900">Normalize</span>
              </label>
              <span className="text-xs font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">+5-10% on faded scans</span>
            </div>
            <p className="text-xs text-gray-500 ml-6">Stretches contrast so faint text becomes clear.</p>
          </div>

          {/* Step 3: CLAHE */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ppClahe} onChange={e => setPpClahe(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                  <span className="font-medium text-gray-900">CLAHE (Adaptive Contrast)</span>
                </label>
                <p className="text-xs text-gray-500 ml-6">Fixes shadows, bleed-through, and uneven lighting.</p>
              </div>
              <span className="text-xs font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">+10-15% on poor scans</span>
            </div>
            {ppClahe && (
              <div className="ml-6 mt-2">
                <label className="block text-xs text-gray-600 mb-1">Clip Limit (1-10)</label>
                <input type="range" value={ppClaheClipLimit} onChange={e => setPpClaheClipLimit(Number(e.target.value))} min={1} max={10} step={1}
                  className="w-48" />
                <span className="ml-2 text-sm font-mono text-gray-700">{ppClaheClipLimit}</span>
              </div>
            )}
          </div>

          {/* Step 4: Sharpen */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ppSharpen} onChange={e => setPpSharpen(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                  <span className="font-medium text-gray-900">Sharpen</span>
                </label>
                <p className="text-xs text-gray-500 ml-6">Crisper text edges = fewer recognition errors.</p>
              </div>
              <span className="text-xs font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">+3-5% accuracy</span>
            </div>
            {ppSharpen && (
              <div className="ml-6 mt-2">
                <label className="block text-xs text-gray-600 mb-1">Sigma (0.1-5.0)</label>
                <input type="range" value={ppSharpenSigma} onChange={e => setPpSharpenSigma(Number(e.target.value))} min={0.1} max={5} step={0.1}
                  className="w-48" />
                <span className="ml-2 text-sm font-mono text-gray-700">{ppSharpenSigma.toFixed(1)}</span>
              </div>
            )}
          </div>

          {/* Step 5: Smart Resize (Downscale) */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ppResize} onChange={e => setPpResize(e.target.checked)} className="h-4 w-4 rounded text-blue-600" />
                  <span className="font-medium text-gray-900">Smart Resize (Downscale)</span>
                </label>
                <p className="text-xs text-gray-500 ml-6">Caps large images. 8.7M px to 1.8M px = far fewer visual tokens.</p>
              </div>
              <span className="text-xs font-mono text-green-700 bg-green-50 px-2 py-0.5 rounded">2-4x faster</span>
            </div>
            {ppResize && (
              <div className="ml-6 mt-2">
                <label className="block text-xs text-gray-600 mb-1">Max Width (px)</label>
                <input type="number" value={ppMaxWidth} onChange={e => setPpMaxWidth(Number(e.target.value))} min={512} max={8192} step={256}
                  className="w-32 px-2 py-1 border rounded text-sm" />
              </div>
            )}
          </div>

          {/* PNG Compression */}
          <div className="border rounded-lg p-4">
            <label className="block text-xs text-gray-600 mb-1">PNG Compression Level (0=fastest, 9=smallest)</label>
            <input type="range" value={ppPngCompression} onChange={e => setPpPngCompression(Number(e.target.value))} min={0} max={9} step={1}
              className="w-48" />
            <span className="ml-2 text-sm font-mono text-gray-700">{ppPngCompression}</span>
            <p className="text-[10px] text-gray-400 mt-0.5">PNG avoids JPEG artifacts that confuse OCR. Level 6 is a good balance.</p>
          </div>
        </div>

        {/* Save Preprocessing */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSavePreprocessing}
            disabled={ppSaving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {ppSaving ? 'Saving...' : 'Save Preprocessing Settings'}
          </button>
          {ppSaveSuccess && (
            <span className="text-sm text-green-600">Saved! Changes apply to next document processed.</span>
          )}
        </div>
      </div>

      {/* Save OCR Provider */}
      {saveSuccess && (
        <div className="text-sm px-3 py-2 rounded bg-green-50 text-green-700 border border-green-200">
          OCR configuration saved successfully. Pipeline will reinitialize with new settings.
        </div>
      )}
      {saveError && (
        <div className="text-sm px-3 py-2 rounded bg-red-50 text-red-700 border border-red-200">
          {saveError}
        </div>
      )}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save OCR Configuration'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────── Local AI Panel ──────────────────────────── */

const OLLAMA_COMPLETION_MODELS = [
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 9B — Recommended (8GB VRAM)', context: '256K', vram: '~6GB', desc: 'Best balance of speed and quality. Latest generation Qwen multimodal, 256K context, fast inference, excellent legal analysis.' },
  { id: 'qwen3.5:4b', label: 'Qwen 3.5 4B (4GB VRAM)', context: '256K', vram: '~3GB', desc: 'Ultra-lightweight latest-gen model. Good for low-end GPUs.' },
  { id: 'qwen3.5:27b', label: 'Qwen 3.5 27B (20GB VRAM)', context: '256K', vram: '~17GB', desc: 'High quality latest-gen model. Excellent legal analysis for GPUs with 24GB+ VRAM.' },
  { id: 'qwen2.5:14b', label: 'Qwen 2.5 14B (12GB VRAM)', context: '128K', vram: '~10GB', desc: 'Previous generation. Good balance of speed and quality. 128K context, fast inference.' },
  { id: 'llama3.3:70b', label: 'Llama 3.3 70B (48GB VRAM)', context: '128K', vram: '~40GB', desc: 'Best quality but requires 48GB+ VRAM. Slow if VRAM is insufficient.' },
  { id: 'llama3.1:70b', label: 'Llama 3.1 70B (48GB VRAM)', context: '128K', vram: '~40GB', desc: 'Previous generation. Similar context window but slightly less capable than 3.3.' },
  { id: 'qwen2.5:72b', label: 'Qwen 2.5 72B (48GB VRAM)', context: '128K', vram: '~42GB', desc: 'Strong multilingual model. Excellent at structured output and code generation.' },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B (8GB VRAM)', context: '128K', vram: '~6GB', desc: 'Lightweight model for basic tasks. Fast but less capable for complex legal analysis.' },
  { id: 'deepseek-r1:70b', label: 'DeepSeek R1 70B (48GB VRAM)', context: '64K', vram: '~40GB', desc: 'Reasoning-focused model. Good for step-by-step legal analysis but slower inference.' },
  { id: 'mistral:7b', label: 'Mistral 7B (8GB VRAM)', context: '32K', vram: '~5GB', desc: 'Ultra-lightweight. Only for basic tasks on low-end GPUs.' },
];

function LocalAIPanel() {
  const [host, setHost] = useState('');
  const [completionModel, setCompletionModel] = useState('');
  const [completionUseOrchestrator, setCompletionUseOrchestrator] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [configured, setConfigured] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const configRes = await fetch('/api/config');
      if (configRes.ok) {
        const config = await configRes.json();
        const completionHost = config.ollamaCompletionHost || '';
        if (completionHost) setHost(completionHost);
        setConfigured(!!completionHost);
        if (config.ollamaCompletionModel) setCompletionModel(config.ollamaCompletionModel);
        setCompletionUseOrchestrator(!!config.completionUseOrchestrator);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleTest = async () => {
    if (!host) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/ai-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', apiKey: host }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ valid: false, error: 'Request failed' });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    if (!host && !configured) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      // Save completion host and model via config route (separate from embedding host)
      const configRes = await fetch('/api/config');
      if (configRes.ok) {
        const config = await configRes.json();
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...config,
            ollamaCompletionHost: host || config.ollamaCompletionHost,
            ollamaCompletionModel: completionModel,
            completionUseOrchestrator,
          }),
        });
      }
      setSaveSuccess(true);
      setConfigured(!!host);
      await loadConfig();
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch { /* silent */ }
    setSaving(false);
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {/* Use Orchestrator Toggle */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-gray-900 text-sm">Use Orchestrator</div>
            <div className="text-xs text-gray-500 mt-0.5">
              Endpoint auto-assigned by GPU fleet router based on sidecar availability and load.
            </div>
          </div>
          <button
            onClick={() => setCompletionUseOrchestrator(!completionUseOrchestrator)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              completionUseOrchestrator ? 'bg-blue-600' : 'bg-gray-200'
            }`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              completionUseOrchestrator ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>
        {completionUseOrchestrator && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              Managed by Orchestrator
            </span>
            <span className="text-xs text-green-700">Completion endpoint is auto-resolved via GPU fleet router.</span>
          </div>
        )}
      </div>

      {/* Connection */}
      {!completionUseOrchestrator && (
      <div className="bg-white shadow rounded-lg p-5 border-2 border-blue-100">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Ollama Server</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">Free</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">GPU-Accelerated</span>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {configured ? 'Connected' : 'Not Configured'}
          </span>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Host URL</label>
            <input
              type="text"
              value={host}
              onChange={e => { setHost(e.target.value); setTestResult(null); }}
              placeholder={configured ? '(host saved — enter new URL to change)' : 'http://10.10.20.5:11434'}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">No API key needed. Just the URL of your Ollama server. Example: <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-700">http://192.168.1.100:11434</code></p>
          </div>

          {testResult && (
            <div className={`text-xs px-3 py-1.5 rounded ${
              testResult.valid ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {testResult.valid ? 'Connection successful — Ollama is reachable' : `Failed: ${testResult.error || 'Unknown error'}`}
            </div>
          )}

          {saveSuccess && (
            <div className="text-xs px-3 py-1.5 rounded bg-green-50 text-green-700">
              Saved successfully
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleTest}
              disabled={!host || testing}
              className="flex-1 px-3 py-1.5 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              onClick={handleSave}
              disabled={(!host && !configured) || saving}
              className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Completion Model */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Completion Model</h3>
        <p className="text-sm text-gray-600 mb-3">
          Used for MCP tools, AI search, document summarization, and analysis.
        </p>
        <select
          value={completionModel}
          onChange={e => setCompletionModel(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {OLLAMA_COMPLETION_MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        {/* Model info box */}
        {(() => {
          const selected = OLLAMA_COMPLETION_MODELS.find(m => m.id === completionModel);
          if (!selected) return null;
          return (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex gap-2 mb-2">
                <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-blue-800">{selected.id}</h4>
                  <p className="text-xs text-blue-700 mt-1">{selected.desc}</p>
                  <div className="flex gap-4 mt-2">
                    <span className="text-xs text-blue-600"><span className="font-medium">Context:</span> {selected.context} tokens</span>
                    <span className="text-xs text-blue-600"><span className="font-medium">VRAM:</span> {selected.vram}</span>
                  </div>
                  <p className="text-xs text-blue-700 mt-2 font-medium">
                    Install on your Ollama server:
                  </p>
                  <pre className="mt-1 px-3 py-2 bg-gray-900 text-green-400 text-sm rounded font-mono select-all">
                    ollama pull {completionModel}
                  </pre>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Why Local AI */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Why Local AI?</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="border rounded-lg p-3">
            <div className="text-sm font-medium text-gray-800 mb-1">Larger Context Window</div>
            <div className="text-xs text-gray-500">Ollama models support up to 128K context vs 4K-32K for most cloud APIs. Better for analyzing long court filings.</div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-sm font-medium text-gray-800 mb-1">Free &amp; Unlimited</div>
            <div className="text-xs text-gray-500">No per-token charges. Process thousands of documents without API costs.</div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-sm font-medium text-gray-800 mb-1">Privacy</div>
            <div className="text-xs text-gray-500">All data stays on your network. No court documents sent to cloud APIs.</div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-sm font-medium text-gray-800 mb-1">GPU-Accelerated</div>
            <div className="text-xs text-gray-500">Runs on your NVIDIA GPU for fast inference. A6000 48GB handles 70B models easily.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── AI Keys Panel ──────────────────────────── */

const AI_PROVIDERS_UI = [
  { key: 'openai', name: 'OpenAI', placeholder: 'sk-...' },
  { key: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'groq', name: 'Groq', placeholder: 'gsk_...' },
  { key: 'grok', name: 'Grok (xAI)', placeholder: 'xai-...' },
] as const;

function AIKeysPanel() {
  const [status, setStatus] = useState<Record<string, { configured: boolean; name: string }>>({});
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, { valid: boolean; error?: string } | null>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveSuccess, setSaveSuccess] = useState<Record<string, boolean>>({});

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/ai-keys');
      if (res.ok) setStatus(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleTest = async (provider: string) => {
    const key = keys[provider];
    if (!key) return;
    setTesting(prev => ({ ...prev, [provider]: true }));
    setTestResult(prev => ({ ...prev, [provider]: null }));
    try {
      const res = await fetch('/api/admin/ai-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: key }),
      });
      const result = await res.json();
      setTestResult(prev => ({ ...prev, [provider]: result }));
    } catch {
      setTestResult(prev => ({ ...prev, [provider]: { valid: false, error: 'Request failed' } }));
    }
    setTesting(prev => ({ ...prev, [provider]: false }));
  };

  const handleSave = async (provider: string) => {
    const key = keys[provider];
    if (key === undefined) return;
    setSaving(prev => ({ ...prev, [provider]: true }));
    setSaveSuccess(prev => ({ ...prev, [provider]: false }));
    try {
      const res = await fetch('/api/admin/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: key }),
      });
      if (res.ok) {
        setSaveSuccess(prev => ({ ...prev, [provider]: true }));
        await loadStatus();
        setTimeout(() => setSaveSuccess(prev => ({ ...prev, [provider]: false })), 2000);
      }
    } catch { /* silent */ }
    setSaving(prev => ({ ...prev, [provider]: false }));
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {AI_PROVIDERS_UI.map(({ key: provider, name, placeholder }) => {
          const info = status[provider];
          const configured = info?.configured ?? false;
          const keyValue = keys[provider] ?? '';
          const isShow = showKey[provider] ?? false;
          const isTesting = testing[provider] ?? false;
          const isSaving = saving[provider] ?? false;
          const result = testResult[provider];
          const saved = saveSuccess[provider] ?? false;

          return (
            <div key={provider} className="bg-white shadow rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-gray-900">{name}</h3>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 font-medium">$</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {configured ? 'Configured' : 'Not Set'}
                </span>
              </div>

              <div className="space-y-3">
                <div className="relative">
                  <input
                    type={isShow ? 'text' : 'password'}
                    value={keyValue}
                    onChange={e => {
                      setKeys(prev => ({ ...prev, [provider]: e.target.value }));
                      setTestResult(prev => ({ ...prev, [provider]: null }));
                    }}
                    placeholder={configured ? '********** (key saved)' : placeholder}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(prev => ({ ...prev, [provider]: !isShow }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                  >
                    {isShow ? 'Hide' : 'Show'}
                  </button>
                </div>

                {result && (
                  <div className={`text-xs px-3 py-1.5 rounded ${
                    result.valid ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                  }`}>
                    {result.valid ? 'Key is valid' : `Invalid: ${result.error || 'Unknown error'}`}
                  </div>
                )}

                {saved && (
                  <div className="text-xs px-3 py-1.5 rounded bg-green-50 text-green-700">
                    Saved successfully
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => handleTest(provider)}
                    disabled={!keyValue || isTesting}
                    className="flex-1 px-3 py-1.5 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isTesting ? 'Testing...' : 'Test Key'}
                  </button>
                  <button
                    onClick={() => handleSave(provider)}
                    disabled={keyValue === '' && !configured || isSaving}
                    className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ──────────────────────────── Workers Panel ──────────────────────────── */

interface PoolManageResponse {
  pool: {
    totalWorkers: number;
    uiWorkers: number;
    bgWorkers: number;
    uiQueueDepth: number;
    bgQueueDepth: number;
    uiRequestRate: number;
    pid: { integral: number; prevError: number; idleCycles: number; kp: number; ki: number; kd: number };
    metrics: { uiRequestsTotal: number; uiRequestsProcessed: number; bgTasksTotal: number; bgTasksProcessed: number; pidAdjustments: number; documentsParsed: number };
    documentBacklog: number;
  } | null;
  parsingWorkers: { count: number; workers: { workerId: string; running: boolean; currentDocumentId: string | null }[] } | null;
  daemon: { running: boolean } | null;
}

function WorkersPanel() {
  const [data, setData] = useState<PoolManageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [actionLoading, setActionLoading] = useState('');

  // Parsing worker count slider state
  const [parsingCount, setParsingCount] = useState<number>(1);
  const [parsingCountSaving, setParsingCountSaving] = useState(false);

  // PID inline edit state
  const [editPid, setEditPid] = useState<{ kp: string; ki: string; kd: string } | null>(null);
  // Pool config inline edit state
  const [editPool, setEditPool] = useState<{ total: string; minUi: string; minBg: string } | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await fetch('/api/worker-pool/manage');
      if (res.ok) {
        const json = await res.json();
        setData(json);
        // Sync slider with actual worker count
        if (json.parsingWorkers?.count != null) {
          setParsingCount(json.parsingWorkers.count);
        }
      }
    } catch { /* silent */ }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-poll every 2s
  useEffect(() => {
    if (!autoPoll) return;
    const interval = setInterval(() => load(true), 2000);
    return () => clearInterval(interval);
  }, [autoPoll, load]);

  const doAction = async (action: string, body: Record<string, unknown> = {}) => {
    setActionLoading(action);
    try {
      const res = await fetch('/api/worker-pool/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      if (res.ok) await load(true);
    } catch { /* silent */ }
    setActionLoading('');
  };

  const handleParsingCountChange = async (newCount: number) => {
    setParsingCount(newCount);
    setParsingCountSaving(true);
    try {
      const res = await fetch('/api/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: newCount }),
      });
      if (res.ok) await load(true);
    } catch { /* silent */ }
    setParsingCountSaving(false);
  };

  const handleSavePid = async () => {
    if (!editPid) return;
    const kp = parseFloat(editPid.kp);
    const ki = parseFloat(editPid.ki);
    const kd = parseFloat(editPid.kd);
    if ([kp, ki, kd].some(isNaN)) return;
    await doAction('update_pid', { kp, ki, kd });
    setEditPid(null);
  };

  const handleSavePool = async () => {
    if (!editPool) return;
    const total = parseInt(editPool.total, 10);
    if (isNaN(total) || total < 3 || total > 100) return;
    await doAction('scale', { totalWorkers: total });
    setEditPool(null);
  };

  if (loading) return <Spinner />;
  if (!data) return <p className="text-gray-500">Failed to load worker pool state.</p>;

  const pool = data.pool;
  const pw = data.parsingWorkers;

  return (
    <div className="space-y-6">
      {/* Worker Allocation Bar */}
      {pool && (
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900">Worker Allocation</h3>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer">
                <input type="checkbox" checked={autoPoll} onChange={e => setAutoPoll(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                Auto-refresh
              </label>
              <button onClick={() => load(true)} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>
          </div>

          {/* Animated stacked bar */}
          <div className="relative h-10 bg-gray-100 rounded-lg overflow-hidden mb-2">
            <div
              className="absolute inset-y-0 left-0 bg-blue-500 transition-all duration-500 ease-in-out flex items-center justify-center"
              style={{ width: `${pool.totalWorkers > 0 ? (pool.uiWorkers / pool.totalWorkers) * 100 : 0}%` }}
            >
              {pool.uiWorkers > 1 && (
                <span className="text-white text-xs font-medium">UI: {pool.uiWorkers}</span>
              )}
            </div>
            <div
              className="absolute inset-y-0 bg-green-500 transition-all duration-500 ease-in-out flex items-center justify-center"
              style={{
                left: `${pool.totalWorkers > 0 ? (pool.uiWorkers / pool.totalWorkers) * 100 : 0}%`,
                width: `${pool.totalWorkers > 0 ? (pool.bgWorkers / pool.totalWorkers) * 100 : 0}%`,
              }}
            >
              {pool.bgWorkers > 1 && (
                <span className="text-white text-xs font-medium">BG: {pool.bgWorkers}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-blue-500 inline-block" /> UI Workers ({pool.uiWorkers})</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-500 inline-block" /> BG Workers ({pool.bgWorkers})</span>
            <span className="ml-auto font-medium">Total: {pool.totalWorkers}</span>
          </div>
        </div>
      )}

      {/* Queue Activity */}
      {pool && (
        <div className="bg-white shadow rounded-lg p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Queue Activity</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatBadge label="UI Request Rate" value={`${pool.uiRequestRate}/s`} color="blue" />
            <StatBadge label="UI Queue Depth" value={pool.uiQueueDepth} color={pool.uiQueueDepth > 5 ? 'red' : 'blue'} />
            <StatBadge label="BG Queue Depth" value={pool.bgQueueDepth} color="green" />
            <StatBadge label="Doc Backlog" value={pool.documentBacklog} color={pool.documentBacklog > 0 ? 'yellow' : 'green'} />
          </div>
        </div>
      )}

      {/* PID Controller State */}
      {pool && (
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900">PID Controller</h3>
            {!editPid ? (
              <button onClick={() => setEditPid({ kp: String(pool.pid.kp), ki: String(pool.pid.ki), kd: String(pool.pid.kd) })}
                className="text-sm text-blue-600 hover:underline">Edit Gains</button>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={handleSavePid} disabled={actionLoading === 'update_pid'}
                  className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50">
                  {actionLoading === 'update_pid' ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditPid(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {editPid ? (
              <>
                <PidInput label="Kp" value={editPid.kp} onChange={v => setEditPid({ ...editPid, kp: v })} />
                <PidInput label="Ki" value={editPid.ki} onChange={v => setEditPid({ ...editPid, ki: v })} />
                <PidInput label="Kd" value={editPid.kd} onChange={v => setEditPid({ ...editPid, kd: v })} />
              </>
            ) : (
              <>
                <PidValue label="Kp" value={pool.pid.kp} />
                <PidValue label="Ki" value={pool.pid.ki} />
                <PidValue label="Kd" value={pool.pid.kd} />
              </>
            )}
            <PidValue label="Integral" value={pool.pid.integral.toFixed(2)} />
            <PidValue label="Prev Error" value={pool.pid.prevError.toFixed(2)} />
            <div className="border rounded-lg p-2.5 text-center">
              <div className={`text-lg font-bold ${pool.pid.idleCycles > 3 ? 'text-yellow-600' : 'text-gray-900'}`}>
                {pool.pid.idleCycles}
              </div>
              <div className="text-xs text-gray-500">Idle Cycles</div>
              {pool.pid.idleCycles > 3 && <div className="text-[10px] text-yellow-600 mt-0.5">releasing workers</div>}
            </div>
          </div>
        </div>
      )}

      {/* Parsing Workers */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">PDF Processing</h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{pw?.count ?? 0} active</span>
            {data.daemon && (
              <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                data.daemon.running ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {data.daemon.running && <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" /></span>}
                Daemon {data.daemon.running ? 'running' : 'stopped'}
              </span>
            )}
          </div>
        </div>

        {/* Concurrent PDF slider */}
        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700">PDFs at a time</label>
            <span className="text-sm font-bold text-blue-600">
              {parsingCount} {parsingCountSaving && <span className="text-xs text-gray-400 ml-1">saving...</span>}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={4}
            step={1}
            value={parsingCount}
            onChange={(e) => handleParsingCountChange(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
          </div>
          <p className="text-xs text-gray-500 mt-1.5">
            Number of PDFs processed simultaneously. Higher = faster but more CPU/memory.
          </p>
        </div>

        {pw && pw.workers.length > 0 ? (
          <div className="space-y-1.5">
            {pw.workers.map((w) => (
              <div key={w.workerId} className="flex items-center gap-2.5 text-sm text-gray-600 px-2 py-1.5 rounded hover:bg-gray-50">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  w.currentDocumentId ? 'bg-yellow-400 animate-pulse' : w.running ? 'bg-green-400' : 'bg-gray-300'
                }`} />
                <span className="font-medium text-gray-700">{w.workerId}</span>
                <span className="text-xs text-gray-400">{w.currentDocumentId ? 'busy' : w.running ? 'idle' : 'stopped'}</span>
                {w.currentDocumentId && (
                  <span className="text-xs text-gray-500 font-mono truncate ml-auto">{w.currentDocumentId}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400">No parsing workers running.</p>
        )}
      </div>

      {/* Metrics */}
      {pool && (
        <div className="bg-white shadow rounded-lg p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Metrics</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="UI Requests" total={pool.metrics.uiRequestsTotal} processed={pool.metrics.uiRequestsProcessed} />
            <MetricCard label="BG Tasks" total={pool.metrics.bgTasksTotal} processed={pool.metrics.bgTasksProcessed} />
            <div className="border rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-gray-900">{pool.metrics.pidAdjustments}</div>
              <div className="text-xs text-gray-500">PID Adjustments</div>
            </div>
            <div className="border rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-gray-900">{pool.metrics.documentsParsed}</div>
              <div className="text-xs text-gray-500">Docs Parsed</div>
            </div>
          </div>
        </div>
      )}

      {/* Pool Configuration */}
      {pool && (
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900">Pool Configuration</h3>
            {!editPool ? (
              <button onClick={() => setEditPool({ total: String(pool.totalWorkers), minUi: '3', minBg: '2' })}
                className="text-sm text-blue-600 hover:underline">Edit</button>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={handleSavePool} disabled={actionLoading === 'scale'}
                  className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50">
                  {actionLoading === 'scale' ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditPool(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
              </div>
            )}
          </div>
          {editPool ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Total Pool Size</label>
                <input type="number" min={3} max={100} value={editPool.total}
                  onChange={e => setEditPool({ ...editPool, total: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Min UI Workers</label>
                <input type="number" min={1} max={50} value={editPool.minUi}
                  onChange={e => setEditPool({ ...editPool, minUi: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Min BG Workers</label>
                <input type="number" min={1} max={50} value={editPool.minBg}
                  onChange={e => setEditPool({ ...editPool, minBg: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="border rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-900">{pool.totalWorkers}</div>
                <div className="text-xs text-gray-500">Total Pool Size</div>
              </div>
              <div className="border rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-900">{pool.uiWorkers}</div>
                <div className="text-xs text-gray-500">UI Workers (current)</div>
              </div>
              <div className="border rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-900">{pool.bgWorkers}</div>
                <div className="text-xs text-gray-500">BG Workers (current)</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="bg-white shadow rounded-lg p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Actions</h3>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => doAction('rebalance')} disabled={!!actionLoading}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {actionLoading === 'rebalance' ? 'Rebalancing...' : 'Force Rebalance'}
          </button>
          <button onClick={() => doAction('reset')} disabled={!!actionLoading}
            className="px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700 disabled:opacity-50">
            {actionLoading === 'reset' ? 'Resetting...' : 'Reset Pool'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  };
  return (
    <div className={`border rounded-lg p-3 text-center ${colors[color] || colors.blue}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs opacity-75">{label}</div>
    </div>
  );
}

function PidValue({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border rounded-lg p-2.5 text-center">
      <div className="text-lg font-bold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function PidInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="border rounded-lg p-2.5 text-center border-blue-300 bg-blue-50">
      <input type="number" step="0.1" value={value} onChange={e => onChange(e.target.value)}
        className="w-full text-center text-lg font-bold bg-transparent border-none focus:outline-none text-blue-700" />
      <div className="text-xs text-blue-500">{label}</div>
    </div>
  );
}

function MetricCard({ label, total, processed }: { label: string; total: number; processed: number }) {
  const pending = total - processed;
  return (
    <div className="border rounded-lg p-3 text-center">
      <div className="text-xl font-bold text-gray-900">{processed}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {pending > 0 && <div className="text-[10px] text-yellow-600 mt-0.5">{pending} pending</div>}
    </div>
  );
}

/* ──────────────────────────── Redis Cache Panel ──────────────────────────── */

function RedisCachePanel() {
  const [keys, setKeys] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/redis/keys');
      if (res.ok) setKeys(await res.json());
      else setKeys(null);
    } catch { setKeys(null); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClearCache = async () => {
    setClearing(true);
    try {
      await fetch('/api/worker-pool/cache-clear', { method: 'POST' });
      await load();
    } catch { /* silent */ }
    setClearing(false);
  };

  if (loading) return <Spinner />;
  if (!keys) return <p className="text-gray-500">Redis is not available or failed to load keys.</p>;

  return (
    <div className="space-y-6">
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Cache Keys ({keys.totalKeys})</h3>
          <div className="flex gap-2">
            <button onClick={load} className="text-sm text-blue-600 hover:underline">Refresh</button>
            <button onClick={handleClearCache} disabled={clearing}
              className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50">
              {clearing ? 'Clearing...' : 'Flush Cache'}
            </button>
          </div>
        </div>

        {Object.entries(keys.groups || {}).length === 0 ? (
          <p className="text-sm text-gray-500">No cached keys found.</p>
        ) : (
          <div className="space-y-3">
            {Object.entries(keys.groups as Record<string, any[]>).map(([group, items]) => (
              <details key={group} className="border rounded-lg">
                <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-700 hover:bg-gray-50">
                  {group} ({items.length} keys)
                </summary>
                <div className="px-3 pb-2 space-y-0.5 max-h-40 overflow-y-auto">
                  {items.map((item: any) => (
                    <div key={item.key} className="flex items-center gap-2 text-xs text-gray-600">
                      <span className="font-mono truncate flex-1">{item.key}</span>
                      <span className="text-gray-400">{item.type}</span>
                      <span className="text-gray-400">TTL:{item.ttl}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Filing Types Panel ─────────────────────────── */

function FilingTypesPanel() {
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newType, setNewType] = useState('');
  const [renaming, setRenaming] = useState<{ old: string; val: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/filing-types');
      if (res.ok) { const d = await res.json(); setTypes(d.types || []); }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newType.trim()) return;
    const res = await fetch('/api/admin/filing-types', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: newType.trim() }),
    });
    if (res.ok) { const d = await res.json(); setTypes(d.types); setNewType(''); }
  };

  const handleRemove = async (type: string) => {
    const res = await fetch('/api/admin/filing-types', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    if (res.ok) { const d = await res.json(); setTypes(d.types); }
  };

  const handleRename = async () => {
    if (!renaming || !renaming.val.trim()) return;
    const res = await fetch('/api/admin/filing-types', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldType: renaming.old, newType: renaming.val.trim() }),
    });
    if (res.ok) { const d = await res.json(); setTypes(d.types); setRenaming(null); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="bg-white shadow rounded-lg p-5">
      <h3 className="text-lg font-semibold text-gray-900 mb-3">Filing Types ({types.length})</h3>
      <div className="flex gap-2 mb-4">
        <input type="text" value={newType} onChange={e => setNewType(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="New filing type" className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button onClick={handleAdd} disabled={!newType.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">Add</button>
      </div>
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {types.map(t => (
          <div key={t} className="flex items-center gap-2 px-3 py-1.5 border rounded text-sm hover:bg-gray-50 group">
            {renaming && renaming.old === t ? (
              <>
                <input type="text" value={renaming.val} onChange={e => setRenaming({ ...renaming, val: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(null); }}
                  autoFocus className="flex-1 px-2 py-0.5 border rounded text-sm" />
                <button onClick={handleRename} className="text-xs text-blue-600 hover:underline">Save</button>
                <button onClick={() => setRenaming(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1 text-gray-700">{t}</span>
                <button onClick={() => setRenaming({ old: t, val: t })}
                  className="text-xs text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100">Rename</button>
                <button onClick={() => handleRemove(t)}
                  className="text-xs text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100">Remove</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────── Jobs Panel ──────────────────────────── */

function JobsPanel() {
  const [info, setInfo] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/system-info');
      if (res.ok) setInfo(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (!info) return <p className="text-gray-500">Failed to load job info.</p>;

  const jobs = info.recentJobs || [];
  const queueDetails = info.services?.jobQueue?.details;

  return (
    <div className="space-y-6">
      {/* Active queue info */}
      {queueDetails && (
        <div className="bg-white shadow rounded-lg p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Active Queue</h3>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <Stat label="Queue Length" value={queueDetails.queueLength ?? 0} />
            <Stat label="Active Jobs" value={queueDetails.activeJobsCount ?? 0} />
          </div>
          {queueDetails.activeJobs?.length > 0 && (
            <div className="space-y-1">
              {queueDetails.activeJobs.map((j: any) => (
                <div key={j.id} className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                  <span className="font-mono text-xs">{j.documentId}</span>
                  <span className="text-gray-400">attempt {j.attempt}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recent job logs */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Recent Job Logs</h3>
          <button onClick={load} className="text-sm text-blue-600 hover:underline">Refresh</button>
        </div>
        {jobs.length === 0 ? (
          <p className="text-sm text-gray-500">No job logs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-4">Started</th>
                  <th className="pb-2 pr-4">Completed</th>
                  <th className="pb-2 pr-4">Queued</th>
                  <th className="pb-2 pr-4">Processed</th>
                  <th className="pb-2 pr-4">Failed</th>
                  <th className="pb-2">Errors</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j: any) => (
                  <tr key={j.id} className="border-b border-gray-100">
                    <td className="py-1.5 pr-4 text-gray-600">{new Date(j.startedAt).toLocaleString()}</td>
                    <td className="py-1.5 pr-4 text-gray-600">{j.completedAt ? new Date(j.completedAt).toLocaleString() : '-'}</td>
                    <td className="py-1.5 pr-4">{j.documentsQueued}</td>
                    <td className="py-1.5 pr-4">{j.documentsProcessed}</td>
                    <td className="py-1.5 pr-4 text-red-600">{j.documentsFailed}</td>
                    <td className="py-1.5 text-xs text-gray-500 truncate max-w-[200px]">{j.errorSummary || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Action Log Panel ─────────────────────────── */

function ActionLogPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [logType, setLogType] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      if (search) params.set('search', search);
      if (logType) params.set('logType', logType);

      const res = await fetch(`/api/admin/action-logs?${params}`);
      if (res.ok) {
        const d = await res.json();
        setLogs(d.logs || []);
        setTotal(d.total || 0);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [search, logType, page]);

  useEffect(() => { load(); }, [load]);

  const handleExport = () => {
    const csv = [
      'id,createdAt,action,target,status,detail,logType,caseId',
      ...logs.map(l =>
        [l.id, l.createdAt, l.action, `"${(l.target || '').replace(/"/g, '""')}"`, l.status, `"${(l.detail || '').replace(/"/g, '""')}"`, l.logType, l.caseId || ''].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `action-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const LOG_TYPES = ['', 'general', 'document_added', 'document_parsed', 'filing_created', 'filing_updated', 'error', 'worker_event'];

  const statusBadge = (s: string) => {
    if (s === 'success') return 'bg-green-100 text-green-700';
    if (s === 'error') return 'bg-red-100 text-red-700';
    if (s === 'pending') return 'bg-yellow-100 text-yellow-700';
    if (s === 'cancelled') return 'bg-gray-200 text-gray-600';
    return 'bg-gray-100 text-gray-600';
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white shadow rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search actions..."
          className="px-3 py-2 border rounded-lg text-sm w-60 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={logType} onChange={e => { setLogType(e.target.value); setPage(0); }}
          className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Types</option>
          {LOG_TYPES.filter(Boolean).map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={load} className="text-sm text-blue-600 hover:underline">Refresh</button>
        <button onClick={handleExport} className="ml-auto px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200">
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {loading ? <div className="p-4"><Spinner /></div> : logs.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No action logs found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b bg-gray-50">
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 font-medium text-gray-700">{l.action}</td>
                    <td className="px-4 py-2 text-gray-600 truncate max-w-[200px]" title={l.target}>{l.target}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(l.status)}`}>{l.status}</span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{l.logType}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs truncate max-w-[200px]" title={l.detail || ''}>{l.detail || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <span className="text-sm text-gray-500">
              Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-3 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50">Prev</button>
              <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total}
                className="px-3 py-1 text-sm border rounded hover:bg-gray-100 disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────── Shared small components ──────────────────────── */

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft Admin Panel
// ---------------------------------------------------------------------------

function DraftAdminPanel({ initialConfig }: { initialConfig: any }) {
  // Page settings
  const [pageSize, setPageSize] = useState(initialConfig?.draftPageSize || 'letter');
  const [marginTop, setMarginTop] = useState(String(((initialConfig?.draftMarginTop || 96) / 96).toFixed(2)));
  const [marginBottom, setMarginBottom] = useState(String(((initialConfig?.draftMarginBottom || 96) / 96).toFixed(2)));
  const [marginLeft, setMarginLeft] = useState(String(((initialConfig?.draftMarginLeft || 96) / 96).toFixed(2)));
  const [marginRight, setMarginRight] = useState(String(((initialConfig?.draftMarginRight || 96) / 96).toFixed(2)));

  // Style defaults
  const [defaultFont, setDefaultFont] = useState(initialConfig?.draftDefaultFont || 'Times New Roman');
  const [defaultFontSize, setDefaultFontSize] = useState(initialConfig?.draftDefaultFontSize || '12pt');
  const [h1Size, setH1Size] = useState(initialConfig?.draftH1Size || '24pt');
  const [h2Size, setH2Size] = useState(initialConfig?.draftH2Size || '20pt');
  const [h3Size, setH3Size] = useState(initialConfig?.draftH3Size || '16pt');
  const [h4Size, setH4Size] = useState(initialConfig?.draftH4Size || '14pt');
  const [h5Size, setH5Size] = useState(initialConfig?.draftH5Size || '12pt');
  const [lineSpacing, setLineSpacing] = useState(initialConfig?.draftLineSpacing || '1.5');
  const [paragraphSpacing, setParagraphSpacing] = useState(initialConfig?.draftParagraphSpacing || '12px');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const configRes = await fetch('/api/config');
      const currentConfig = await configRes.json();
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...currentConfig,
          draftPageSize: pageSize,
          draftMarginTop: Math.round(parseFloat(marginTop) * 96),
          draftMarginBottom: Math.round(parseFloat(marginBottom) * 96),
          draftMarginLeft: Math.round(parseFloat(marginLeft) * 96),
          draftMarginRight: Math.round(parseFloat(marginRight) * 96),
          draftDefaultFont: defaultFont,
          draftDefaultFontSize: defaultFontSize,
          draftH1Size: h1Size,
          draftH2Size: h2Size,
          draftH3Size: h3Size,
          draftH4Size: h4Size,
          draftH5Size: h5Size,
          draftLineSpacing: lineSpacing,
          draftParagraphSpacing: paragraphSpacing,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  const inputClass = 'w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white';
  const sizeOptions = ['8pt', '9pt', '10pt', '11pt', '12pt', '13pt', '14pt', '16pt', '18pt', '20pt', '24pt', '28pt', '32pt', '36pt', '48pt'];
  const fontOptions = ['Times New Roman', 'Arial', 'Courier New', 'Georgia', 'Garamond', 'Calibri', 'Verdana', 'Helvetica'];

  return (
    <div className="max-w-2xl space-y-6">
      {/* Page Settings */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Page Settings</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Page Size</label>
            <select value={pageSize} onChange={e => setPageSize(e.target.value)} className={inputClass}>
              <option value="letter">US Letter (8.5 x 11 in)</option>
              <option value="a4">A4 (210 x 297 mm)</option>
              <option value="legal">US Legal (8.5 x 14 in)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Margins */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Margins (inches)</h3>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Top</label>
            <input type="number" step="0.1" min="0" max="3" value={marginTop} onChange={e => setMarginTop(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Bottom</label>
            <input type="number" step="0.1" min="0" max="3" value={marginBottom} onChange={e => setMarginBottom(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Left</label>
            <input type="number" step="0.1" min="0" max="3" value={marginLeft} onChange={e => setMarginLeft(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Right</label>
            <input type="number" step="0.1" min="0" max="3" value={marginRight} onChange={e => setMarginRight(e.target.value)} className={inputClass} />
          </div>
        </div>
      </div>

      {/* Default Typography */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Default Typography</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Default Font</label>
            <select value={defaultFont} onChange={e => setDefaultFont(e.target.value)} className={inputClass}>
              {fontOptions.map(f => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Default Body Size</label>
            <select value={defaultFontSize} onChange={e => setDefaultFontSize(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Heading Sizes */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Heading Sizes</h3>
        <div className="grid grid-cols-5 gap-3">
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">H1</label>
            <select value={h1Size} onChange={e => setH1Size(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">H2</label>
            <select value={h2Size} onChange={e => setH2Size(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">H3</label>
            <select value={h3Size} onChange={e => setH3Size(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">H4</label>
            <select value={h4Size} onChange={e => setH4Size(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">H5</label>
            <select value={h5Size} onChange={e => setH5Size(e.target.value)} className={inputClass}>
              {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Spacing */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Spacing</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Line Spacing</label>
            <select value={lineSpacing} onChange={e => setLineSpacing(e.target.value)} className={inputClass}>
              <option value="1">Single (1.0)</option>
              <option value="1.15">1.15</option>
              <option value="1.5">1.5</option>
              <option value="2">Double (2.0)</option>
              <option value="2.5">2.5</option>
              <option value="3">Triple (3.0)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium block mb-1">Paragraph Spacing</label>
            <select value={paragraphSpacing} onChange={e => setParagraphSpacing(e.target.value)} className={inputClass}>
              <option value="0px">None</option>
              <option value="6px">6px</option>
              <option value="8px">8px</option>
              <option value="12px">12px</option>
              <option value="16px">16px</option>
              <option value="24px">24px</option>
            </select>
          </div>
        </div>
      </div>

      {/* Preview */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Preview</h3>
        <div className="border border-gray-200 rounded-lg p-4 bg-white" style={{ fontFamily: defaultFont, lineHeight: lineSpacing }}>
          <div style={{ fontSize: h1Size, fontWeight: 'bold', marginBottom: paragraphSpacing }}>Heading 1</div>
          <div style={{ fontSize: h2Size, fontWeight: 'bold', marginBottom: paragraphSpacing }}>Heading 2</div>
          <div style={{ fontSize: h3Size, fontWeight: 'bold', marginBottom: paragraphSpacing }}>Heading 3</div>
          <div style={{ fontSize: h4Size, fontWeight: 'bold', marginBottom: paragraphSpacing }}>Heading 4</div>
          <div style={{ fontSize: h5Size, fontWeight: 'bold', marginBottom: paragraphSpacing }}>Heading 5</div>
          <p style={{ fontSize: defaultFontSize, marginBottom: paragraphSpacing }}>
            Body text paragraph. The quick brown fox jumps over the lazy dog. This demonstrates the default font, size, and spacing settings.
          </p>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Draft Settings'}
      </button>
    </div>
  );
}
