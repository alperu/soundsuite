import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { callLLMJson, getDocumentChunks, getCaseChunks, buildContext } from './ai-helper';

export interface ExtractObligationsParams {
  documentId: string;
  caseId?: string;
  limit?: number;
}

export interface ExtractObligationsResult {
  obligations: Array<{
    description: string;
    type: string;
    deadline: string | null;
    party: string;
    document: string;
    page: number;
  }>;
}

export class ExtractObligationsTool extends BaseMCPTool<
  ExtractObligationsParams,
  ExtractObligationsResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'extract_obligations',
      displayName: 'Extract Obligations',
      description:
        'Extract obligations, deadlines, and commitments from documents',
      version: '1.0.0',
      category: 'timeline',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Document ID to extract obligations from',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID to broaden extraction scope',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of obligations to return',
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
    params: ExtractObligationsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ExtractObligationsResult> {
    const { documentId, caseId, limit = 20 } = params;

    context.logger.info('extract_obligations: fetching chunks', { documentId, caseId });

    let chunks: Array<{ text: string; documentName?: string; pageNumber: number }>;

    if (caseId) {
      const caseChunks = await getCaseChunks(context, caseId, 150);
      chunks = caseChunks.map(c => ({ text: c.text, documentName: c.documentName, pageNumber: c.pageNumber }));
    } else {
      const docChunks = await getDocumentChunks(context, documentId);
      const doc = await context.database.document.findUnique({ where: { id: documentId }, select: { fileName: true } });
      chunks = docChunks.map(c => ({ text: c.text, documentName: doc?.fileName, pageNumber: c.pageNumber }));
    }

    if (chunks.length === 0) {
      return { obligations: [] };
    }

    const textContext = buildContext(chunks);

    const systemPrompt = `You are a legal document analyst specializing in extracting obligations and commitments. Analyze the provided legal documents and identify all obligations, deadlines, requirements, and commitments.

Return a JSON object with this exact structure:
{
  "obligations": [
    {
      "description": "what must be done",
      "type": "filing_deadline|payment|disclosure|compliance|appearance|other",
      "deadline": "YYYY-MM-DD or descriptive deadline, null if none",
      "party": "who is obligated",
      "document": "source document name",
      "page": 1
    }
  ]
}

Rules:
- type must be one of: filing_deadline, payment, disclosure, compliance, appearance, other
- deadline should be null if no specific deadline is mentioned
- page should be the page number where the obligation is found (use 0 if unknown)
- Return at most ${limit} obligations
- Sort by deadline (soonest first), then by document order
- If no obligations found, return {"obligations": []}`;

    const result = await callLLMJson<ExtractObligationsResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.obligations)) {
      return { obligations: [] };
    }
    result.obligations = result.obligations.slice(0, limit);
    return result;
  }
}
