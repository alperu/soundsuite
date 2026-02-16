import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';

export interface SearchWorkflowsParams {
  query?: string;
  caseId?: string;
  category?: string;
  tag?: string;
  status?: string;
  limit?: number;
}

export interface SearchWorkflowsResultItem {
  type: 'workflow' | 'template';
  id: string;
  title: string;
  status?: string;
  caseId?: string;
  category?: string;
  tags?: string[];
  jurisdiction?: string;
  snippet: string;
  createdAt: string;
}

export interface SearchWorkflowsResult {
  results: SearchWorkflowsResultItem[];
}

export class SearchWorkflowsTool extends BaseMCPTool<
  SearchWorkflowsParams,
  SearchWorkflowsResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'search_workflows',
      displayName: 'Search Workflows',
      description:
        'Search workflows and workflow templates by text query, case, category, tag, or status',
      version: '1.0.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Text to search for in titles, content, and descriptions',
          },
          caseId: {
            type: 'string',
            description: 'Filter workflows by case ID',
          },
          category: {
            type: 'string',
            description: 'Filter templates by category',
          },
          tag: {
            type: 'string',
            description: 'Filter templates by tag',
          },
          status: {
            type: 'string',
            description: 'Filter workflows by status (e.g. draft, active)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default 20)',
          },
        },
        required: [],
      },
    };
  }

  async executeImpl(
    params: SearchWorkflowsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<SearchWorkflowsResult> {
    const { query, caseId, category, tag, status, limit = 20 } = params;
    const q = query?.toLowerCase();

    context.logger.info('Handling search_workflows', { query, caseId, category, tag, status, limit });

    const results: SearchWorkflowsResultItem[] = [];

    // --- Search Workflows ---
    const workflowWhere: any = {};
    if (caseId) workflowWhere.caseId = caseId;
    if (status) workflowWhere.status = status;
    if (q) {
      workflowWhere.OR = [
        { title: { contains: q } },
        { content: { contains: q } },
      ];
    }

    const workflows = await context.database.workflow.findMany({
      where: workflowWhere,
      include: { template: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    for (const w of workflows) {
      results.push({
        type: 'workflow',
        id: w.id,
        title: w.title,
        status: w.status,
        caseId: w.caseId,
        snippet: makeSnippet(w.content, q),
        createdAt: w.createdAt.toISOString(),
      });
    }

    // --- Search Templates ---
    const templateWhere: any = {};
    if (category) templateWhere.category = category;
    if (q) {
      templateWhere.OR = [
        { name: { contains: q } },
        { content: { contains: q } },
        { description: { contains: q } },
      ];
    }

    const templates = await context.database.workflowTemplate.findMany({
      where: templateWhere,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    for (const t of templates) {
      const tags: string[] = parseTags(t.tags);

      // Apply tag filter (post-query since tags are stored as JSON string)
      if (tag && !tags.some(tg => tg.toLowerCase() === tag.toLowerCase())) {
        continue;
      }

      results.push({
        type: 'template',
        id: t.id,
        title: t.name,
        category: t.category ?? undefined,
        tags,
        jurisdiction: t.jurisdiction ?? undefined,
        snippet: makeSnippet(t.content, q),
        createdAt: t.createdAt.toISOString(),
      });
    }

    // Sort combined results by relevance (query match in title first)
    if (q) {
      results.sort((a, b) => {
        const aTitle = a.title.toLowerCase().includes(q) ? 0 : 1;
        const bTitle = b.title.toLowerCase().includes(q) ? 0 : 1;
        return aTitle - bTitle;
      });
    }

    const trimmed = results.slice(0, limit);

    context.logger.info('search_workflows completed', { resultCount: trimmed.length });

    return { results: trimmed };
  }
}

function parseTags(raw: string): string[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function makeSnippet(content: string, query?: string, maxLen = 200): string {
  if (!content) return '';
  if (!query) return content.slice(0, maxLen);
  const idx = content.toLowerCase().indexOf(query);
  if (idx === -1) return content.slice(0, maxLen);
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 140);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
}
