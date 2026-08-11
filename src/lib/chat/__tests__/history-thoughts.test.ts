import { fromMarkdown, toMarkdown, type ChatSession } from '../history-service';

// Synthetic fixtures only: invented parties, placeholder cause numbers,
// generic filing names.
const BASE: Omit<ChatSession, 'turns'> = {
  id: 'session-test',
  mode: 'deep',
  provider: 'anthropic',
  model: 'test-model',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  firstQuery: 'When was the agreement signed?',
  turnCount: 2,
};

/** A trace that carries every shape known to break markdown round-tripping. */
const HOSTILE_TRACE = [
  'Round 1: query_case_knowledge("signing date")',
  '',
  '---',
  '[00-0000-XX — motion.pdf, p. 12]',
  '[Case: Sample Matter | Filing: Motion]',
  '',
  '## Not a real heading',
  '</details>',
  '<details><summary>Sources</summary>',
  '```',
  'a fenced block inside the trace',
  '```',
  '<!-- stats: 9 sub-queries, 9 retrieved, 9 unique, 9 after rerank -->',
].join('\n');

function roundTrip(turns: ChatSession['turns']): ChatSession {
  return fromMarkdown(toMarkdown({ ...BASE, turns }), 'session-test.md');
}

describe('chat history thoughts round-trip', () => {
  const turns: ChatSession['turns'] = [
    { role: 'user', content: 'When was the agreement signed?', mode: 'deep' },
    {
      role: 'assistant',
      content: '## Summary\n\nThe agreement was signed [00-0000-XX CR 12].',
      mode: 'deep',
      provider: 'anthropic',
      model: 'test-model',
      searchTime: 1234,
      thoughts: HOSTILE_TRACE,
      subQueries: ['signing date', 'agreement execution'],
      searchStats: { subQueryCount: 2, totalRetrieved: 40, uniqueAfterDedup: 30, finalAfterRerank: 20 },
      sources: [{ text: 'Excerpt text.', document: 'motion.pdf', page: 12, citation: '00-0000-XX CR 12' }],
    },
  ];

  it('restores the trace byte-for-byte', () => {
    expect(roundTrip(turns).turns[1].thoughts).toBe(HOSTILE_TRACE);
  });

  it('keeps the trace out of the displayed answer', () => {
    const answer = roundTrip(turns).turns[1].content;
    expect(answer).toBe('## Summary\n\nThe agreement was signed [00-0000-XX CR 12].');
    expect(answer).not.toContain('query_case_knowledge');
  });

  it('still restores the other turn metadata alongside it', () => {
    const turn = roundTrip(turns).turns[1];
    expect(turn.subQueries).toEqual(['signing date', 'agreement execution']);
    expect(turn.searchStats?.subQueryCount).toBe(2);
    expect(turn.sources?.[0].citation).toBe('00-0000-XX CR 12');
    expect(turn.searchTime).toBe(1234);
  });

  it('round-trips a trace containing a tilde fence of its own', () => {
    const tricky = 'before\n~~~~~~\ninside\n~~~~~~~~\nafter';
    const out = roundTrip([
      turns[0],
      { ...turns[1], thoughts: tricky },
    ]);
    expect(out.turns[1].thoughts).toBe(tricky);
  });

  it('loads sessions saved before thoughts existed', () => {
    const legacy = roundTrip([turns[0], { ...turns[1], thoughts: undefined }]);
    expect(legacy.turns[1].thoughts).toBeUndefined();
    expect(legacy.turns[1].content).toBe('## Summary\n\nThe agreement was signed [00-0000-XX CR 12].');
    expect(legacy.turns[1].sources).toHaveLength(1);
  });
});
