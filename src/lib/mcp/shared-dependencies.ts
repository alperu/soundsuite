/**
 * Shared dependency factories for MCP tools.
 *
 * Centralises dependency checks so that all tools referencing the same
 * external resource use a single, consistent check.
 */

import { ToolDependency } from './tool-types';

/**
 * LLM provider dependency.
 * Checks that at least ONE AI provider key is configured (Groq, OpenAI, Anthropic, Grok, or Ollama).
 * Tools need an LLM to function but are not locked to a single provider.
 */
export function llmProviderDependency(): ToolDependency {
  return {
    key: 'llmProvider',
    label: 'AI Provider Key (any)',
    required: true,
    check: async () => {
      // Check env vars first
      if (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OLLAMA_HOST) return true;
      try {
        const { prisma } = await import('../db/prisma');
        const keys = await prisma.config.findMany({
          where: {
            key: {
              in: ['ai.groqApiKey', 'embedding.openaiApiKey', 'embedding.claudeApiKey', 'ai.geminiApiKey', 'ai.grokApiKey', 'ai.ollamaHost'],
            },
          },
        });
        return keys.some(k => !!k.value);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Groq API key dependency (kept for backward compat / explicit Groq-only tools).
 * Checks both env var and persisted config in the database.
 */
export function groqApiKeyDependency(): ToolDependency {
  return {
    key: 'groqApiKey',
    label: 'Groq API Key',
    required: true,
    check: async () => {
      if (process.env.GROQ_API_KEY) return true;
      try {
        const { prisma } = await import('../db/prisma');
        const row = await prisma.config.findUnique({ where: { key: 'ai.groqApiKey' } });
        return !!row?.value;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama availability probe (local-profile gating)
// ---------------------------------------------------------------------------

const OLLAMA_PROBE_TIMEOUT_MS = 3_000;
const OLLAMA_PROBE_CACHE_MS = 30_000;

let _ollamaProbe: { at: number; ok: boolean } | null = null;
let _ollamaProbeInflight: Promise<boolean> | null = null;

/**
 * Is an Ollama endpoint reachable? Reads the same config the MCP AI helper
 * uses (`ollamaCompletionHost || ollamaHost`), hits `GET /api/tags` with a
 * 3 s timeout, and caches the answer for 30 s. Never throws.
 *
 * The `local` profile pins LLM tools to Ollama; when this returns false those
 * tools report `ready: false` and the bridge hides them rather than falling
 * back to a cloud provider.
 */
export async function ollamaAvailable(opts?: { force?: boolean }): Promise<boolean> {
  const now = Date.now();
  if (!opts?.force && _ollamaProbe && now - _ollamaProbe.at < OLLAMA_PROBE_CACHE_MS) {
    return _ollamaProbe.ok;
  }
  if (_ollamaProbeInflight) return _ollamaProbeInflight;

  _ollamaProbeInflight = (async () => {
    let ok = false;
    try {
      const { getConfig } = await import('../db/config');
      const config = await getConfig();
      const host = (config.ollamaCompletionHost || config.ollamaHost || process.env.OLLAMA_HOST || '').trim();
      if (host) {
        const base = host.startsWith('http') ? host : `http://${host}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
        try {
          const res = await fetch(`${base.replace(/\/+$/, '')}/api/tags`, { signal: controller.signal });
          ok = res.ok;
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {
      ok = false;
    }
    _ollamaProbe = { at: Date.now(), ok };
    _ollamaProbeInflight = null;
    return ok;
  })();

  return _ollamaProbeInflight;
}

/** Test hook — drop the cached probe result. */
export function resetOllamaProbeCache(): void {
  _ollamaProbe = null;
  _ollamaProbeInflight = null;
}

/**
 * Vector store dependency.
 * Always returns true (the registry sets it up during init).
 */
export function vectorStoreDependency(): ToolDependency {
  return {
    key: 'vectorStore',
    label: 'Vector Store',
    required: true,
    check: async () => true,
  };
}
