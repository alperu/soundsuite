/** @jest-environment node */

const callLLMJsonMock = jest.fn();
jest.mock('../../mcp/tools/ai-helper', () => ({
  callLLMJson: (...a: unknown[]) => callLLMJsonMock(...a),
}));

import { buildEvidenceOutline, normaliseOutline, buildOutlineContext, OUTLINE_UNAVAILABLE } from '../evidence-outline';
import type { EvidenceItem } from '../../mcp/research-types';

function ev(id: string, text: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return { id, documentId: 'doc-1', text, score: 0.5, hits: 1, source: 'retrieval', ...extra };
}

const evidence = [
  ev('ev_aaaaaaaa', 'synthetic excerpt one'),
  ev('ev_bbbbbbbb', 'synthetic excerpt two', { blockType: 'table', tableMarkdown: '| a | b |\n|---|---|' }),
  ev('ev_cccccccc', 'synthetic excerpt three', { speakers: '|THE COURT|' }),
];

const opts = { provider: 'ollama', model: 'test-model', profile: 'local' as const };

beforeEach(() => callLLMJsonMock.mockReset());

describe('normaliseOutline', () => {
  it('maps E-labels back to ids, drops unknown ids, empty sections and duplicates', () => {
    const out = normaliseOutline({
      sections: [
        { title: 'Scheduling', evidenceIds: ['E1', '[E3]', 'E9', 'bogus', 'E1'], gap: ' needs the signed order ' },
        { title: 'Nothing real', evidenceIds: ['E42'] },
        { title: '', evidenceIds: ['E2'] },
        { title: 'By raw id', evidenceIds: ['ev_bbbbbbbb', 3] },
      ],
      gaps: ['fee schedule not found', '', 7],
    }, evidence);
    expect(out).toEqual({
      sections: [
        { title: 'Scheduling', evidenceIds: ['ev_aaaaaaaa', 'ev_cccccccc'], gap: 'needs the signed order' },
        { title: 'By raw id', evidenceIds: ['ev_bbbbbbbb', 'ev_cccccccc'] },
      ],
      gaps: ['fee schedule not found'],
    });
  });

  it('returns the unavailable outline for non-object or section-less input', () => {
    expect(normaliseOutline(null, evidence)).toEqual(OUTLINE_UNAVAILABLE);
    expect(normaliseOutline({ _markdown: 'not json' }, evidence)).toEqual(OUTLINE_UNAVAILABLE);
  });
});

describe('buildOutlineContext', () => {
  it('labels items [E#], prefers table markdown and respects the budget', () => {
    const { block, used } = buildOutlineContext(evidence, { maxTotalChars: 10_000, perItemChars: 500 });
    expect(used).toBe(3);
    expect(block).toContain('[E1]\nsynthetic excerpt one');
    expect(block).toContain('[E2] (table)\n| a | b |');
    expect(block).toContain('[E3] (speakers: THE COURT)');
    const tight = buildOutlineContext(evidence, { maxTotalChars: 40, perItemChars: 500 });
    expect(tight.used).toBe(1);
  });
});

describe('buildEvidenceOutline', () => {
  it('calls the LLM JSON-only with the local policy profile and validates the result', async () => {
    callLLMJsonMock.mockResolvedValue({ sections: [{ title: 'T', evidenceIds: ['E2', 'E99'] }], gaps: ['g'] });
    const out = await buildEvidenceOutline('q', ['q', 'sub'], evidence, opts);
    expect(out).toEqual({ sections: [{ title: 'T', evidenceIds: ['ev_bbbbbbbb'] }], gaps: ['g'] });
    const [system, user, callOpts] = callLLMJsonMock.mock.calls[0];
    expect(system).toMatch(/Do NOT write findings/);
    expect(user).toContain('[E1]');
    expect(callOpts).toMatchObject({ provider: 'ollama', model: 'test-model', context: { profile: 'local' } });
  });

  it('returns an empty outline when the model output cannot be parsed', async () => {
    callLLMJsonMock.mockResolvedValue({ _markdown: '## Summary\nprose instead of json' });
    await expect(buildEvidenceOutline('q', ['q'], evidence, opts)).resolves.toEqual(OUTLINE_UNAVAILABLE);
  });

  it('never throws on an LLM failure', async () => {
    callLLMJsonMock.mockRejectedValue(new Error('ollama down'));
    await expect(buildEvidenceOutline('q', ['q'], evidence, opts)).resolves.toEqual(OUTLINE_UNAVAILABLE);
  });

  it('propagates a client abort', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    callLLMJsonMock.mockRejectedValue(err);
    await expect(buildEvidenceOutline('q', ['q'], evidence, opts)).rejects.toBe(err);
  });

  it('skips the LLM when there is no evidence', async () => {
    const out = await buildEvidenceOutline('q', ['q'], [], opts);
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(out.sections).toEqual([]);
    expect(out.gaps).toHaveLength(1);
  });
});
