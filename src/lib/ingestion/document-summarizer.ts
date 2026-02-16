/**
 * DocumentSummarizer generates short LLM-powered summaries of documents
 * for Summary Augmented Chunking (SAC).
 *
 * Uses completeAI() to call the cheapest available LLM provider.
 * Returns null if no LLM API key is configured (graceful skip).
 */

import { createLogger } from '../logger';

const logger = createLogger('DocumentSummarizer');

interface SummarizeParams {
  headerText: string;     // first ~5 pages of text
  filingType?: string;    // from filing detection
  filingTitle?: string;   // from filing detection
  fileName: string;
}

/**
 * Provider preference order (cheapest/local first).
 * Ollama is first — free, local, private, GPU-accelerated.
 * For Ollama, the model is read from config.ollamaCompletionModel at runtime.
 */
const PROVIDER_PREFERENCE: Array<{
  provider: 'ollama' | 'groq' | 'openai' | 'grok' | 'anthropic';
  configKey: string;
  model: string; // default model; Ollama overridden by config.ollamaCompletionModel
}> = [
  { provider: 'ollama', configKey: 'ollamaHost', model: 'qwen3.5:14b' },
  { provider: 'groq', configKey: 'groqApiKey', model: 'llama-3.1-8b-instant' },
  { provider: 'openai', configKey: 'openaiApiKey', model: 'gpt-4o-mini' },
  { provider: 'grok', configKey: 'grokApiKey', model: 'grok-3-mini' },
  { provider: 'anthropic', configKey: 'claudeApiKey', model: 'claude-haiku-4-5-20251001' },
];

/** Timeout for summarization LLM calls (60 seconds). */
const SUMMARY_TIMEOUT_MS = 60_000;

const SUMMARY_SYSTEM_PROMPT = `You are a legal document classifier. Given the first pages of a court document, produce a 1-2 sentence summary that identifies:
- The document type (e.g., motion, order, complaint, deposition, exhibit)
- The parties involved (if identifiable)
- The case context (what the document is about)

Be concise. Max 100 tokens. Do not include any preamble — output only the summary.`;

export class DocumentSummarizer {
  /**
   * Generate a short summary of a document for SAC embedding.
   * Returns null if no LLM API key is configured.
   */
  async generateSummary(params: SummarizeParams): Promise<string | null> {
    try {
      const { getConfig } = await import('../db/config');
      const config = await getConfig();

      // Find first available provider.
      // For Ollama, check the dedicated completion host first, then shared host.
      const available = PROVIDER_PREFERENCE.find(p => {
        if (p.provider === 'ollama') {
          const completionHost = config.ollamaCompletionHost;
          const sharedHost = config.ollamaHost;
          return (completionHost && completionHost.trim().length > 0) ||
                 (sharedHost && sharedHost.trim().length > 0);
        }
        const key = (config as any)[p.configKey];
        return key && key.trim().length > 0;
      });

      if (!available) {
        logger.info('No LLM API key configured, skipping document summarization');
        return null;
      }

      // For Ollama, always use the user-configured completion model from Admin > Local AI
      let model = available.model;
      if (available.provider === 'ollama') {
        model = config.ollamaCompletionModel || available.model;
      }

      // Build user prompt
      const filingContext = params.filingType
        ? `\nDetected filing type: ${params.filingType}${params.filingTitle ? ` — "${params.filingTitle}"` : ''}`
        : '';

      const headerPreview = params.headerText.slice(0, 3000); // ~750 tokens

      const userPrompt = `File: ${params.fileName}${filingContext}

--- Document text (first pages) ---
${headerPreview}`;

      const { completeAI } = await import('../ai/ai-provider');

      // Wrap in a timeout to avoid hanging on slow models
      const completionPromise = completeAI({
        provider: available.provider,
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 100,
        temperature: 0.1,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Summarization timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`)), SUMMARY_TIMEOUT_MS),
      );

      const response = await Promise.race([completionPromise, timeoutPromise]);

      const summary = response.content.trim();
      if (!summary) {
        logger.warn('LLM returned empty summary');
        return null;
      }

      logger.info('Document summary generated', {
        provider: available.provider,
        model,
        summaryLength: summary.length,
        fileName: params.fileName,
      });

      return summary;
    } catch (error) {
      logger.warn('Document summarization failed, continuing without SAC', {
        error: error instanceof Error ? error.message : String(error),
        fileName: params.fileName,
      });
      return null;
    }
  }
}
