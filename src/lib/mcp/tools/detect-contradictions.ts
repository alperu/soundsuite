import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency, vectorStoreDependency } from '../shared-dependencies';
import { callLLMJson, getCaseChunks, getTopicCaseChunks, buildContext } from './ai-helper';

export interface DetectContradictionsParams {
  caseId: string;
  topic?: string;
  confidence_threshold?: number;
  limit?: number;
}

export interface DetectContradictionsResult {
  contradictions: Array<{
    statement1: string;
    statement2: string;
    document1: string;
    document2: string;
    confidence: number;
    explanation: string;
  }>;
}

export class DetectContradictionsTool extends BaseMCPTool<
  DetectContradictionsParams,
  DetectContradictionsResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'detect_contradictions',
      displayName: 'Detect Contradictions',
      description: 'Find contradictory statements across documents in a case',
      version: '1.0.0',
      category: 'contradiction',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
            description: 'Case ID to analyze for contradictions',
          },
          topic: {
            type: 'string',
            description: 'Optional topic to focus contradiction detection on',
          },
          confidence_threshold: {
            type: 'number',
            description:
              'Minimum confidence score for reported contradictions (0-1, default: 0.7)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of contradictions to return',
          },
        },
        required: ['caseId'],
      },
    };
  }

  getDependencies() {
    return [llmProviderDependency(), vectorStoreDependency()];
  }

  getDefaultConfig(): ToolConfigEntry {
    return { enabled: true, settings: {}, rateLimitPerMinute: 10 };
  }

  async executeImpl(
    params: DetectContradictionsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<DetectContradictionsResult> {
    const { caseId, topic, confidence_threshold = 0.7, limit = 10 } = params;

    context.logger.info('detect_contradictions: fetching case chunks', { caseId, topic });

    // When a topic is provided, use semantic search to retrieve relevant chunks
    // instead of blindly fetching the first N chunks for the case.
    const chunks = topic
      ? await getTopicCaseChunks(context, caseId, topic, 100)
      : await getCaseChunks(context, caseId, 100);
    if (chunks.length === 0) {
      return { contradictions: [] };
    }

    const textContext = buildContext(
      chunks.map(c => ({ text: c.text, documentName: c.documentName, pageNumber: c.pageNumber })),
    );

    const topicInstruction = topic
      ? `Focus specifically on contradictions related to: "${topic}".`
      : 'Look for contradictions on any topic.';

    const systemPrompt = `You are a legal document analyst specializing in detecting contradictions across court filings. Analyze the provided document excerpts and identify statements that contradict each other.

${topicInstruction}

Return a JSON object with this exact structure:
{
  "contradictions": [
    {
      "statement1": "the first contradictory statement (quote or close paraphrase)",
      "statement2": "the second contradictory statement",
      "document1": "source document name for statement1",
      "document2": "source document name for statement2",
      "confidence": 0.85,
      "explanation": "why these statements contradict each other"
    }
  ]
}

Rules:
- Only report genuine contradictions, not merely different perspectives
- confidence must be between 0 and 1
- Return at most ${limit} contradictions
- Only include contradictions with confidence >= ${confidence_threshold}
- If no contradictions are found, return {"contradictions": []}`;

    const result = await callLLMJson<DetectContradictionsResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    // Guard against LLM returning JSON without the expected key
    if (!Array.isArray(result.contradictions)) {
      return { contradictions: [] };
    }

    // Filter by confidence threshold
    result.contradictions = result.contradictions
      .filter(c => c.confidence >= confidence_threshold)
      .slice(0, limit);

    return result;
  }
}
