/** @jest-environment node */

const callLLMJsonMock = jest.fn();
jest.mock('../../mcp/tools/ai-helper', () => ({
  callLLMJson: (...a: unknown[]) => callLLMJsonMock(...a),
}));

import {
  buildEvidenceOutline,
  normaliseOutline,
  buildOutlineContext,
  selectOutlineItems,
  OUTLINE_DEFAULTS,
} from '../evidence-outline';
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

  it('returns null for non-object, section-less, or wholly empty input', () => {
    expect(normaliseOutline(null, evidence)).toBeNull();
    expect(normaliseOutline({ _markdown: 'not json' }, evidence)).toBeNull();
    expect(normaliseOutline({ sections: [], gaps: [] }, evidence)).toBeNull();
  });

  it('keeps a gaps-only outline — the most valuable answer', () => {
    expect(normaliseOutline({ sections: [], gaps: ['no filing addresses the fee schedule'] }, evidence)).toEqual({
      sections: [],
      gaps: ['no filing addresses the fee schedule'],
    });
  });
});

describe('selectOutlineItems', () => {
  it('keeps the highest-scoring maxItems in retrieval order', () => {
    const many = [
      ev('ev_1', 'one', { score: 0.1 }),
      ev('ev_2', 'two', { score: 0.9 }),
      ev('ev_3', 'three', { score: 0.4 }),
      ev('ev_4', 'four', { score: 0.8, rerankScore: 0.95 }),
    ];
    expect(selectOutlineItems(many, 2).map((e) => e.id)).toEqual(['ev_2', 'ev_4']);
    expect(selectOutlineItems(many, 10)).toHaveLength(4);
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
    const out = await buildEvidenceOutline(evidence, 'q', ['q', 'sub'], opts);
    expect(out).toEqual({ sections: [{ title: 'T', evidenceIds: ['ev_bbbbbbbb'] }], gaps: ['g'] });
    const [system, user, callOpts] = callLLMJsonMock.mock.calls[0];
    expect(system).toMatch(/Do NOT write findings/);
    expect(user).toContain('[E1]');
    expect(callOpts).toMatchObject({ provider: 'ollama', model: 'test-model', context: { profile: 'local' } });
  });

  it('caps what the model sees at maxItems / maxCharsPerItem', async () => {
    callLLMJsonMock.mockResolvedValue({ sections: [{ title: 'T', evidenceIds: ['E1'] }], gaps: [] });
    const many = Array.from({ length: 12 }, (_, i) =>
      ev(`ev_${i}`, `synthetic excerpt ${i} `.repeat(200), { score: i / 12 }),
    );
    await buildEvidenceOutline(many, 'q', ['q'], { ...opts, maxItems: 3, maxCharsPerItem: 50 });
    const user = callLLMJsonMock.mock.calls[0][1] as string;
    expect(user).toContain('3 of 12 excerpts shown');
    expect(user).toContain('[E3]');
    expect(user).not.toContain('[E4]');
    expect(user.length).toBeLessThan(1_000);
  });

  it('returns null with a reason when the model output cannot be parsed', async () => {
    callLLMJsonMock.mockResolvedValue({ _markdown: '## Summary\nprose instead of json' });
    const onWarn = jest.fn();
    await expect(buildEvidenceOutline(evidence, 'q', ['q'], { ...opts, onWarn })).resolves.toBeNull();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('outline unusable'), expect.any(Object));
  });

  it('returns null with a reason on an LLM failure — never a per-document grouping', async () => {
    callLLMJsonMock.mockRejectedValue(new Error('ollama down'));
    const onWarn = jest.fn();
    await expect(buildEvidenceOutline(evidence, 'q', ['q'], { ...opts, onWarn })).resolves.toBeNull();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('ollama down'), expect.any(Object));
  });

  it('enforces its own timeoutMs and returns null rather than throwing', async () => {
    callLLMJsonMock.mockImplementation((_s: unknown, _u: unknown, o: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        o.signal?.addEventListener('abort', () => {
          const e = new Error('Ollama completion aborted by caller');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    );
    const onWarn = jest.fn();
    await expect(
      buildEvidenceOutline(evidence, 'q', ['q'], { ...opts, timeoutMs: 20, onWarn }),
    ).resolves.toBeNull();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('timed out after 20 ms'), expect.objectContaining({ timedOut: true }));
  });

  it('clamps an oversized caller timeout to its own ceiling', async () => {
    jest.useFakeTimers();
    try {
      callLLMJsonMock.mockImplementation((_s: unknown, _u: unknown, o: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => {
            const e = new Error('aborted by caller');
            e.name = 'AbortError';
            reject(e);
          });
        }),
      );
      const onWarn = jest.fn();
      // The caller hands us its own 60 s phase budget — we must still stop at 25 s.
      const p = buildEvidenceOutline(evidence, 'q', ['q'], { ...opts, timeoutMs: 60_000, onWarn });
      jest.advanceTimersByTime(OUTLINE_DEFAULTS.timeoutMs + 1);
      await expect(p).resolves.toBeNull();
      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining(`timed out after ${OUTLINE_DEFAULTS.timeoutMs} ms`),
        expect.objectContaining({ timedOut: true }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates a caller abort', async () => {
    const controller = new AbortController();
    const err = new Error('aborted');
    err.name = 'AbortError';
    callLLMJsonMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(err);
    });
    await expect(
      buildEvidenceOutline(evidence, 'q', ['q'], { ...opts, signal: controller.signal }),
    ).rejects.toBe(err);
  });

  it('skips the LLM when there is no evidence', async () => {
    const out = await buildEvidenceOutline([], 'q', ['q'], opts);
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(out).toEqual({ sections: [], gaps: ['no evidence retrieved'] });
  });
});
