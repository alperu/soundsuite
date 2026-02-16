import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { callLLMJson, getDocumentChunks, getCaseChunks, buildContext } from './ai-helper';

export interface DetectPrivilegeParams {
  documentId: string;
  caseId?: string;
  confidence_threshold?: number;
  limit?: number;
}

export interface DetectPrivilegeResult {
  privileged: Array<{
    text: string;
    privilegeType: string;
    confidence: number;
    document: string;
    page: number;
    reason: string;
  }>;
}

export class DetectPrivilegeTool extends BaseMCPTool<
  DetectPrivilegeParams,
  DetectPrivilegeResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'detect_privilege',
      displayName: 'Detect Privilege',
      description: 'Detect potentially privileged content in documents',
      version: '1.0.0',
      category: 'review',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Document ID to scan for privileged content',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID to broaden detection scope',
          },
          confidence_threshold: {
            type: 'number',
            description:
              'Minimum confidence score for reporting privileged content (0-1, default: 0.7)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return',
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
    params: DetectPrivilegeParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<DetectPrivilegeResult> {
    const { documentId, caseId, confidence_threshold = 0.7, limit = 20 } = params;

    context.logger.info('detect_privilege: fetching chunks', { documentId, caseId });

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
      return { privileged: [] };
    }

    const textContext = buildContext(chunks);

    const systemPrompt = `You are a legal privilege detection specialist. Analyze the provided documents and identify content that may be protected by legal privilege.

Look for indicators of:
- Attorney-client privilege (communications between lawyer and client seeking/providing legal advice)
- Work product doctrine (materials prepared in anticipation of litigation)
- Spousal privilege
- Doctor-patient privilege
- Deliberative process privilege
- Trade secrets / confidential business information

Return a JSON object with this exact structure:
{
  "privileged": [
    {
      "text": "the potentially privileged text excerpt (brief)",
      "privilegeType": "attorney_client|work_product|spousal|medical|deliberative|trade_secret|other",
      "confidence": 0.85,
      "document": "source document name",
      "page": 1,
      "reason": "why this content may be privileged"
    }
  ]
}

Rules:
- confidence must be between 0 and 1
- Only include items with confidence >= ${confidence_threshold}
- privilegeType must be one of: attorney_client, work_product, spousal, medical, deliberative, trade_secret, other
- Keep text excerpts brief (1-2 sentences)
- Return at most ${limit} items
- If no privileged content found, return {"privileged": []}`;

    const result = await callLLMJson<DetectPrivilegeResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.privileged)) {
      return { privileged: [] };
    }
    result.privileged = result.privileged
      .filter(p => p.confidence >= confidence_threshold)
      .slice(0, limit);

    return result;
  }
}
