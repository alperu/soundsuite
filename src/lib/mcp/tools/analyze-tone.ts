import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { McpError } from '../llm-policy';
import {
  callLLMJson,
  getDocumentChunks,
  buildContext,
  validateItemObject,
  ItemShape,
  LlmItemStats,
} from './ai-helper';

/**
 * The documented shape of the `analysis` object (SS-3 #4). `confidence` and
 * `intensity` are scores, so an unscored analysis is kept with `null` rather
 * than discarded (SS-3 #5).
 */
const TONE_SHAPE: ItemShape = {
  overallTone: { type: 'string' },
  confidence: { type: 'number', score: true },
  patterns: { type: 'string[]' },
  segments: {
    type: 'object[]',
    items: {
      text: { type: 'string' },
      tone: { type: 'string' },
      intensity: { type: 'number', score: true },
      page: { type: 'number' },
    },
  },
};

export interface AnalyzeToneParams {
  documentId: string;
  caseId?: string;
}

export interface AnalyzeToneResult {
  analysis: {
    overallTone: string;
    /** `null` when the model gave no usable score. */
    confidence: number | null;
    segments: Array<{
      text: string;
      tone: string;
      intensity: number | null;
      page: number;
    }>;
    patterns: string[];
  };
  /** Present only when nested segments were dropped (SS-3 #4). */
  stats?: LlmItemStats;
}

export class AnalyzeToneTool extends BaseMCPTool<
  AnalyzeToneParams,
  AnalyzeToneResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'analyze_tone',
      displayName: 'Analyze Tone',
      description:
        'Analyze the tone and language patterns in legal documents',
      version: '1.0.0',
      category: 'review',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Document ID to analyze tone for',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID for broader context',
          },
        },
        required: ['documentId'],
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
    params: AnalyzeToneParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<AnalyzeToneResult> {
    const { documentId } = params;

    context.logger.info('analyze_tone: fetching document chunks', { documentId });

    const chunks = await getDocumentChunks(context, documentId);
    if (chunks.length === 0) {
      return {
        analysis: {
          overallTone: 'unknown',
          confidence: 0,
          segments: [],
          patterns: [],
        },
      };
    }

    const textContext = buildContext(
      chunks.map(c => ({ text: c.text, pageNumber: c.pageNumber })),
    );

    const systemPrompt = `You are a legal language analyst specializing in tone and rhetoric analysis. Analyze the tone and language patterns in the provided legal document.

Assess:
- Overall tone (formal, aggressive, conciliatory, neutral, defensive, persuasive, etc.)
- Notable tonal segments where the writing shifts
- Recurring language patterns and rhetorical devices

Return a JSON object with this exact structure:
{
  "analysis": {
    "overallTone": "primary tone descriptor",
    "confidence": 0.85,
    "segments": [
      {
        "text": "brief excerpt showing the tone (1-2 sentences)",
        "tone": "tone descriptor for this segment",
        "intensity": 0.8,
        "page": 1
      }
    ],
    "patterns": [
      "pattern description (e.g., 'Frequent use of imperative language')",
      "another pattern"
    ]
  }
}

Rules:
- confidence (0-1) for the overall tone assessment
- intensity (0-1) for how strongly the tone is expressed in each segment
- Include 3-8 notable tonal segments
- Include 2-5 language patterns
- Keep segment text excerpts brief
- page is where the segment appears (0 if unknown)`;

    const result = await callLLMJson<AnalyzeToneResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    // Guard against parseable JSON that omits the documented `analysis`
    // object — mirrors the Array.isArray checks the list-shaped tools make.
    if (!result?.analysis || typeof result.analysis !== 'object' || Array.isArray(result.analysis)) {
      throw new McpError(
        'LLM_SHAPE_ERROR',
        'The model returned JSON without an "analysis" object, so no tone analysis could be produced.',
      );
    }

    // Item-level shape validation of the object's own fields; malformed
    // `segments` entries are dropped and counted rather than being fatal.
    const validated = validateItemObject<AnalyzeToneResult['analysis']>(
      result.analysis,
      TONE_SHAPE,
      { tool: 'analyze_tone', key: 'analysis', logger: context.logger },
    );

    return {
      analysis: validated.item,
      ...(validated.stats ? { stats: validated.stats } : {}),
    };
  }
}
