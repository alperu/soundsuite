import { segmentChipsAndIntents } from '../chip-segments';

describe('segmentChipsAndIntents', () => {
  it('returns empty array for empty input', () => {
    expect(segmentChipsAndIntents('')).toEqual([]);
  });

  it('returns a single framing segment when there are no chips', () => {
    const out = segmentChipsAndIntents('how trust evolved over time');
    expect(out).toEqual([{ kind: 'framing', text: 'how trust evolved over time' }]);
  });

  it('pairs each chip with the free text that follows it', () => {
    const input =
      '{{ filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016 }}  In this document we have Torrez\'s changing statement and check all of this   ' +
      '{{ (case==@04a8cd94 or case==@92b9ad81 or case==@1535c622 or case==@c608b81a) }}   how trust evolved over time.';

    const out = segmentChipsAndIntents(input);

    // 2 chips, no leading framing (no text before the first chip)
    expect(out).toHaveLength(2);
    expect(out.every(s => s.kind === 'chip')).toBe(true);

    const chip1 = out[0] as Extract<typeof out[number], { kind: 'chip' }>;
    expect(chip1.raw).toBe('filingRef==@b691a563-eeef-4bae-a2e5-7731012a9016');
    expect(chip1.nextIntent).toBe("In this document we have Torrez's changing statement and check all of this");
    expect(chip1.ast).not.toBeNull();

    const chip2 = out[1] as Extract<typeof out[number], { kind: 'chip' }>;
    expect(chip2.raw).toBe('(case==@04a8cd94 or case==@92b9ad81 or case==@1535c622 or case==@c608b81a)');
    expect(chip2.nextIntent).toBe('how trust evolved over time.');
    expect(chip2.ast).not.toBeNull();
  });

  it('emits a framing segment for text before the first chip', () => {
    const input = 'about the trust fund {{ filingRef==@b691 }} this file specifically';
    const out = segmentChipsAndIntents(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: 'framing', text: 'about the trust fund' });
    expect(out[1].kind).toBe('chip');
    expect((out[1] as { nextIntent: string }).nextIntent).toBe('this file specifically');
  });

  it('handles a chip with no following intent (empty nextIntent)', () => {
    const out = segmentChipsAndIntents('{{ case==@abc }}');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chip');
    expect((out[0] as { nextIntent: string }).nextIntent).toBe('');
  });

  it('records a parseError instead of throwing when chip body is malformed', () => {
    const out = segmentChipsAndIntents('{{ case== }} something');
    expect(out).toHaveLength(1);
    const chip = out[0] as Extract<typeof out[number], { kind: 'chip' }>;
    expect(chip.ast).toBeNull();
    expect(chip.parseError).toBeTruthy();
    expect(chip.nextIntent).toBe('something');
  });

  it('trims whitespace inside the chip braces and between segments', () => {
    const out = segmentChipsAndIntents('   {{   filingRef==@abc   }}   trust evolved   ');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chip');
    const chip = out[0] as { raw: string; nextIntent: string };
    expect(chip.raw).toBe('filingRef==@abc');
    expect(chip.nextIntent).toBe('trust evolved');
  });
});
