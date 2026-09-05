/** @jest-environment node */
/**
 * SS-3 — LLM contract for the ten analysis tools that call a model.
 *
 * `callLLMJson` / `extractJson` are deliberately NOT mocked: the whole point is
 * to exercise the real parse-and-retry path in `ai-helper.ts`. Only the
 * transport (`completeAI`) is stubbed, so a malformed model response travels
 * the same code path it would in production.
 *
 * All fixtures synthetic (see analysis-tool-harness.ts).
 */

jest.mock('../../../ai/ai-provider', () => ({ completeAI: jest.fn() }));
jest.mock('../../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ ollamaHost: 'http://127.0.0.1:11434' }),
}));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => results.slice(0, topN)),
}));

import { completeAI } from '../../../ai/ai-provider';
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
import type { BaseMCPTool } from '../base-tool';
import { CONFIG, aiResponse, makeHarness, makeEmptyHarness } from './analysis-tool-harness';

const ai = completeAI as unknown as jest.Mock;

/** Model output that is prose, not JSON — the small-model failure mode. */
const PROSE =
  'I reviewed the excerpts. There appear to be several inconsistencies between the ' +
  'filings, particularly around the January conference. Let me know if you want detail.';

/** Model output that starts as JSON and is cut off by the token limit. */
const TRUNCATED = '{"contradictions": [{"statement1": "the conference occurred", "statem';

interface Spec {
  name: string;
  tool: BaseMCPTool<any, any>;
  params: Record<string, unknown>;
  /** Top-level key of the documented result shape. */
  key: string;
  /** Tool checks `Array.isArray(result[key])` before using it. */
  guarded: boolean;
  /** A well-formed model response for the happy path. */
  good: Record<string, unknown>;
  /** Fields the documented item shape declares. */
  itemFields: string[];
  /** Valid JSON under the right key whose items break the documented shape. */
  junk: Record<string, unknown>;
  /** What the tool returns when the vector store yields nothing. */
  emptyResult: Record<string, unknown>;
}

const SPECS: Spec[] = [
  {
    name: 'detect_contradictions',
    tool: new DetectContradictionsTool(),
    params: { caseId: 'case-1' },
    key: 'contradictions',
    guarded: true,
    good: {
      contradictions: [
        {
          statement1: 'A conference was held on 2024-01-15.',
          statement2: 'No conference occurred on 2024-01-15.',
          document1: 'motion.pdf',
          document2: 'response.pdf',
          confidence: 0.92,
          explanation: 'The filings assert opposite facts about the same date.',
        },
      ],
    },
    itemFields: ['statement1', 'statement2', 'document1', 'document2', 'confidence', 'explanation'],
    // confidence present so the item survives the threshold filter and the
    // missing-field problem is observable rather than masked by it.
    junk: { contradictions: [{ confidence: 0.99, note: 'the filings seem to disagree' }] },
    emptyResult: { contradictions: [] },
  },
  {
    name: 'detect_privilege',
    tool: new DetectPrivilegeTool(),
    params: { documentId: 'doc-1' },
    key: 'privileged',
    guarded: true,
    good: {
      privileged: [
        {
          text: 'Counsel advised the client regarding settlement posture.',
          privilegeType: 'attorney_client',
          confidence: 0.88,
          document: 'motion.pdf',
          page: 1,
          reason: 'Communication between counsel and client conveying legal advice.',
        },
      ],
    },
    itemFields: ['text', 'privilegeType', 'confidence', 'document', 'page', 'reason'],
    junk: { privileged: [{ confidence: 0.99, note: 'looks privileged' }] },
    emptyResult: { privileged: [] },
  },
  {
    name: 'analyze_citations',
    tool: new AnalyzeCitationsTool(),
    params: { caseId: 'case-1' },
    key: 'citations',
    guarded: true,
    good: {
      citations: [
        {
          citation: 'Vaughn v. Merrowfield, 1 F.3d 1 (5th Cir. 1993)',
          type: 'case_law',
          frequency: 2,
          documents: ['motion.pdf'],
          context: 'cited as authority for the production standard',
        },
      ],
    },
    itemFields: ['citation', 'type', 'frequency', 'documents', 'context'],
    junk: { citations: ['Vaughn v. Merrowfield, 1 F.3d 1'] },
    emptyResult: { citations: [] },
  },
  {
    name: 'extract_obligations',
    tool: new ExtractObligationsTool(),
    params: { documentId: 'doc-1' },
    key: 'obligations',
    guarded: true,
    good: {
      obligations: [
        {
          description: 'Produce responsive documents.',
          type: 'disclosure',
          deadline: '2024-03-01',
          party: 'Quill Fabrication Inc.',
          document: 'motion.pdf',
          page: 1,
        },
      ],
    },
    itemFields: ['description', 'type', 'deadline', 'party', 'document', 'page'],
    junk: { obligations: [{ description: 'produce documents' }] },
    emptyResult: { obligations: [] },
  },
  {
    name: 'reconstruct_timeline',
    tool: new ReconstructTimelineTool(),
    params: { caseId: 'case-1' },
    key: 'events',
    guarded: true,
    good: {
      events: [
        {
          date: '2024-01-15',
          description: 'Counsel conferred regarding discovery.',
          document: 'motion.pdf',
          page: 1,
          confidence: 0.8,
        },
      ],
    },
    itemFields: ['date', 'description', 'document', 'page', 'confidence'],
    junk: { events: ['2024-01-15 — the parties conferred'] },
    emptyResult: { events: [] },
  },
  {
    name: 'extract_entities',
    tool: new ExtractEntitiesTool(),
    params: { documentId: 'doc-1' },
    key: 'entities',
    guarded: true,
    good: {
      entities: [
        {
          name: 'Nordvale Holdings LLC',
          type: 'organization',
          mentions: 2,
          context: 'movant',
          document: 'motion.pdf',
          page: 1,
        },
      ],
    },
    itemFields: ['name', 'type', 'mentions', 'context', 'document', 'page'],
    junk: { entities: ['Nordvale Holdings LLC'] },
    emptyResult: { entities: [] },
  },
  {
    name: 'track_claim_evolution',
    tool: new TrackClaimEvolutionTool(),
    params: { caseId: 'case-1', claim: 'a discovery conference took place' },
    key: 'evolution',
    guarded: true,
    good: {
      evolution: [
        {
          document: 'motion.pdf',
          date: '2024-01-15',
          statement: 'The parties conferred.',
          change: 'initial assertion',
        },
      ],
    },
    itemFields: ['document', 'date', 'statement', 'change'],
    junk: { evolution: [{ statement: 'The parties conferred.' }] },
    emptyResult: { evolution: [] },
  },
  {
    name: 'extract_argument_structure',
    tool: new ExtractArgumentStructureTool(),
    params: { documentId: 'doc-1' },
    key: 'arguments',
    guarded: true,
    good: {
      arguments: [
        {
          claim: 'Production should be compelled.',
          premises: ['A conference was held.'],
          evidence: ['motion.pdf p.1'],
          conclusion: 'The Court should grant the motion.',
          strength: 'moderate',
        },
      ],
    },
    itemFields: ['claim', 'premises', 'evidence', 'conclusion', 'strength'],
    junk: { arguments: ['Production should be compelled.'] },
    emptyResult: { arguments: [] },
  },
  {
    name: 'compare_argument_structures',
    tool: new CompareArgumentStructuresTool(),
    params: { documentId1: 'doc-1', documentId2: 'doc-2' },
    key: 'comparison',
    guarded: false,
    good: {
      comparison: {
        shared: ['the January conference'],
        uniqueToDoc1: ['production standard'],
        uniqueToDoc2: ['timeliness'],
        conflicts: [
          { topic: 'conference', doc1Position: 'occurred', doc2Position: 'did not occur' },
        ],
      },
    },
    itemFields: ['shared', 'uniqueToDoc1', 'uniqueToDoc2', 'conflicts'],
    junk: { comparison: { shared: ['the January conference'] } },
    emptyResult: { comparison: { shared: [], uniqueToDoc1: [], uniqueToDoc2: [], conflicts: [] } },
  },
  {
    name: 'analyze_tone',
    tool: new AnalyzeToneTool(),
    params: { documentId: 'doc-1' },
    key: 'analysis',
    guarded: false,
    good: {
      analysis: {
        overallTone: 'formal',
        confidence: 0.7,
        segments: [{ text: 'Movant respectfully requests', tone: 'deferential', intensity: 0.4, page: 1 }],
        patterns: ['procedural formality'],
      },
    },
    itemFields: ['overallTone', 'confidence', 'segments', 'patterns'],
    junk: { analysis: { overallTone: 'formal' } },
    emptyResult: { analysis: { overallTone: 'unknown', confidence: 0, segments: [], patterns: [] } },
  },
];

beforeEach(() => {
  ai.mockReset();
});

describe.each(SPECS.map((s) => [s.name, s] as const))('%s', (_name, spec) => {
  describe('happy path', () => {
    it('returns the documented result shape from a well-formed model response', async () => {
      ai.mockResolvedValue(aiResponse(JSON.stringify(spec.good)));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      expect(out.success).toBe(true);
      expect(out.data).toEqual(spec.good);
      expect(ai).toHaveBeenCalledTimes(1);
    });

    it('tolerates a markdown-fenced response', async () => {
      ai.mockResolvedValue(aiResponse('```json\n' + JSON.stringify(spec.good) + '\n```'));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      expect(out.success).toBe(true);
      expect(out.data).toEqual(spec.good);
      expect(ai).toHaveBeenCalledTimes(1);
    });

    it('sends the retrieved evidence to the model as the user turn', async () => {
      ai.mockResolvedValue(aiResponse(JSON.stringify(spec.good)));
      const { context } = makeHarness();

      await spec.tool.execute(spec.params, context, CONFIG);

      const { messages } = ai.mock.calls[0][0];
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('Nordvale Holdings LLC');
    });
  });

  describe('no evidence', () => {
    it('short-circuits to an empty result without calling the model', async () => {
      const { context } = makeEmptyHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      expect(out.success).toBe(true);
      expect(out.data).toEqual(spec.emptyResult);
      expect(ai).not.toHaveBeenCalled();
    });
  });

  describe('malformed model output', () => {
    it('retries once when the model answers with prose instead of JSON', async () => {
      // Pinned as behaviour: ai-helper.ts callLLMJson re-sends the full context
      // with a stronger JSON instruction before giving up. Asserting the count
      // also proves the tests below fail because of the degradation path, not
      // because a `mockResolvedValueOnce` ran dry.
      ai.mockResolvedValue(aiResponse(PROSE));
      const { context } = makeHarness();

      await spec.tool.execute(spec.params, context, CONFIG);

      expect(ai).toHaveBeenCalledTimes(2);
    });

    it('does not throw an unhandled exception on prose output', async () => {
      ai.mockResolvedValue(aiResponse(PROSE));
      const { context } = makeHarness();

      await expect(spec.tool.execute(spec.params, context, CONFIG)).resolves.toBeDefined();
    });

    it('does not throw an unhandled exception on truncated JSON', async () => {
      ai.mockResolvedValue(aiResponse(TRUNCATED));
      const { context } = makeHarness();

      await expect(spec.tool.execute(spec.params, context, CONFIG)).resolves.toBeDefined();
    });

    // FIXED (SS-3): `callLLMJson` used to give up by returning
    // `{ _markdown: raw }`. Downstream, guarded tools turned that into
    // `{key: []}` — a parse failure reported as "nothing found", which on
    // litigation material is indistinguishable from a genuine negative answer
    // — and the two unguarded tools returned `{_markdown: "<prose>"}` with the
    // documented key absent. Both now fail loudly; the `_markdown` fallback
    // survives only behind `allowMarkdownFallback: true` for the dashboard
    // deep-search / evidence-outline call sites.
    it('REQUIRED: fails with a legible error when the model output cannot be parsed', async () => {
      ai.mockResolvedValue(aiResponse(PROSE));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/JSON|parse/i);
    });

    it('REQUIRED: a parse failure is not presented as an empty/partial answer', async () => {
      ai.mockResolvedValue(aiResponse(TRUNCATED));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      // Neither "nothing found" nor a `_markdown` stand-in may be returned as
      // a successful analysis result.
      expect(out.success && JSON.stringify(out.data) === JSON.stringify(spec.emptyResult)).toBe(false);
      expect(out.data && (out.data as any)._markdown).toBeUndefined();
    });
  });

  describe('valid JSON, wrong item shape', () => {
    // The nastiest case: the model returns syntactically valid JSON under the
    // right top-level key, but the items do not match the documented item
    // schema. Every tool checks only `Array.isArray(result[key])` (or, for the
    // two unguarded ones, nothing at all), so these reach the MCP client typed
    // as real findings.
    it('CURRENT BEHAVIOUR: the top-level key is checked but item shape is not', async () => {
      ai.mockResolvedValue(aiResponse(JSON.stringify(spec.junk)));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      expect(out.success).toBe(true);
      expect(ai).toHaveBeenCalledTimes(1); // parsed fine — no retry
      const value = (out.data as any)[spec.key];
      const items = Array.isArray(value) ? value : [value];
      expect(items.length).toBeGreaterThan(0);
      // At least one documented field is missing on a returned item.
      expect(
        items.some((item: any) => spec.itemFields.some((f) => item?.[f] === undefined)),
      ).toBe(true);
    });

    it.failing('REQUIRED: items missing documented fields are rejected or dropped', async () => {
      ai.mockResolvedValue(aiResponse(JSON.stringify(spec.junk)));
      const { context } = makeHarness();

      const out = await spec.tool.execute(spec.params, context, CONFIG);

      if (!out.success) {
        expect(out.errorCode).toBeTruthy();
        return;
      }
      const value = (out.data as any)[spec.key];
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        for (const field of spec.itemFields) {
          expect(item?.[field]).toBeDefined();
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Confidence handling — the two tools that filter on a model-supplied number.
// ---------------------------------------------------------------------------

describe('confidence filtering (detect_contradictions, detect_privilege)', () => {
  interface ConfidenceCase {
    name: string;
    tool: BaseMCPTool<any, any>;
    params: Record<string, unknown>;
    key: string;
    item: (confidence: unknown) => Record<string, unknown>;
  }

  const cases: ConfidenceCase[] = [
    {
      name: 'detect_contradictions',
      tool: new DetectContradictionsTool(),
      params: { caseId: 'case-1' },
      key: 'contradictions',
      item: (confidence: unknown) => ({
        statement1: 'A conference was held.',
        statement2: 'No conference was held.',
        document1: 'motion.pdf',
        document2: 'response.pdf',
        explanation: 'opposite assertions',
        ...(confidence === undefined ? {} : { confidence }),
      }),
    },
    {
      name: 'detect_privilege',
      tool: new DetectPrivilegeTool(),
      params: { documentId: 'doc-1' },
      key: 'privileged',
      item: (confidence: unknown) => ({
        text: 'Counsel advised the client.',
        privilegeType: 'attorney_client',
        document: 'motion.pdf',
        page: 1,
        reason: 'legal advice',
        ...(confidence === undefined ? {} : { confidence }),
      }),
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: keeps items at or above the threshold',
    async (_n, c) => {
      ai.mockResolvedValue(aiResponse(JSON.stringify({ [c.key]: [c.item(0.9), c.item(0.4)] })));
      const { context } = makeHarness();

      const out = await c.tool.execute({ ...c.params, confidence_threshold: 0.7 } as any, context, CONFIG);

      expect(out.success).toBe(true);
      expect((out.data as any)[c.key]).toHaveLength(1);
      expect((out.data as any)[c.key][0].confidence).toBe(0.9);
    },
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: CURRENT BEHAVIOUR — an item with no confidence is silently dropped',
    async (_n, c) => {
      // `undefined >= 0.7` is false, so a finding the model reported but did
      // not score disappears with no signal to the caller. On litigation
      // material a dropped contradiction/privilege hit is a substantive loss.
      ai.mockResolvedValue(aiResponse(JSON.stringify({ [c.key]: [c.item(undefined)] })));
      const { context } = makeHarness();

      const out = await c.tool.execute(c.params as any, context, CONFIG);

      expect(out.success).toBe(true);
      expect((out.data as any)[c.key]).toEqual([]);
    },
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: CURRENT BEHAVIOUR — a string confidence passes the numeric filter uncoerced',
    async (_n, c) => {
      // `"0.9" >= 0.7` coerces and passes, so the client receives a string
      // where the declared result type says number.
      ai.mockResolvedValue(aiResponse(JSON.stringify({ [c.key]: [c.item('0.9')] })));
      const { context } = makeHarness();

      const out = await c.tool.execute(c.params as any, context, CONFIG);

      expect(out.success).toBe(true);
      expect((out.data as any)[c.key]).toHaveLength(1);
      expect(typeof (out.data as any)[c.key][0].confidence).toBe('string');
    },
  );

  // Encodes the fix: coerce/validate confidence rather than letting JS
  // comparison semantics decide. Flip away from `failing` when fixed.
  it.failing('detect_contradictions: REQUIRED — confidence reaches the client as a number', async () => {
    const c = cases[0];
    ai.mockResolvedValue(aiResponse(JSON.stringify({ [c.key]: [c.item('0.9')] })));
    const { context } = makeHarness();

    const out = await c.tool.execute(c.params as any, context, CONFIG);
    const item = (out.data as any)?.[c.key]?.[0];
    expect(item === undefined || typeof item.confidence === 'number').toBe(true);
  });

  it.failing('detect_privilege: REQUIRED — confidence reaches the client as a number', async () => {
    const c = cases[1];
    ai.mockResolvedValue(aiResponse(JSON.stringify({ [c.key]: [c.item('0.9')] })));
    const { context } = makeHarness();

    const out = await c.tool.execute(c.params as any, context, CONFIG);
    const item = (out.data as any)?.[c.key]?.[0];
    expect(item === undefined || typeof item.confidence === 'number').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Limits and branch coverage that only apply to individual tools.
// ---------------------------------------------------------------------------

describe('per-tool specifics', () => {
  it('detect_contradictions truncates to `limit`', async () => {
    const item = (i: number) => ({
      statement1: `s${i}a`,
      statement2: `s${i}b`,
      document1: 'motion.pdf',
      document2: 'response.pdf',
      confidence: 0.95,
      explanation: 'x',
    });
    ai.mockResolvedValue(aiResponse(JSON.stringify({ contradictions: [item(1), item(2), item(3)] })));
    const { context } = makeHarness();

    const out = await new DetectContradictionsTool().execute(
      { caseId: 'case-1', limit: 2 },
      context,
      CONFIG,
    );

    expect((out.data as any).contradictions).toHaveLength(2);
  });

  it('detect_contradictions takes the topic-search path only when `topic` is given', async () => {
    ai.mockResolvedValue(aiResponse(JSON.stringify({ contradictions: [] })));

    const plain = makeHarness();
    await new DetectContradictionsTool().execute({ caseId: 'case-1' }, plain.context, CONFIG);
    expect(plain.context.embeddingProvider.embed).not.toHaveBeenCalled();

    const topical = makeHarness();
    await new DetectContradictionsTool().execute(
      { caseId: 'case-1', topic: 'discovery conference' },
      topical.context,
      CONFIG,
    );
    expect(topical.context.embeddingProvider.embed).toHaveBeenCalledWith(['discovery conference']);
  });

  it('track_claim_evolution embeds the claim for topic retrieval', async () => {
    ai.mockResolvedValue(aiResponse(JSON.stringify({ evolution: [] })));
    const { context } = makeHarness();

    await new TrackClaimEvolutionTool().execute(
      { caseId: 'case-1', claim: 'a discovery conference took place' },
      context,
      CONFIG,
    );

    expect(context.embeddingProvider.embed).toHaveBeenCalledWith([
      'a discovery conference took place',
    ]);
  });

  it('detect_privilege broadens to the case when caseId is supplied', async () => {
    ai.mockResolvedValue(aiResponse(JSON.stringify({ privileged: [] })));
    const { context, search } = makeHarness();

    await new DetectPrivilegeTool().execute(
      { documentId: 'doc-1', caseId: 'case-1' },
      context,
      CONFIG,
    );

    expect(search.mock.calls[0][0].filter).toEqual({ caseId: 'case-1' });
  });

  it('analyze_citations narrows to a single document when documentId is supplied', async () => {
    ai.mockResolvedValue(aiResponse(JSON.stringify({ citations: [] })));
    const { context, search } = makeHarness();

    await new AnalyzeCitationsTool().execute(
      { caseId: 'case-1', documentId: 'doc-1' },
      context,
      CONFIG,
    );

    expect(search.mock.calls[0][0].filter).toEqual({ documentId: 'doc-1' });
  });
});
