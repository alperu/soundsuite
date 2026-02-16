import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency } from '../shared-dependencies';
import { callLLMJson, getDocumentChunks, getCaseChunks, buildContext } from './ai-helper';

export interface ExtractEntitiesParams {
  documentId: string;
  caseId?: string;
  entity_types?: string[];
  limit?: number;
}

export interface ExtractEntitiesResult {
  entities: Array<{
    name: string;
    type: string;
    mentions: number;
    context: string;
    document: string;
    page: number;
  }>;
}

export class ExtractEntitiesTool extends BaseMCPTool<
  ExtractEntitiesParams,
  ExtractEntitiesResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'extract_entities',
      displayName: 'Extract Entities',
      description:
        'Extract named entities (people, organizations, dates, locations) from documents',
      version: '1.0.0',
      category: 'entity',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Document ID to extract entities from',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID to broaden extraction scope',
          },
          entity_types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of entity types to extract (e.g. person, organization, date, location)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of entities to return',
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
    params: ExtractEntitiesParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ExtractEntitiesResult> {
    const { documentId, caseId, entity_types, limit = 50 } = params;

    context.logger.info('extract_entities: fetching chunks', { documentId, caseId });

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
      return { entities: [] };
    }

    const textContext = buildContext(chunks);

    const typeFilter = entity_types && entity_types.length > 0
      ? `Only extract these entity types: ${entity_types.join(', ')}.`
      : 'Extract all entity types: person, organization, date, location, case_number, statute, monetary_amount.';

    const systemPrompt = `You are a legal document analyst specializing in named entity recognition. Extract all named entities from the provided legal documents.

${typeFilter}

Return a JSON object with this exact structure:
{
  "entities": [
    {
      "name": "entity name as it appears",
      "type": "person|organization|date|location|case_number|statute|monetary_amount|other",
      "mentions": 3,
      "context": "brief context of how the entity is involved",
      "document": "source document name",
      "page": 1
    }
  ]
}

Rules:
- Deduplicate entities (same name = same entity, sum up mentions)
- type must be one of: person, organization, date, location, case_number, statute, monetary_amount, other
- mentions is the approximate count of how many times the entity appears
- context should be a brief description of the entity's role
- page should be the first page where the entity appears
- Sort by mentions (most frequent first)
- Return at most ${limit} entities
- If no entities found, return {"entities": []}`;

    const result = await callLLMJson<ExtractEntitiesResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.entities)) {
      return { entities: [] };
    }
    result.entities = result.entities.slice(0, limit);
    return result;
  }
}
