import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { McpError } from '../llm-policy';
import { callLLMJson, getDocumentChunks, buildContext } from './ai-helper';

export interface CompareArgumentStructuresParams {
  documentId1: string;
  documentId2: string;
}

export interface CompareArgumentStructuresResult {
  comparison: {
    shared: string[];
    uniqueToDoc1: string[];
    uniqueToDoc2: string[];
    conflicts: Array<{
      topic: string;
      doc1Position: string;
      doc2Position: string;
    }>;
  };
}

export class CompareArgumentStructuresTool extends BaseMCPTool<
  CompareArgumentStructuresParams,
  CompareArgumentStructuresResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'compare_argument_structures',
      displayName: 'Compare Argument Structures',
      description: 'Compare argument structures between two documents',
      version: '1.0.0',
      category: 'argument',
      inputSchema: {
        type: 'object',
        properties: {
          documentId1: {
            type: 'string',
            description: 'First document ID to compare',
          },
          documentId2: {
            type: 'string',
            description: 'Second document ID to compare',
          },
        },
        required: ['documentId1', 'documentId2'],
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
    params: CompareArgumentStructuresParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<CompareArgumentStructuresResult> {
    const { documentId1, documentId2 } = params;

    context.logger.info('compare_argument_structures: fetching documents', { documentId1, documentId2 });

    const [chunks1, chunks2, doc1, doc2] = await Promise.all([
      getDocumentChunks(context, documentId1, 80),
      getDocumentChunks(context, documentId2, 80),
      context.database.document.findUnique({ where: { id: documentId1 }, select: { fileName: true } }),
      context.database.document.findUnique({ where: { id: documentId2 }, select: { fileName: true } }),
    ]);

    const name1 = doc1?.fileName || 'Document 1';
    const name2 = doc2?.fileName || 'Document 2';

    if (chunks1.length === 0 && chunks2.length === 0) {
      return { comparison: { shared: [], uniqueToDoc1: [], uniqueToDoc2: [], conflicts: [] } };
    }

    const context1 = buildContext(
      chunks1.map(c => ({ text: c.text, pageNumber: c.pageNumber })),
      40000,
    );
    const context2 = buildContext(
      chunks2.map(c => ({ text: c.text, pageNumber: c.pageNumber })),
      40000,
    );

    const systemPrompt = `You are a legal argument analyst. Compare the argument structures between two documents and identify shared arguments, unique arguments, and conflicting positions.

Return a JSON object with this exact structure:
{
  "comparison": {
    "shared": ["argument topic shared by both documents"],
    "uniqueToDoc1": ["argument only in document 1"],
    "uniqueToDoc2": ["argument only in document 2"],
    "conflicts": [
      {
        "topic": "the disputed topic",
        "doc1Position": "document 1's position",
        "doc2Position": "document 2's position"
      }
    ]
  }
}

Rules:
- Be concise but specific in describing arguments
- Focus on substantive legal arguments
- If no comparison possible, return empty arrays`;

    const userContent = `=== DOCUMENT 1: ${name1} ===\n${context1}\n\n=== DOCUMENT 2: ${name2} ===\n${context2}`;

    const result = await callLLMJson<CompareArgumentStructuresResult>(
      systemPrompt,
      userContent,
      { maxTokens: 4096, context },
    );

    // Guard against parseable JSON that omits the documented `comparison`
    // object — mirrors the Array.isArray checks the list-shaped tools make.
    if (!result?.comparison || typeof result.comparison !== 'object' || Array.isArray(result.comparison)) {
      throw new McpError(
        'LLM_SHAPE_ERROR',
        'The model returned JSON without a "comparison" object, so no comparison could be produced.',
      );
    }

    return result;
  }
}
