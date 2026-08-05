import SearchInterface from '@/components/search-interface';
import { prisma } from '@/lib/db/prisma';
import { getConfig } from '@/lib/db/config';
import { AI_PROVIDERS, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

async function getCases() {
  try {
    return await prisma.case.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  } catch {
    return [];
  }
}

async function getDocuments() {
  try {
    return await prisma.document.findMany({
      select: { id: true, fileName: true },
      orderBy: { fileName: 'asc' },
      take: 500,
    });
  } catch {
    return [];
  }
}

async function getConfiguredProviders() {
  const config = await getConfig();
  const result: Record<string, boolean> = {};
  for (const key of AI_PROVIDER_KEYS) {
    const configKey = AI_PROVIDERS[key].configKey;
    const value = (config as any)[configKey] as string | undefined;
    result[key] = !!value && value.length > 0;
  }
  return result;
}

async function getEmbeddingInfo() {
  const config = await getConfig();
  return {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    ollamaModel: config.ollamaModel,
    ollamaCompletionModel: config.ollamaCompletionModel,
  };
}

async function getToolsData() {
  try {
    const registry = await getToolRegistry();
    await registry.refreshDependencies();
    return registry.listTools().map(t => ({
      name: t.metadata.name,
      displayName: t.metadata.displayName,
      description: t.metadata.description,
      category: t.metadata.category,
      version: t.metadata.version,
      enabled: t.config.enabled,
      ready: t.ready,
      readyReasons: t.readyReasons,
      totalExecutions: t.stats.totalExecutions,
      inputSchema: t.metadata.inputSchema,
    }));
  } catch {
    return [];
  }
}

/** Convert tool name to URL slug: query_case_knowledge → querycaseknowledge */
function toolNameToSlug(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

interface SearchPageProps {
  params: Promise<{ path?: string[] }>;
}

export default async function SearchPage({ params }: SearchPageProps) {
  const { path } = await params;
  const [cases, configuredProviders, tools, documents, embeddingInfo] = await Promise.all([
    getCases(),
    getConfiguredProviders(),
    getToolsData(),
    getDocuments(),
    getEmbeddingInfo(),
  ]);

  // Parse URL segments into mode + tool
  // /search              → ai
  // /search/ai           → ai
  // /search/direct       → direct
  // /search/analysistools              → analysis (grid)
  // /search/analysistools/toolslug     → analysis (specific tool)
  // /search/history/<chatId> → AI mode, auto-load that saved chat
  let initialMode: 'ai' | 'direct' | 'analysis' = 'ai';
  let initialToolSlug: string | null = null;
  let initialDeepMode = false;
  let initialCompareMode = false;
  let initialChatId: string | null = null;

  if (path && path.length > 0) {
    const first = path[0].toLowerCase();
    if (first === 'history') {
      // Preserve the session id's original casing (e.g. "session-1782255255884").
      if (path.length > 1) initialChatId = path[1];
    } else if (first === 'direct') {
      initialMode = 'direct';
    } else if (first === 'analysistools') {
      initialMode = 'analysis';
      if (path.length > 1) {
        initialToolSlug = path[1].toLowerCase();
      }
    } else if (first === 'ai') {
      initialMode = 'ai';
      if (path.length > 1) {
        const second = path[1].toLowerCase();
        if (second === 'deep') initialDeepMode = true;
        else if (second === 'compare') initialCompareMode = true;
      }
    }
  }

  // Resolve slug to tool name
  let initialToolName: string | null = null;
  if (initialToolSlug) {
    const match = tools.find(t => toolNameToSlug(t.name) === initialToolSlug);
    if (match) initialToolName = match.name;
  }

  // Build slug map for the client
  const toolSlugMap: Record<string, string> = {};
  for (const t of tools) {
    toolSlugMap[t.name] = toolNameToSlug(t.name);
  }

  return (
    <SearchInterface
      cases={cases}
      configuredProviders={configuredProviders}
      tools={tools}
      documents={documents}
      embeddingInfo={{
        embeddingProvider: embeddingInfo.embeddingProvider,
        embeddingModel: embeddingInfo.embeddingModel,
        ollamaModel: embeddingInfo.ollamaModel,
      }}
      ollamaCompletionModel={embeddingInfo.ollamaCompletionModel}
      initialMode={initialMode}
      initialDeepMode={initialDeepMode}
      initialCompareMode={initialCompareMode}
      initialToolName={initialToolName}
      toolSlugMap={toolSlugMap}
      initialChatId={initialChatId}
      hasExplicitPath={!!(path && path.length > 0)}
    />
  );
}
