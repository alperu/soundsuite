/** @jest-environment node */
/**
 * SS-3 — fail-closed LLM policy at the tool level.
 *
 * `ToolRegistry.execute` refuses a cloud provider for a `local` session via
 * `enforceProvider` before the tool runs. These cases exercise the *second*
 * choke point — the guard inside `callLLM` (ai-helper.ts:99-105) — which is
 * what protects any path that reaches a tool without going through the
 * registry (internal callers, future call sites, a registry regression).
 *
 * The assertion that matters on litigation material: no case text is handed to
 * `completeAI` when the policy refuses. Every case checks that, not just the
 * error code.
 *
 * All fixtures synthetic (see analysis-tool-harness.ts).
 */

jest.mock('../../../ai/ai-provider', () => ({ completeAI: jest.fn() }));
jest.mock('../../../db/config', () => ({ getConfig: jest.fn() }));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => results.slice(0, topN)),
}));

import { completeAI } from '../../../ai/ai-provider';
import { getConfig } from '../../../db/config';
import { DetectContradictionsTool } from '../detect-contradictions';
import { DetectPrivilegeTool } from '../detect-privilege';
import { AnalyzeCitationsTool } from '../analyze-citations';
import { ExtractObligationsTool } from '../extract-obligations';
import { ReconstructTimelineTool } from '../reconstruct-timeline';
import { ExtractEntitiesTool } from '../extract-entities';
import { TrackClaimEvolutionTool } from '../track-claim-evolution';
import { ExtractArgumentStructureTool } from '../extract-argument-structure';
import { CompareArgumentStructuresTool } from '../compare-argument-structures';
import { AnalyzeToneTool } from '../analyze-tone';
import { providersAllowed } from '../../llm-policy';
import type { BaseMCPTool } from '../base-tool';
import { CONFIG, aiResponse, makeHarness } from './analysis-tool-harness';

const ai = completeAI as unknown as jest.Mock;
const config = getConfig as unknown as jest.Mock;

const LLM_TOOLS: Array<[string, BaseMCPTool<any, any>, Record<string, unknown>]> = [
  ['detect_contradictions', new DetectContradictionsTool(), { caseId: 'case-1' }],
  ['detect_privilege', new DetectPrivilegeTool(), { documentId: 'doc-1' }],
  ['analyze_citations', new AnalyzeCitationsTool(), { caseId: 'case-1' }],
  ['extract_obligations', new ExtractObligationsTool(), { documentId: 'doc-1' }],
  ['reconstruct_timeline', new ReconstructTimelineTool(), { caseId: 'case-1' }],
  ['extract_entities', new ExtractEntitiesTool(), { documentId: 'doc-1' }],
  ['track_claim_evolution', new TrackClaimEvolutionTool(), { caseId: 'case-1', claim: 'a conference occurred' }],
  ['extract_argument_structure', new ExtractArgumentStructureTool(), { documentId: 'doc-1' }],
  ['compare_argument_structures', new CompareArgumentStructuresTool(), { documentId1: 'doc-1', documentId2: 'doc-2' }],
  ['analyze_tone', new AnalyzeToneTool(), { documentId: 'doc-1' }],
];

beforeEach(() => {
  ai.mockReset();
  // Parseable and structurally acceptable to every tool: the eight list-shaped
  // tools see no array under their key and return an empty result, while
  // compare_argument_structures / analyze_tone find the object key they now
  // require (SS-3 fix 3). These cases are about provider policy, not shape.
  ai.mockResolvedValue(aiResponse('{"comparison": {}, "analysis": {}}'));
  config.mockReset();
  config.mockResolvedValue({ ollamaHost: 'http://127.0.0.1:11434' });
});

describe('local profile refuses cloud providers', () => {
  it.each(LLM_TOOLS)(
    '%s: an explicit cloud provider is rejected with POLICY_VIOLATION',
    async (_name, tool, params) => {
      const { context } = makeHarness({
        overlay: { profile: 'local', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' },
      });

      const out = await tool.execute(params, context, CONFIG);

      expect(out.success).toBe(false);
      expect(out.errorCode).toBe('POLICY_VIOLATION');
      expect(out.error).toMatch(/local/);
      expect(out.error).toMatch(/anthropic/);
      expect(ai).not.toHaveBeenCalled();
    },
  );

  it.each(LLM_TOOLS)(
    '%s: auto-detected cloud provider is also rejected (fail-closed, not fail-open)',
    async (_name, tool, params) => {
      // No provider on the context, and no Ollama host configured, so
      // `getAvailableProvider` would pick Anthropic. A local session must not
      // inherit that.
      // `claudeApiKey` is the config key Anthropic resolves from (models.ts:122).
      config.mockResolvedValue({ claudeApiKey: 'sk-test-not-a-real-key' });
      const { context } = makeHarness({ overlay: { profile: 'local' } });

      const out = await tool.execute(params, context, CONFIG);

      expect(out.success).toBe(false);
      expect(out.errorCode).toBe('POLICY_VIOLATION');
      expect(ai).not.toHaveBeenCalled();
    },
  );

  it.each(LLM_TOOLS)('%s: Ollama is permitted under local', async (_name, tool, params) => {
    const { context } = makeHarness({
      overlay: { profile: 'local', aiProvider: 'ollama', aiModel: 'qwen2.5:14b' },
    });

    const out = await tool.execute(params, context, CONFIG);

    expect(out.errorCode).not.toBe('POLICY_VIOLATION');
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0].provider).toBe('ollama');
    expect(out.success).toBe(true);
  });
});

describe('routed profile passes the requested provider through', () => {
  it.each(LLM_TOOLS)('%s: a cloud provider is allowed under routed', async (_name, tool, params) => {
    const { context } = makeHarness({
      overlay: { profile: 'routed', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' },
    });

    const out = await tool.execute(params, context, CONFIG);

    expect(out.errorCode).not.toBe('POLICY_VIOLATION');
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0].provider).toBe('anthropic');
    expect(ai.mock.calls[0][0].model).toBe('claude-sonnet-5');
  });
});

describe('policy surface', () => {
  it('local allows only ollama; routed allows the full provider set', () => {
    expect(providersAllowed('local')).toEqual(['ollama']);
    expect(providersAllowed('routed').length).toBeGreaterThan(1);
    expect(providersAllowed('routed')).toContain('anthropic');
  });

  it('CURRENT BEHAVIOUR: a context with no profile is not policy-checked', async () => {
    // `profile` is absent for internal callers that bypass the registry
    // (tool-types.ts), and the ai-helper guard only fires on an explicit
    // `local`. Fail-closed lives in ToolRegistry.execute, whose default is
    // `local` — a direct tool call has no such default, so any caller that
    // reaches a tool without the registry escapes the policy entirely.
    // Hardening ai-helper to refuse an absent profile is a legitimate privacy
    // change; it should update this test rather than be read as a regression.
    const { context } = makeHarness({ overlay: { aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' } });

    const out = await new DetectContradictionsTool().execute({ caseId: 'case-1' }, context, CONFIG);

    expect(out.errorCode).not.toBe('POLICY_VIOLATION');
    expect(ai.mock.calls[0][0].provider).toBe('anthropic');
  });

  it('the refusal message names the remedy (register the routed profile)', async () => {
    const { context } = makeHarness({ overlay: { profile: 'local', aiProvider: 'openai', aiModel: 'gpt-5.6-terra' } });

    const out = await new DetectPrivilegeTool().execute({ documentId: 'doc-1' }, context, CONFIG);

    expect(out.error).toMatch(/only "ollama" is permitted/);
  });
});
