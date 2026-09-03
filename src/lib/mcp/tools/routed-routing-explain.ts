/**
 * `routing_explain` — dry run of the router (REPORT-v2.1 Part B.3, work
 * item 8). Tells the caller which tier a query would take and which
 * provider/model/effort the active (or given) preset maps it to, with a cost
 * class and whether `research_report` would self-promote to a job. Spends
 * nothing.
 */

import { BaseMCPTool } from './base-tool';
import type { ToolMetadata, ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { PresetV2, ResearchMode, ResearchTier, TierSettings } from '../research-types';
import { planReport } from '../routed/run-report';
import type { CostClass } from '../routed/routing';

export interface RoutingExplainParams {
  query: string;
  mode?: ResearchMode;
  preset?: string | PresetV2;
  overrides?: Partial<TierSettings>;
}

export interface RoutingExplainResult {
  tier: ResearchTier;
  reason: string;
  confidence: number;
  resolved: TierSettings;
  presetUsed?: string;
  clamps: string[];
  costClass: CostClass;
  estimatedSeconds: number;
  wouldPromoteToJob: boolean;
}

export const TIER_SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', description: 'ollama | anthropic | openai | gemini | groq | grok' },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    thinking: { type: 'boolean' },
    maxTokens: { type: 'number' },
    multiPass: { type: 'boolean' },
    useRlm: { type: 'boolean' },
    rlmMaxRounds: { type: 'number' },
  },
};

export const MODE_SCHEMA = {
  type: 'string',
  enum: ['auto', 'fast', 'deep', 'deep-report', 'deep-rlm'],
  description: 'Research tier; "auto" (default) lets the query router decide.',
};

export const PRESET_REF_SCHEMA = {
  description: 'Saved preset id/name, a tmp_ handle from preset_define, or an inline PresetV2 object (one-shot).',
  oneOf: [{ type: 'string' }, { type: 'object' }],
};

export class RoutingExplainTool extends BaseMCPTool<RoutingExplainParams, RoutingExplainResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'routing_explain',
      displayName: 'Explain Routing',
      description:
        'Dry run: which tier the router picks for a query and the provider/model/effort the active preset maps it to, with cost class and whether research_report would run as a background job. Spends nothing.',
      version: '1.0.0',
      category: 'search',
      profiles: ['routed'],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The research question to classify' },
          mode: MODE_SCHEMA,
          preset: PRESET_REF_SCHEMA,
          overrides: TIER_SETTINGS_SCHEMA,
        },
        required: ['query'],
      },
    };
  }

  validateParams(params: RoutingExplainParams): void {
    if (!params?.query || typeof params.query !== 'string' || !params.query.trim()) {
      throw Object.assign(new Error('query is required'), { code: 'INVALID_PARAMS' });
    }
  }

  async executeImpl(
    params: RoutingExplainParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<RoutingExplainResult> {
    const plan = await planReport(params.query, {
      sessionId: context.sessionId,
      mode: params.mode,
      preset: params.preset,
      overrides: params.overrides,
    });
    return {
      tier: plan.tier,
      reason: plan.reason,
      confidence: plan.confidence,
      resolved: plan.resolved,
      ...(plan.presetUsed ? { presetUsed: plan.presetUsed } : {}),
      clamps: plan.clamps,
      costClass: plan.costClass,
      estimatedSeconds: plan.estimatedSeconds,
      wouldPromoteToJob: plan.wouldPromoteToJob,
    };
  }
}
