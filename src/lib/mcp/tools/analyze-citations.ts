import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { callLLMJson, getDocumentChunks, getCaseChunks, buildContext } from './ai-helper';

export interface AnalyzeCitationsParams {
  caseId: string;
  documentId?: string;
  limit?: number;
}

export interface AnalyzeCitationsResult {
  citations: Array<{
    citation: string;
    type: string;
    frequency: number;
    documents: string[];
    context: string;
  }>;
}

export class AnalyzeCitationsTool extends BaseMCPTool<
  AnalyzeCitationsParams,
  AnalyzeCitationsResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'analyze_citations',
      displayName: 'Analyze Citations',
      description:
        'Analyze legal citations and references across documents',
      version: '1.0.0',
      category: 'entity',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
            description: 'Case ID to analyze citations within',
          },
          documentId: {
            type: 'string',
            description: 'Optional document ID to limit analysis to',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of citations to return',
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
    params: AnalyzeCitationsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<AnalyzeCitationsResult> {
    const { caseId, documentId, limit = 30 } = params;

    context.logger.info('analyze_citations: fetching chunks', { caseId, documentId });

    let chunks: Array<{ text: string; documentName?: string; pageNumber: number }>;

    if (documentId) {
      const docChunks = await getDocumentChunks(context, documentId);
      const doc = await context.database.document.findUnique({ where: { id: documentId }, select: { fileName: true } });
      chunks = docChunks.map(c => ({ text: c.text, documentName: doc?.fileName, pageNumber: c.pageNumber }));
    } else {
      const caseChunks = await getCaseChunks(context, caseId, 200);
      chunks = caseChunks.map(c => ({ text: c.text, documentName: c.documentName, pageNumber: c.pageNumber }));
    }

    if (chunks.length === 0) {
      return { citations: [] };
    }

    const textContext = buildContext(chunks);

    const systemPrompt = `You are a legal citation analyst. Identify and analyze all legal citations and references in the provided documents.

Look for:
- Case law citations (e.g., "Smith v. Jones, 123 F.3d 456")
- Statutory references (e.g., "28 U.S.C. Section 1332")
- Regulatory citations (e.g., "17 C.F.R. Section 240.10b-5")
- Constitutional references
- References to exhibits, depositions, or other case materials

Return a JSON object with this exact structure:
{
  "citations": [
    {
      "citation": "the full citation text",
      "type": "case_law|statute|regulation|constitutional|exhibit|other",
      "frequency": 3,
      "documents": ["document names where this citation appears"],
      "context": "how this citation is used (e.g., 'cited as authority for jurisdiction')"
    }
  ]
}

Rules:
- Deduplicate citations (normalize variations of the same citation)
- type must be one of: case_law, statute, regulation, constitutional, exhibit, other
- frequency is the total number of times the citation appears
- Sort by frequency (most cited first)
- Return at most ${limit} citations
- If no citations found, return {"citations": []}`;

    const result = await callLLMJson<AnalyzeCitationsResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.citations)) {
      return { citations: [] };
    }
    result.citations = result.citations.slice(0, limit);
    return result;
  }
}
