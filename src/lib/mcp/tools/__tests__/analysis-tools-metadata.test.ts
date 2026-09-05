/** @jest-environment node */
/**
 * SS-3 — metadata contract for the 12 analysis tools.
 *
 * Tool classes are imported directly (never via `./index`), which would pull
 * lancedb, the preset tools and the routed report tools into every suite.
 */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../search/reranker', () => ({ rerank: jest.fn(async (_q, r) => r) }));

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
import { QueryCaseGraphTool } from '../query-case-graph';
import { SearchWorkflowsTool } from '../search-workflows';
import { CATEGORY_COLORS, type ToolCategory } from '../../tool-types';
import type { BaseMCPTool } from '../base-tool';

/** name → [instance, expected required params]. */
const TOOLS: Array<[string, BaseMCPTool, string[]]> = [
  ['detect_contradictions', new DetectContradictionsTool(), ['caseId']],
  ['detect_privilege', new DetectPrivilegeTool(), ['documentId']],
  ['analyze_citations', new AnalyzeCitationsTool(), ['caseId']],
  ['extract_obligations', new ExtractObligationsTool(), ['documentId']],
  ['reconstruct_timeline', new ReconstructTimelineTool(), ['caseId']],
  ['extract_entities', new ExtractEntitiesTool(), ['documentId']],
  ['track_claim_evolution', new TrackClaimEvolutionTool(), ['caseId', 'claim']],
  ['extract_argument_structure', new ExtractArgumentStructureTool(), ['documentId']],
  ['compare_argument_structures', new CompareArgumentStructuresTool(), ['documentId1', 'documentId2']],
  ['analyze_tone', new AnalyzeToneTool(), ['documentId']],
  ['query_case_graph', new QueryCaseGraphTool(), ['operation']],
  ['search_workflows', new SearchWorkflowsTool(), []],
];

/** The ten that reach an LLM through `callLLMJson`. */
const LLM_TOOLS = TOOLS.filter(([n]) => n !== 'query_case_graph' && n !== 'search_workflows');

describe('analysis tools: metadata contract', () => {
  it.each(TOOLS)('%s declares a complete, self-consistent metadata block', (name, tool) => {
    const meta = tool.getMetadata();

    expect(meta.name).toBe(name);
    expect(meta.displayName.length).toBeGreaterThan(0);
    expect(meta.description.trim().length).toBeGreaterThan(10);
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(CATEGORY_COLORS)).toContain(meta.category as ToolCategory);
  });

  it.each(TOOLS)('%s exposes a well-formed JSON Schema', (_name, tool, required) => {
    const schema = tool.getMetadata().inputSchema;

    expect(schema.type).toBe('object');
    expect(schema.properties).toBeTruthy();
    expect(Array.isArray(schema.required)).toBe(true);
    expect(schema.required).toEqual(required);

    // Every declared property is typed and described; every required param is
    // actually declared (an MCP client generates its call from this schema).
    for (const [prop, def] of Object.entries(schema.properties)) {
      expect(typeof (def as any).type).toBe('string');
      expect(typeof (def as any).description).toBe('string');
      expect((def as any).description.length).toBeGreaterThan(0);
    }
    for (const req of schema.required) {
      expect(Object.keys(schema.properties)).toContain(req);
    }
  });

  it.each(TOOLS)('%s has a unique name across the analysis set', (name) => {
    expect(TOOLS.filter(([n]) => n === name)).toHaveLength(1);
  });

  it.each(TOOLS)('%s is visible to both profiles', (_name, tool) => {
    // `profiles` absent means "both" — tool-registry.ts:145-147
    // (`return !profiles || profiles.includes(profile)`). Assert the semantics,
    // not the encoding, so declaring `['local','routed']` explicitly later is
    // not a spurious failure.
    const profiles = tool.getMetadata().profiles;
    const visibleTo = (p: 'local' | 'routed') => !profiles || profiles.includes(p);
    expect(visibleTo('local')).toBe(true);
    expect(visibleTo('routed')).toBe(true);
  });

  it.each(LLM_TOOLS)('%s declares an LLM provider dependency', (_name, tool) => {
    const keys = tool.getDependencies().map((d) => d.key);
    expect(keys).toContain('llmProvider');
  });

  it.each(TOOLS)('%s returns a sane default config', (_name, tool) => {
    const cfg = tool.getDefaultConfig();
    expect(cfg.enabled).toBe(true);
    expect(typeof cfg.rateLimitPerMinute).toBe('number');
    expect(cfg.rateLimitPerMinute).toBeGreaterThanOrEqual(0);
    expect(cfg.settings).toEqual({});
  });
});
