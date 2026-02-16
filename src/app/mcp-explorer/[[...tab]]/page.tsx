import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { MCPToolManager } from '@/components/mcp/mcp-tool-manager';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { prisma } from '@/lib/db/prisma';

const VALID_TABS = ['manager', 'explorer', 'analytics'] as const;
type TabKey = (typeof VALID_TABS)[number];

interface Props {
  params: Promise<{ tab?: string[] }>;
}

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
      rateLimitPerMinute: t.config.rateLimitPerMinute,
      settings: t.config.settings,
      dependencies: t.dependencies,
      inputSchema: t.metadata.inputSchema,
    }));
  } catch (error) {
    console.error('Error loading tool registry:', error);
    return [];
  }
}

export default async function MCPExplorerPage({ params }: Props) {
  const { tab } = await params;
  const tabKey = (tab?.[0] ?? 'manager') as TabKey;

  if (!VALID_TABS.includes(tabKey) || (tab && tab.length > 1)) {
    redirect('/mcp-explorer/manager');
  }

  const [tools, cases, documents] = await Promise.all([
    getToolsData(),
    getCases(),
    getDocuments(),
  ]);

  return (
    <div className="h-full">
      <Suspense fallback={<div className="text-gray-500 p-6">Loading MCP Tools...</div>}>
        <MCPToolManager
          initialTab={tabKey}
          initialTools={tools}
          cases={cases}
          documents={documents}
        />
      </Suspense>
    </div>
  );
}
