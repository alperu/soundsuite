import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import {
  callLLMJson,
  getDocumentChunks,
  buildContext,
  validateItemList,
  ItemShape,
  LlmItemStats,
} from './ai-helper';

/** The documented item shape (SS-3 #4). */
const ARGUMENT_SHAPE: ItemShape = {
  claim: { type: 'string' },
  premises: { type: 'string[]' },
  evidence: { type: 'string[]' },
  conclusion: { type: 'string' },
  strength: { type: 'string' },
};

export interface ExtractArgumentStructureParams {
  documentId: string;
  limit?: number;
}

export interface ExtractArgumentStructureResult {
  arguments: Array<{
    claim: string;
    premises: string[];
    evidence: string[];
    conclusion: string;
    strength: string;
  }>;
  /** Present only when items were dropped or flagged (SS-3 #4). */
  stats?: LlmItemStats;
}

export class ExtractArgumentStructureTool extends BaseMCPTool<
  ExtractArgumentStructureParams,
  ExtractArgumentStructureResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'extract_argument_structure',
      displayName: 'Extract Argument Structure',
      description: 'Extract the logical argument structure from a document',
      version: '1.0.0',
      category: 'argument',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Document ID to extract argument structure from',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of arguments to extract',
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
    params: ExtractArgumentStructureParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ExtractArgumentStructureResult> {
    const { documentId, limit = 10 } = params;

    context.logger.info('extract_argument_structure: fetching document chunks', { documentId });

    const chunks = await getDocumentChunks(context, documentId);
    if (chunks.length === 0) {
      return { arguments: [] };
    }

    const textContext = buildContext(
      chunks.map(c => ({ text: c.text, pageNumber: c.pageNumber })),
    );

    const systemPrompt = `You are a legal argument analyst. Extract the logical argument structures from the provided legal document.

For each argument, identify:
- The main claim being made
- The premises (assumptions or prior facts) supporting it
- The evidence cited (case law, statutes, testimony, exhibits)
- The conclusion drawn
- The strength assessment (strong, moderate, weak)

Return a JSON object with this exact structure:
{
  "arguments": [
    {
      "claim": "the main claim",
      "premises": ["premise 1", "premise 2"],
      "evidence": ["evidence reference 1", "evidence reference 2"],
      "conclusion": "the conclusion drawn",
      "strength": "strong|moderate|weak"
    }
  ]
}

Rules:
- Extract at most ${limit} arguments
- Focus on substantive legal arguments, not procedural statements
- strength must be one of: "strong", "moderate", "weak"
- If no arguments found, return {"arguments": []}`;

    const result = await callLLMJson<ExtractArgumentStructureResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.arguments)) {
      return { arguments: [] };
    }

    const validated = validateItemList<ExtractArgumentStructureResult['arguments'][number]>(
      result.arguments,
      ARGUMENT_SHAPE,
      { tool: 'extract_argument_structure', key: 'arguments', logger: context.logger },
    );

    return {
      arguments: validated.items.slice(0, limit),
      ...(validated.stats ? { stats: validated.stats } : {}),
    };
  }
}
