import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import {
  amendmentLineage,
  motionsByPerson,
  relatedMotions,
  type MotionNode,
  type MotionRole,
} from '../../search/graph-expand';

/**
 * query_case_graph — structural ("graph-aware") lookups over the authoritative
 * legal entity graph (docs/tasks/02). Answers relationship questions that
 * similarity retrieval misses: a motion's amendment lineage, every motion a
 * person appears in, motions sharing a judge/movant within a case.
 *
 * ADDITIVE: registered alongside query_case_knowledge; it does not change the
 * existing semantic/hybrid retrieval path. An MCP client (or, later, the RLM
 * tool loop) can choose it for structural questions instead of, or in addition
 * to, query_case_knowledge.
 */
export type GraphOperation = 'amendment-lineage' | 'motions-by-person' | 'related-motions';

export interface QueryCaseGraphParams {
  operation: GraphOperation;
  /** Required for amendment-lineage / related-motions. */
  motionId?: string;
  /** Required for motions-by-person. */
  personId?: string;
  /** Optional role filter for motions-by-person. */
  role?: MotionRole;
  /** Optional case-id scope (intersect with the user's `{{ }}` chip filter). */
  caseScope?: string[];
  /** Max nodes to return (default 50, hard-capped in graph-expand). */
  limit?: number;
}

export interface QueryCaseGraphResult {
  operation: GraphOperation;
  nodes: MotionNode[];
  count: number;
}

export class QueryCaseGraphTool extends BaseMCPTool<QueryCaseGraphParams, QueryCaseGraphResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'query_case_graph',
      displayName: 'Query Case Graph',
      description:
        'Structural lookups over the case knowledge graph: a motion\'s amendment lineage, every motion a person appears in, or motions sharing a judge/movant within a case. Use for relationship questions ("what connects X and Y", "amendment history of this motion") that semantic search misses.',
      version: '1.0.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['amendment-lineage', 'motions-by-person', 'related-motions'],
            description: 'Which structural traversal to run.',
          },
          motionId: { type: 'string', description: 'Motion id (amendment-lineage / related-motions).' },
          personId: { type: 'string', description: 'Person id (motions-by-person).' },
          role: { type: 'string', enum: ['judge', 'movant', 'respondent'], description: 'Optional role filter for motions-by-person.' },
          caseScope: { type: 'array', items: { type: 'string' }, description: 'Optional case-id scope.' },
          limit: { type: 'number', description: 'Max nodes (default 50).' },
        },
        required: ['operation'],
      },
    };
  }

  validateParams(params: QueryCaseGraphParams): void {
    const fail = (msg: string) => { const e: any = new Error(msg); e.code = 'INVALID_PARAMS'; throw e; };
    if (!params || !params.operation) fail('operation is required');
    if ((params.operation === 'amendment-lineage' || params.operation === 'related-motions') && !params.motionId) {
      fail(`motionId is required for operation '${params.operation}'`);
    }
    if (params.operation === 'motions-by-person' && !params.personId) {
      fail("personId is required for operation 'motions-by-person'");
    }
  }

  async executeImpl(
    params: QueryCaseGraphParams,
    _context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<QueryCaseGraphResult> {
    const { operation, motionId, personId, role, caseScope, limit } = params;
    const opts = { caseScope, maxNodes: limit };

    let nodes: MotionNode[] = [];
    switch (operation) {
      case 'amendment-lineage':
        nodes = await amendmentLineage(motionId!, opts);
        break;
      case 'related-motions':
        nodes = await relatedMotions(motionId!, opts);
        break;
      case 'motions-by-person':
        nodes = await motionsByPerson(personId!, { role, caseScope, maxNodes: limit });
        break;
    }

    return { operation, nodes, count: nodes.length };
  }
}
