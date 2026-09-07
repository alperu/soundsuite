/**
 * @jest-environment node
 *
 * resolve_reference — the tool whose contract is that it does NOT decide.
 *
 * The paired tripwires this suite exists for:
 *   - an unambiguous reference resolves to the right id;
 *   - two near-equal candidates come back BOTH, flagged `ambiguous: true`,
 *     never collapsed to one.
 * A discovery tool that silently picks the wrong case reintroduces the exact
 * false-positive class the SS-3 `caseId is required` fix eliminated.
 *
 * Synthetic fixtures only.
 */

import { ResolveReferenceTool, AMBIGUITY_GAP, REFERENCE_KINDS } from '../resolve-reference';
import { CONFIG, makeContext, fixedFindMany } from './discovery-harness';

const empty = () => ({ findMany: fixedFindMany([]) });

function ctxWith(over: Record<string, any>) {
  return makeContext({ case: empty(), motion: empty(), person: empty(), document: empty(), ...over });
}

describe('resolve_reference metadata', () => {
  const tool = new ResolveReferenceTool();

  it('declares a local-safe contract with `text` required', () => {
    const m = tool.getMetadata();
    expect(m.name).toBe('resolve_reference');
    expect(m.profiles).toEqual(['local', 'routed']);
    expect(m.inputSchema.required).toEqual(['text']);
    expect(m.inputSchema.properties.kinds.items.enum).toEqual(REFERENCE_KINDS);
  });

  it('refuses a call with no text rather than resolving nothing', async () => {
    const res = await tool.execute({} as any, ctxWith({}), CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toBe('text is required');
  });

  it('refuses a blank text', async () => {
    const res = await tool.execute({ text: '   ' }, ctxWith({}), CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
  });
});

describe('resolve_reference ranking', () => {
  const tool = new ResolveReferenceTool();

  it('resolves an unambiguous reference to the right id, not ambiguous', async () => {
    const ctx = ctxWith({
      case: {
        findMany: fixedFindMany([
          {
            id: 'case-aaa',
            name: 'Nordvale Holdings Bill of Review',
            caseNumber: 'CAUSE NO. 00-0000-XX',
            jurisdiction: 'D-1-XX',
          },
        ]),
      },
    });

    const res = await tool.execute({ text: 'CAUSE NO. 00-0000-XX', kinds: ['case'] }, ctx, CONFIG);

    expect(res.success).toBe(true);
    expect(res.data!.candidates).toHaveLength(1);
    expect(res.data!.candidates[0]).toMatchObject({
      kind: 'case',
      id: 'case-aaa',
      matchedOn: 'caseNumber',
      confidence: 0.95,
      caseId: 'case-aaa',
    });
    // One candidate has no "top two" — must not NaN its way into ambiguity.
    expect(res.data!.ambiguous).toBe(false);
  });

  it('takes the strongest field on a row, not the highest-priority one', async () => {
    // caseNumber is the higher-priority field and matches only as a substring
    // (0.7); name matches exactly (0.9). Reporting 0.7 would be the tool
    // publishing a confidence it does not hold.
    const ctx = ctxWith({
      case: {
        findMany: fixedFindMany([
          {
            id: 'case-aaa',
            name: 'Receivership',
            caseNumber: 'CAUSE NO. 00-0000-XX Receivership Docket',
            jurisdiction: null,
          },
        ]),
      },
    });

    const res = await tool.execute({ text: 'Receivership', kinds: ['case'] }, ctx, CONFIG);

    expect(res.data!.candidates[0]).toMatchObject({ matchedOn: 'name', confidence: 0.9 });
  });

  it('keeps the higher-priority field when two fields score equal', async () => {
    // Both barNumber and displayName match exactly at 0.95 vs 0.9 — but make
    // them tie at prefix 0.7 to exercise the tie-break itself.
    const ctx = ctxWith({
      person: {
        findMany: fixedFindMany([
          { id: 'person-1', displayName: 'Marek Ostberg', barNumber: 'Marek Ostberg-0000' },
        ]),
      },
    });

    const res = await tool.execute({ text: 'Marek Ost', kinds: ['person'] }, ctx, CONFIG);

    expect(res.data!.candidates[0]).toMatchObject({ matchedOn: 'barNumber', confidence: 0.7 });
  });

  it('reports two near-equal candidates instead of collapsing to one', async () => {
    const ctx = ctxWith({
      motion: {
        findMany: fixedFindMany([
          { id: 'motion-1', title: 'Motion to Compel Production', caseId: 'case-aaa' },
          { id: 'motion-2', title: 'Amended Motion to Compel Production', caseId: 'case-aaa' },
        ]),
      },
    });

    const res = await tool.execute({ text: 'motion to compel', kinds: ['motion'] }, ctx, CONFIG);

    // BOTH survive — the caller (or the user) chooses.
    expect(res.data!.candidates.map((c) => c.id).sort()).toEqual(['motion-1', 'motion-2']);
    // 0.7 (prefix) vs 0.6 (substring): gap 0.1 ≤ 0.15.
    expect(res.data!.candidates[0].confidence - res.data!.candidates[1].confidence)
      .toBeLessThanOrEqual(AMBIGUITY_GAP);
    expect(res.data!.ambiguous).toBe(true);
  });

  it('flags identical confidences as ambiguous (gap 0, not "no gap")', async () => {
    const ctx = ctxWith({
      person: {
        findMany: fixedFindMany([
          { id: 'person-2', displayName: 'Marek Ostrowski', barNumber: null },
          { id: 'person-1', displayName: 'Marek Ostberg', barNumber: null },
        ]),
      },
    });

    const res = await tool.execute({ text: 'Marek Ost', kinds: ['person'] }, ctx, CONFIG);

    expect(res.data!.candidates.map((c) => c.confidence)).toEqual([0.7, 0.7]);
    // Tie-break is id ascending, so the output is stable across runs.
    expect(res.data!.candidates.map((c) => c.id)).toEqual(['person-1', 'person-2']);
    expect(res.data!.ambiguous).toBe(true);
  });

  it('ranks across kinds in one list — a case and a motion can be ambiguous together', async () => {
    const ctx = ctxWith({
      case: {
        findMany: fixedFindMany([
          { id: 'case-aaa', name: 'Receivership', caseNumber: null, jurisdiction: null },
        ]),
      },
      motion: {
        findMany: fixedFindMany([{ id: 'motion-1', title: 'Receivership Order', caseId: 'case-aaa' }]),
      },
    });

    const res = await tool.execute({ text: 'receivership' }, ctx, CONFIG);

    // case exact-name 0.9 vs motion prefix 0.7 → gap 0.2 > 0.15.
    expect(res.data!.candidates.map((c) => c.kind)).toEqual(['case', 'motion']);
    expect(res.data!.ambiguous).toBe(false);
  });

  it('computes ambiguity before the limit slice so limit:1 still reports it', async () => {
    const ctx = ctxWith({
      motion: {
        findMany: fixedFindMany([
          { id: 'motion-1', title: 'Motion to Compel Production', caseId: 'case-aaa' },
          { id: 'motion-2', title: 'Amended Motion to Compel Production', caseId: 'case-aaa' },
        ]),
      },
    });

    const res = await tool.execute({ text: 'motion to compel', kinds: ['motion'], limit: 1 }, ctx, CONFIG);

    expect(res.data!.candidates).toHaveLength(1);
    expect(res.data!.ambiguous).toBe(true);
  });

  it('returns an empty candidate list rather than an error when nothing matches', async () => {
    const res = await tool.execute({ text: 'nothing matches this' }, ctxWith({}), CONFIG);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ candidates: [], ambiguous: false });
  });

  it('queries only the requested kinds', async () => {
    const person = empty();
    const doc = empty();
    const ctx = ctxWith({ person, document: doc });

    await tool.execute({ text: 'anything', kinds: ['person'] }, ctx, CONFIG);

    expect(person.findMany).toHaveBeenCalledTimes(1);
    expect(doc.findMany).not.toHaveBeenCalled();
  });
});
