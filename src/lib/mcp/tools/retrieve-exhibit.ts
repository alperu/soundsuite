import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery } from '../../vector/vector-store';

export interface RetrieveExhibitParams {
  description: string;
  caseId?: string;
  limit?: number;
}

export interface RetrieveExhibitResult {
  results: Array<{
    imagePath: string;
    ocrText: string;
    document: string;
    page: number;
  }>;
}

export class RetrieveExhibitTool extends BaseMCPTool<
  RetrieveExhibitParams,
  RetrieveExhibitResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'retrieve_exhibit',
      displayName: 'Retrieve Exhibit',
      description: 'Find exhibit images by text description',
      version: '1.0.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Text description of the exhibit to find',
          },
          caseId: {
            type: 'string',
            description: 'Optional case ID to filter results',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['description'],
      },
    };
  }

  validateParams(params: RetrieveExhibitParams): void {
    if (!params.description || typeof params.description !== 'string') {
      const err: any = new Error('Missing or invalid description parameter');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
  }

  async executeImpl(
    params: RetrieveExhibitParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<RetrieveExhibitResult> {
    const { description, caseId, limit = 5 } = params;

    context.logger.info('Handling retrieve_exhibit', { description, caseId, limit });

    // Generate embedding for description
    const embeddings = await context.embeddingProvider.embed([description]);
    const queryEmbedding = embeddings[0];

    // Build search query with exhibit filter
    const searchQuery: SearchQuery = {
      vector: queryEmbedding,
      filter: { isExhibit: true },
      limit,
    };

    // Apply case filter if provided
    if (caseId) {
      searchQuery.filter = { ...searchQuery.filter, caseId };
    }

    // Perform vector search
    const searchResults = await context.vectorStore.search(searchQuery);

    // Enrich results with document names
    const enrichedResults = await Promise.all(
      searchResults.map(async (result) => {
        const document = await context.database.document.findUnique({
          where: { id: result.metadata.documentId },
          select: { fileName: true },
        });

        return {
          imagePath: result.metadata.exhibitPath || '',
          ocrText: result.text,
          document: document?.fileName || 'Unknown',
          page: result.metadata.pageNumber,
        };
      }),
    );

    context.logger.info('Exhibit retrieval completed', {
      resultCount: enrichedResults.length,
    });

    return { results: enrichedResults };
  }
}
