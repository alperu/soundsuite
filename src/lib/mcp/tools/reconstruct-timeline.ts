import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import {
  callLLMJson,
  getCaseChunks,
  buildContext,
  validateItemList,
  ItemShape,
  LlmItemStats,
} from './ai-helper';

/** The documented item shape (SS-3 #4). `confidence` is a score: see ai-helper. */
const EVENT_SHAPE: ItemShape = {
  date: { type: 'string' },
  description: { type: 'string' },
  document: { type: 'string' },
  page: { type: 'number' },
  confidence: { type: 'number', score: true },
};

export interface ReconstructTimelineParams {
  caseId: string;
  date_range_start?: string;
  date_range_end?: string;
  limit?: number;
}

export interface ReconstructTimelineResult {
  events: Array<{
    date: string;
    description: string;
    document: string;
    page: number;
    /** `null` when the model reported the event without a usable score. */
    confidence: number | null;
  }>;
  /** Present only when items were dropped or flagged (SS-3 #4). */
  stats?: LlmItemStats;
}

export class ReconstructTimelineTool extends BaseMCPTool<
  ReconstructTimelineParams,
  ReconstructTimelineResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'reconstruct_timeline',
      displayName: 'Reconstruct Timeline',
      description:
        'Reconstruct a chronological timeline of events from case documents',
      version: '1.0.0',
      category: 'timeline',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
            description: 'Case ID to reconstruct timeline for',
          },
          date_range_start: {
            type: 'string',
            description: 'Optional start date for timeline range (ISO 8601)',
          },
          date_range_end: {
            type: 'string',
            description: 'Optional end date for timeline range (ISO 8601)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of events to return',
          },
        },
        required: ['caseId'],
      },
    };
  }

  getDependencies() {
    return [llmProviderDependency()];
  }

  getDefaultConfig(): ToolConfigEntry {
    return { enabled: true, settings: {}, rateLimitPerMinute: 10 };
  }

  async executeImpl(
    params: ReconstructTimelineParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ReconstructTimelineResult> {
    const { caseId, date_range_start, date_range_end, limit = 50 } = params;

    context.logger.info('reconstruct_timeline: fetching case chunks', { caseId });

    const chunks = await getCaseChunks(context, caseId, 200);
    if (chunks.length === 0) {
      return { events: [] };
    }

    const textContext = buildContext(
      chunks.map(c => ({ text: c.text, documentName: c.documentName, pageNumber: c.pageNumber })),
    );

    const dateFilter = date_range_start || date_range_end
      ? `Only include events between ${date_range_start || 'the beginning'} and ${date_range_end || 'now'}.`
      : '';

    const systemPrompt = `You are a legal document analyst specializing in chronological reconstruction. Extract dated events from the provided case documents and arrange them into a timeline.

${dateFilter}

Return a JSON object with this exact structure:
{
  "events": [
    {
      "date": "YYYY-MM-DD or approximate date description",
      "description": "what happened",
      "document": "source document name",
      "page": 1,
      "confidence": 0.9
    }
  ]
}

Rules:
- Sort events chronologically (earliest first)
- Use ISO 8601 dates (YYYY-MM-DD) when possible; use descriptive dates like "Early 2023" when exact dates aren't available
- confidence (0-1) reflects how certain you are about the date and event
- page should be the page number where the event is mentioned (use 0 if unknown)
- Return at most ${limit} events
- If no events found, return {"events": []}`;

    const result = await callLLMJson<ReconstructTimelineResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.events)) {
      return { events: [] };
    }

    const validated = validateItemList<ReconstructTimelineResult['events'][number]>(
      result.events,
      EVENT_SHAPE,
      { tool: 'reconstruct_timeline', key: 'events', logger: context.logger },
    );

    return {
      events: validated.items.slice(0, limit),
      ...(validated.stats ? { stats: validated.stats } : {}),
    };
  }
}
