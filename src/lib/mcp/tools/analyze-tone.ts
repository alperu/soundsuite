import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { callLLMJson, getDocumentChunks, buildContext } from './ai-helper';

export interface AnalyzeToneParams {
  documentId: string;
  caseId?: string;
}

export interface AnalyzeToneResult {
  analysis: {
    overallTone: string;
    confidence: number;
    segments: Array<{
      text: string;
      tone: string;
      intensity: number;
      page: number;
    }>;
    patterns: string[];
  };
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

    return callLLMJson<AnalyzeToneResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );
  }
}
