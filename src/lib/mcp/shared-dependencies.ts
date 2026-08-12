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
