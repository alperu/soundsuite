/** @jest-environment node */

/**
 * The op catalogue is the single description every surface derives from, so
 * its integrity is a test, not a convention. Plus the adapter's coercion and
 * the write gate — the two things that decide whether an agent can write.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import {
  VENDOR_OPS,
  VENDOR_OP_NAMES,
  STANDARD_OP_PARAMS,
  coerceParams,
  paramsToJsonSchema,
  runVendorOp,
  vendorOpSpec,
  writesEnabled,
  WRITE_GATE_ENV,
  OpError,
} from '../index';

const actor = { actor: 'agent' as const, via: 'test' };

describe('vendor op catalogue', () => {
  it('names every op with the ss prefix and a unique name', () => {
    const names = VENDOR_OPS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^ss[A-Z]/);
  });

  it('gives every write op a dryRun that defaults to true', () => {
    for (const op of VENDOR_OPS.filter((o) => o.exposure === 'write')) {
      expect(op.params.dryRun).toBeDefined();
      expect(op.params.dryRun.type).toBe('boolean');
      expect(op.params.dryRun.default).toBe(true);
    }
  });

  it('documents every standard op the route serves', () => {
    for (const std of ['about', 'ops', 'libs', 'defs', 'filetypes', 'nav', 'read', 'close', 'commit']) {
      expect(STANDARD_OP_PARAMS[std]).toBeDefined();
    }
  });

  it('never lists a delete or a raw commit', () => {
    for (const n of VENDOR_OP_NAMES) expect(n.toLowerCase()).not.toMatch(/delete|remove|clear|commit/);
  });

  it('turns params into a JSON schema with required[] derived from the spec', () => {
    const schema = paramsToJsonSchema(vendorOpSpec('ssFolderSurvey')!.params);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['caseId']);
    expect((schema.properties.disposition as { enum: string[] }).enum).toContain('orphaned');
  });
});

describe('coerceParams', () => {
  const spec = vendorOpSpec('ssReadCase')!;

  it('coerces query-string values to the declared types', () => {
    expect(coerceParams(spec, { caseId: '@abc', limit: '50', offset: '0' })).toEqual({ caseId: '@abc', limit: 50, offset: 0 });
  });

  it('rejects an unknown key rather than dropping it', () => {
    expect(() => coerceParams(spec, { caseId: 'x', case_id: 'y' })).toThrow(/unknown parameter: case_id/);
  });

  it('rejects a missing required param and a bad enum value', () => {
    expect(() => coerceParams(spec, {})).toThrow(/caseId is required/);
    expect(() => coerceParams(spec, { caseId: 'x', status: 'DONE' })).toThrow(/status must be one of/);
  });

  it('parses JSON strings for object params and refuses non-objects', () => {
    const apply = vendorOpSpec('ssAutoIngestApply')!;
    expect(coerceParams(apply, { plan: '{"version":1}' }).plan).toEqual({ version: 1 });
    expect(() => coerceParams(apply, { plan: '[1]' })).toThrow(/plan must be an object/);
    expect(() => coerceParams(apply, { dryRun: 'maybe', plan: {} })).toThrow(/dryRun must be a boolean/);
  });
});

describe('write gate', () => {
  const saved = process.env[WRITE_GATE_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[WRITE_GATE_ENV];
    else process.env[WRITE_GATE_ENV] = saved;
  });

  it('is off unless the env says 1 or true', () => {
    delete process.env[WRITE_GATE_ENV];
    expect(writesEnabled()).toBe(false);
    expect(writesEnabled({ [WRITE_GATE_ENV]: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(writesEnabled({ [WRITE_GATE_ENV]: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(writesEnabled({ [WRITE_GATE_ENV]: 'yes' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('refuses dryRun=false on a write op from an untrusted caller', async () => {
    delete process.env[WRITE_GATE_ENV];
    await expect(
      runVendorOp('ssPromoteDiscovered', { limit: 5, dryRun: false }, { actor, trusted: false, client: {} as any }),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
  });

  it('lets dryRun=true through the gate (it is the default and writes nothing)', async () => {
    delete process.env[WRITE_GATE_ENV];
    const client = {
      document: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const res = await runVendorOp('ssPromoteDiscovered', { limit: 5 }, { actor, trusted: false, client });
    expect(res.meta.action).toBe('plan');
    expect(res.meta.dryRun).toBe(true);
    expect(res.rows).toEqual([]);
  });

  it('rejects an unknown op', async () => {
    await expect(runVendorOp('ssNope', {}, { actor, client: {} as any })).rejects.toBeInstanceOf(OpError);
  });
});

describe('ssIngestStatus over a fake client', () => {
  it('names DISCOVERED separately from INDEXED and reports structured vs legacy', async () => {
    const client = {
      case: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Case One', caseNumber: null }]) },
      document: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { caseId: 'c1', status: 'DISCOVERED', _count: { _all: 7 } },
            { caseId: 'c1', status: 'INDEXED', _count: { _all: 3 } },
            { caseId: 'c1', status: 'ERROR', _count: { _all: 1 } },
          ])
          .mockResolvedValueOnce([{ caseId: 'c1', _count: { _all: 1 } }]),
      },
    } as any;
    const res = await runVendorOp('ssIngestStatus', {}, { actor, client });
    expect(res.meta).toMatchObject({ mode: 'corpus', cases: 1, discovered: 7, indexed: 3, errored: 1, structured: 1, legacyIndexed: 2 });
    expect(res.rows[0]).toMatchObject({ caseId: 'c1', total: 11 });
  });
});
