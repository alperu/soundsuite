/**
 * @jest-environment node
 *
 * list_cases / list_motions / list_people — the enumerations that hand out the
 * ids every scoped tool requires (docs/tasks/10-mcp-discovery-tools.md).
 *
 * These three take NO required params: being callable bare with `{}` is the
 * whole point, so the contract test asserts that rather than a refusal.
 * Synthetic fixtures only.
 */

import { ListCasesTool } from '../list-cases';
import { ListMotionsTool } from '../list-motions';
import { ListPeopleTool } from '../list-people';
import { CONFIG, CASE_A, CASE_B, makeContext, fixedFindMany } from './discovery-harness';

describe('list_cases', () => {
  const tool = new ListCasesTool();

  it('declares a local-safe metadata contract', () => {
    const m = tool.getMetadata();
    expect(m.name).toBe('list_cases');
    expect(m.profiles).toEqual(['local', 'routed']);
    expect(m.inputSchema.required).toEqual([]);
    expect(Object.keys(m.inputSchema.properties).sort()).toEqual(['limit', 'query']);
  });

  it('is callable with no params at all and returns caseIds', async () => {
    const findMany = fixedFindMany([CASE_A, CASE_B]);
    const ctx = makeContext({ case: { findMany } });

    const res = await tool.execute({}, ctx, CONFIG);

    expect(res.success).toBe(true);
    expect(res.data!.cases.map((c) => c.caseId)).toEqual(['case-aaa', 'case-bbb']);
    expect(res.data!.cases[0]).toMatchObject({
      caseNumber: 'CAUSE NO. 00-0000-XX',
      totalDocuments: 2,
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    // Absent, not '' — a blank string reads as "there is a county named ''".
    expect(res.data!.cases[1]).not.toHaveProperty('county');
  });

  it('takes the exact caseNumber fast path before falling back to contains', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([CASE_A]) // exact
      .mockResolvedValueOnce([]); // substring pass, must not run
    const ctx = makeContext({ case: { findMany } });

    const res = await tool.execute({ query: '  CAUSE NO. 00-0000-XX  ' }, ctx, CONFIG);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ caseNumber: 'CAUSE NO. 00-0000-XX' });
    expect(res.data!.cases[0].caseId).toBe('case-aaa');
  });

  it('falls back to a lowercased substring search over three fields', async () => {
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([CASE_B]);
    const ctx = makeContext({ case: { findMany } });

    const res = await tool.execute({ query: 'Interlocutory' }, ctx, CONFIG);

    expect(findMany).toHaveBeenCalledTimes(2);
    // SQLite has no `mode: 'insensitive'` — the query must be lowercased.
    expect(findMany.mock.calls[1][0].where.OR).toEqual([
      { name: { contains: 'interlocutory' } },
      { caseNumber: { contains: 'interlocutory' } },
      { jurisdiction: { contains: 'interlocutory' } },
    ]);
    expect(res.data!.cases[0].caseId).toBe('case-bbb');
  });
});

describe('list_motions', () => {
  const tool = new ListMotionsTool();

  const MOTION = {
    id: 'motion-1',
    title: 'Motion to Compel',
    caseId: 'case-aaa',
    startPage: 1,
    endPage: 9,
    filingId: 'filing-1',
    parentMotionId: null,
    amendsId: null,
    supersedesId: null,
    revisionSeq: null,
    case: { caseNumber: 'CAUSE NO. 00-0000-XX' },
    filing: { documents: [{ id: 'doc-1' }] },
  };

  it('declares a local-safe metadata contract', () => {
    const m = tool.getMetadata();
    expect(m.name).toBe('list_motions');
    expect(m.profiles).toEqual(['local', 'routed']);
    expect(m.inputSchema.required).toEqual([]);
    expect(Object.keys(m.inputSchema.properties).sort()).toEqual([
      'caseId',
      'hasAmendments',
      'limit',
      'query',
    ]);
  });

  it('returns motionIds usable as a query_case_graph seed', async () => {
    const findMany = fixedFindMany([MOTION]);
    const ctx = makeContext({ motion: { findMany } });

    const res = await tool.execute({ caseId: 'case-aaa' }, ctx, CONFIG);

    expect(res.success).toBe(true);
    expect(res.data!.motions[0]).toMatchObject({
      motionId: 'motion-1',
      title: 'Motion to Compel',
      caseId: 'case-aaa',
      caseNumber: 'CAUSE NO. 00-0000-XX',
      startPage: 1,
      endPage: 9,
      filingId: 'filing-1',
      documentId: 'doc-1',
    });
    // Null pointers are omitted, not emitted as null.
    expect(res.data!.motions[0]).not.toHaveProperty('amendsId');
    expect(findMany.mock.calls[0][0].where).toMatchObject({ caseId: 'case-aaa' });
  });

  it('omits documentId when the filing maps to more than one document', async () => {
    const findMany = fixedFindMany([
      { ...MOTION, filing: { documents: [{ id: 'doc-1' }, { id: 'doc-2' }] } },
    ]);
    const res = await tool.execute({}, makeContext({ motion: { findMany } }), CONFIG);
    // Picking the first would be a silent wrong id — the class this task removes.
    expect(res.data!.motions[0]).not.toHaveProperty('documentId');
  });

  it('expresses hasAmendments as one relation filter, not a post-filter', async () => {
    const findMany = fixedFindMany([]);
    const ctx = makeContext({ motion: { findMany } });

    await tool.execute({ hasAmendments: true }, ctx, CONFIG);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { childMotions: { some: {} } },
      { amendsId: { not: null } },
      { supersedesId: { not: null } },
    ]);
  });
});

describe('list_people', () => {
  const tool = new ListPeopleTool();

  const PERSON = {
    id: 'person-1',
    displayName: 'Avery Lindqvist',
    barNumber: '00000000',
    jurisdiction: { name: 'Example Jurisdiction' },
    motionsAsJudge: [],
    motionsAsMovant: [{ id: 'motion-1', caseId: 'case-aaa', case: { caseNumber: 'CAUSE NO. 00-0000-XX' } }],
    motionsAsRespondent: [],
    roles: [{ scopeKind: 'motion', scopeId: 'motion-1', tags: { personRole: true, movant: true } }],
  };

  it('declares a local-safe metadata contract', () => {
    const m = tool.getMetadata();
    expect(m.name).toBe('list_people');
    expect(m.profiles).toEqual(['local', 'routed']);
    expect(m.category).toBe('entity');
    expect(m.inputSchema.required).toEqual([]);
    expect(m.inputSchema.properties.role.enum).toEqual(['judge', 'movant', 'respondent', 'any']);
  });

  it('counts distinct motions rather than summing role appearances', async () => {
    const ctx = makeContext({
      person: { findMany: fixedFindMany([PERSON]) },
      motion: {
        findMany: fixedFindMany([
          { id: 'motion-1', caseId: 'case-aaa', case: { caseNumber: 'CAUSE NO. 00-0000-XX' } },
        ]),
      },
    });

    const res = await tool.execute({}, ctx, CONFIG);

    expect(res.success).toBe(true);
    const p = res.data!.people[0];
    expect(p.personId).toBe('person-1');
    // Movant relation AND a PersonRole, both on motion-1 → one motion, not two.
    expect(p.motionCount).toBe(1);
    expect(p.roles).toEqual([
      { role: 'movant', caseId: 'case-aaa', caseNumber: 'CAUSE NO. 00-0000-XX' },
    ]);
  });

  it('scopes a role filter to the matching motion relation', async () => {
    const findMany = fixedFindMany([]);
    const ctx = makeContext({ person: { findMany }, motion: { findMany: fixedFindMany([]) } });

    await tool.execute({ role: 'judge', query: 'Lind' }, ctx, CONFIG);

    const and = findMany.mock.calls[0][0].where.AND;
    expect(and).toContainEqual({
      OR: [{ displayName: { contains: 'lind' } }, { barNumber: { contains: 'lind' } }],
    });
    expect(and).toContainEqual({ motionsAsJudge: { some: {} } });
  });
});
