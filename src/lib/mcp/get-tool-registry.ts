/**
 * Singleton accessor for the ToolRegistry instance.
 * Lazily initialises the registry on first call (survives HMR via globalThis).
 */

import { ToolRegistry } from './tool-registry';
import { ToolConfigStore } from './tool-config-store';
import { ToolExecutionLogger } from './tool-execution-logger';
import { getAllTools } from './tools';
import { ToolExecutionContext } from './tool-types';
import { createLogger } from '../logger';

const globalForRegistry = globalThis as unknown as {
  __toolRegistry: ToolRegistry | undefined;
  __toolRegistryPromise: Promise<ToolRegistry> | undefined;
  __toolRegistryModuleStamp: object | undefined;
};

// Identity of THIS evaluation of the module. In dev, an HMR recompile of any
// file in the tool graph re-evaluates this module and produces a new stamp;
// a cached registry built by an older evaluation holds stale tool instances,
// so it must be rebuilt or code changes to tools never take effect until the
// server restarts. In production the module evaluates once, so the stamp
// never changes and the singleton behaves exactly as before.
const MODULE_STAMP = {};

export async function getToolRegistry(): Promise<ToolRegistry> {
  if (
    process.env.NODE_ENV !== 'production' &&
    globalForRegistry.__toolRegistry &&
    globalForRegistry.__toolRegistryModuleStamp !== MODULE_STAMP
  ) {
    globalForRegistry.__toolRegistry = undefined;
    globalForRegistry.__toolRegistryPromise = undefined;
  }

  if (globalForRegistry.__toolRegistry) {
    // Re-attempt embedding provider init if it was null at startup
    await ensureEmbeddingProvider(globalForRegistry.__toolRegistry);
    return globalForRegistry.__toolRegistry;
  }

  // Prevent double-init during concurrent requests
  if (globalForRegistry.__toolRegistryPromise) {
    return globalForRegistry.__toolRegistryPromise;
  }

  globalForRegistry.__toolRegistryPromise = initRegistry();
  const registry = await globalForRegistry.__toolRegistryPromise;
  globalForRegistry.__toolRegistry = registry;
  globalForRegistry.__toolRegistryModuleStamp = MODULE_STAMP;
  return registry;
}

async function initRegistry(): Promise<ToolRegistry> {
  const logger = createLogger('ToolRegistry');

  // Import heavy deps lazily so this module can be imported at compile-time
  const { prisma } = await import('../db/prisma');

  // Create vector store and embedding provider from app config
  let vectorStore: any = null;
  let embeddingProvider: any = null;
  try {
    const { getConfig } = await import('../db/config');
    const config = await getConfig();

    // Initialise VectorStore
    const { VectorStore } = await import('../vector/vector-store');
    const vs = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: 'chunks',
    });
    await vs.initialize();
    vectorStore = vs;

    // Initialise EmbeddingProvider based on config
    if (config.embeddingProvider === 'openai' && config.openaiApiKey) {
      const { OpenAIEmbeddingProvider } = await import('../ingestion/openai-embedding-provider');
      embeddingProvider = new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingModel || 'text-embedding-3-small');
    } else if (config.embeddingProvider === 'claude' && config.claudeApiKey) {
      const { ClaudeEmbeddingProvider } = await import('../ingestion/claude-embedding-provider');
      embeddingProvider = new ClaudeEmbeddingProvider(config.claudeApiKey, config.embeddingModel);
    } else if (config.embeddingProvider === 'ollama' && config.ollamaHost) {
      const { OllamaEmbeddingProvider } = await import('../ingestion/ollama-embedding-provider');
      embeddingProvider = new OllamaEmbeddingProvider({
        host: config.ollamaHost,
        model: config.ollamaModel || 'all-minilm',
        useOrchestrator: !!config.embeddingUseOrchestrator,
      });
    } else {
      // Default: local transformers provider
      const { TransformersEmbeddingProvider } = await import('../ingestion/transformers-embedding-provider');
      embeddingProvider = new TransformersEmbeddingProvider(config.embeddingModel || 'Xenova/all-MiniLM-L6-v2');
    }

    logger.info('VectorStore and EmbeddingProvider initialised', {
      provider: config.embeddingProvider,
      model: config.embeddingModel,
    });
  } catch (err) {
    logger.warn('Failed to initialise VectorStore/EmbeddingProvider — search tools will be unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const context: ToolExecutionContext = {
    vectorStore: vectorStore as any,
    embeddingProvider: embeddingProvider as any,
    database: prisma,
    logger,
  };

  const configStore = new ToolConfigStore();
  const executionLogger = new ToolExecutionLogger();
  const registry = new ToolRegistry(configStore, executionLogger, context);

  const tools = getAllTools();
  await registry.registerAll(tools);
  await registry.refreshDependencies();

  logger.info('ToolRegistry initialised', { toolCount: tools.length });
  return registry;
}

/**
 * If the embedding provider failed to init at startup (e.g. config wasn't set yet),
 * re-attempt initialization from current config. This runs on each getToolRegistry()
 * call but short-circuits immediately when the provider already exists.
 */
async function ensureEmbeddingProvider(registry: ToolRegistry): Promise<void> {
  const ctx = registry.getContext();
  if (ctx.embeddingProvider) return;

  try {
    const { getConfig } = await import('../db/config');
    const config = await getConfig();

    let provider: any = null;

    if (config.embeddingProvider === 'openai' && config.openaiApiKey) {
      const { OpenAIEmbeddingProvider } = await import('../ingestion/openai-embedding-provider');
      provider = new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingModel || 'text-embedding-3-small');
    } else if (config.embeddingProvider === 'claude' && config.claudeApiKey) {
      const { ClaudeEmbeddingProvider } = await import('../ingestion/claude-embedding-provider');
      provider = new ClaudeEmbeddingProvider(config.claudeApiKey, config.embeddingModel);
    } else if (config.embeddingProvider === 'ollama' && config.ollamaHost) {
      const { OllamaEmbeddingProvider } = await import('../ingestion/ollama-embedding-provider');
      provider = new OllamaEmbeddingProvider({
        host: config.ollamaHost,
        model: config.ollamaModel || 'all-minilm',
        useOrchestrator: !!config.embeddingUseOrchestrator,
      });
    } else {
      const { TransformersEmbeddingProvider } = await import('../ingestion/transformers-embedding-provider');
      provider = new TransformersEmbeddingProvider(config.embeddingModel || 'Xenova/all-MiniLM-L6-v2');
    }

    if (provider) {
      (ctx as any).embeddingProvider = provider;
      ctx.logger.info('EmbeddingProvider re-initialised on retry', {
        provider: config.embeddingProvider,
        model: config.embeddingModel,
      });
    }
  } catch {
    // Still can't init — will try again on next request
  }
}
