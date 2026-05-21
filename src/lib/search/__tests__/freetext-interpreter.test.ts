import {
  interpretQuery,
  compileToEnglish,
  type InterpretContext,
  type PersonIndexEntry,
  type CaseIndexEntry,
} from '../freetext-interpreter';

const PERSONS: PersonIndexEntry[] = [
  { id: 'person-roberts', displayName: 'Judge Roberts', intrinsicTags: { judge: true } },
  { id: 'person-alper', displayName: 'Alper Bilgen', intrinsicTags: { lawyer: true } },
  { id: 'person-smith', displayName: 'Mary Smith', intrinsicTags: { lawyer: true } },
];

const CASES: CaseIndexEntry[] = [
  { id: 'case-005611', causeNo: 'D-1-FM-21-005611', name: 'Smith v. Smith' },
  { id: 'case-roberts-smith', name: 'Roberts vs Smith' },
];

function ctxAt(iso: string): InterpretContext {
  return { personIndex: PERSONS, caseIndex: CASES, now: new Date(iso) };
}

describe('interpretQuery', () => {
  it('parses "motions filed on 2026-04-15"', async () => {
    const r = await interpretQuery('motions filed on 2026-04-15', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toContain('motionEvent');
    expect(r.compiledFilter).toContain('kind=="filed"');
    expect(r.compiledFilter).toContain('courtFilingDate=="2026-04-15"');
    expect(r.confidence).toBe('high');
  });

  it('resolves Judge Roberts and "signed"', async () => {
    const r = await interpretQuery('motions Judge Roberts signed', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toContain('motionEvent');
    expect(r.compiledFilter).toContain('kind=="signed"');
    expect(r.compiledFilter).toContain('judgeRef==@person-roberts');
    expect(r.confidence).not.toBe('low');
  });

  it('detects "amended proposed orders"', async () => {
    const r = await interpretQuery('amended proposed orders', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toContain('motionAttachment');
    expect(r.compiledFilter).toContain('attachmentKind=="proposedOrder"');
    expect(r.compiledFilter).toContain('revisionSeq>1');
  });

  it('builds a PersonRole filter from "movant X"', async () => {
    const r = await interpretQuery(
      'everyone Alper has appeared as movant for',
      ctxAt('2026-05-20T00:00:00Z'),
    );
    expect(r.compiledFilter).toContain('personRole');
    expect(r.compiledFilter).toContain('movant');
    expect(r.compiledFilter).toContain('personRef==@person-alper');
  });

  it('parses "hearings next week" into a date range', async () => {
    // 2026-05-20 is a Wednesday → start of this week (Mon) = 2026-05-18 → next week 2026-05-25..2026-05-31
    const r = await interpretQuery('hearings next week', ctxAt('2026-05-20T12:00:00Z'));
    expect(r.compiledFilter).toContain('hearing');
    expect(r.compiledFilter).toMatch(/scheduledFor>=2026-05-2[5-9]/);
    expect(r.compiledFilter).toMatch(/scheduledFor<=2026-05-3[01]/);
  });

  it('detects "lawyers admitted in Texas"', async () => {
    const r = await interpretQuery('lawyers admitted in Texas', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toContain('person');
    expect(r.compiledFilter).toContain('lawyer');
    expect(r.compiledFilter).toContain('jurisdictionTx');
  });

  it('resolves a cause-number to caseRef', async () => {
    const r = await interpretQuery(
      'case D-1-FM-21-005611',
      ctxAt('2026-05-20T00:00:00Z'),
    );
    expect(r.compiledFilter).toContain('caseRef==@case-005611');
  });

  it('returns low confidence for empty/junk', async () => {
    const r = await interpretQuery('zzz qqq the a', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toBe('');
    expect(r.confidence).toBe('low');
    expect(r.chips.length).toBe(0);
  });

  it('round-trips through compileToEnglish (best-effort)', async () => {
    const r = await interpretQuery('motions filed on 2026-04-15', ctxAt('2026-05-20T00:00:00Z'));
    const english = compileToEnglish(r.chips, r.freetextResidual);
    // The summary should mention the date and be non-empty.
    expect(english.length).toBeGreaterThan(0);
    expect(english).toMatch(/2026-04-15/);
  });

  it('clears trivial freetext residual', async () => {
    const r = await interpretQuery('the motions', ctxAt('2026-05-20T00:00:00Z'));
    expect(r.compiledFilter).toContain('motion');
    expect(r.freetextResidual).toBe('');
  });
});
