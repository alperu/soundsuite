import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolConfigEntry,
  ToolExecutionContext,
} from '../tool-types';
import { llmProviderDependency, vectorStoreDependency } from '../shared-dependencies';
import { callLLMJson, getCaseChunks, getTopicCaseChunks, buildContext } from './ai-helper';

export interface TrackClaimEvolutionParams {
  caseId: string;
  claim: string;
  limit?: number;
}

export interface TrackClaimEvolutionResult {
  evolution: Array<{
    document: string;
    date: string;
    statement: string;
    change: string;
  }>;
}

export class TrackClaimEvolutionTool extends BaseMCPTool<
  TrackClaimEvolutionParams,
  TrackClaimEvolutionResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'track_claim_evolution',
      displayName: 'Track Claim Evolution',
      description: 'Track how claims change over time across filings',
      version: '1.0.0',
      category: 'contradiction',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
            description: 'Case ID to track claims within',
          },
          claim: {
            type: 'string',
            description: 'The claim or topic to track across filings',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of evolution steps to return',
          },
        },
        required: ['caseId', 'claim'],
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
    params: TrackClaimEvolutionParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<TrackClaimEvolutionResult> {
    const { caseId, claim, limit = 20 } = params;

    context.logger.info('track_claim_evolution: fetching case chunks', { caseId, claim });

    // Use semantic search to retrieve chunks relevant to the claim
    const chunks = await getTopicCaseChunks(context, caseId, claim, 150);
    if (chunks.length === 0) {
      return { evolution: [] };
    }

    const textContext = buildContext(
      chunks.map(c => ({ text: c.text, documentName: c.documentName, pageNumber: c.pageNumber })),
    );

    const systemPrompt = `You are a legal document analyst. Track how the following claim or topic evolves across the provided documents:

Claim to track: "${claim}"

Analyze each document excerpt and identify how statements about this claim change, shift, or evolve over time. Look for:
- Initial assertions
- Modifications or qualifications
- Reversals or retractions
- Strengthening or weakening of positions

Return a JSON object with this exact structure:
{
  "evolution": [
    {
      "document": "source document name",
      "date": "date if mentioned, otherwise 'Unknown'",
      "statement": "the relevant statement about the claim",
      "change": "description of how this differs from prior statements (e.g. 'Initial assertion', 'Qualification added', 'Position reversed')"
    }
  ]
}

Rules:
- Order results chronologically when dates are available, otherwise by document order
- Return at most ${limit} evolution steps
- If no relevant statements found, return {"evolution": []}`;

    const result = await callLLMJson<TrackClaimEvolutionResult>(
      systemPrompt,
      textContext,
      { maxTokens: 4096, context },
    );

    if (!Array.isArray(result.evolution)) {
      return { evolution: [] };
    }
    result.evolution = result.evolution.slice(0, limit);
    return result;
  }
}
