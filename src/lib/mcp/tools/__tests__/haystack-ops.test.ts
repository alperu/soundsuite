/** @jest-environment node */

/**
 * The bridge: one tool per catalogued op, read ops in both profiles, write
 * and LLM ops routed-only, and a write with dryRun=false refused unless the
 * server enables it.
 */
jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('../../shared-dependencies', () => ({
  ollamaReadiness: jest.fn().mockResolvedValue({ reachable: true, generates: true, model: 'm' }),
  ollamaAvailable: jest.fn(),
  resetOllamaProbeCache: jest.fn(),
}));
jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));

import { getHaystackOpTools } from '../haystack-ops';
import { VENDOR_OPS, WRITE_GATE_ENV } from '@/lib/haystack/ops';
import { ToolRegistry } from '../../tool-registry';
import { ToolExecutionLogger } from '../../tool-execution-logger';
import type { ToolExecutionContext } from '../../tool-types';

async function registry() {
  const configStore = {
    getAllToolConfigs: jest.fn().mockResolvedValue(new Map()),
    getToolConfig: jest.fn().mockResolvedValue(null),
    setToolConfig: jest.fn().mockResolvedValue(undefined),
  } as any;
  const context: ToolExecutionContext = {
    vectorStore: {} as any,
    embeddingProvider: {} as any,
    database: {} as any,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
  };
  const r = new ToolRegistry(configStore, new ToolExecutionLogger(), context);
  await r.registerAll(getHaystackOpTools());
  return r;
}

describe('haystack op tools', () => {
  const saved = process.env[WRITE_GATE_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[WRITE_GATE_ENV];
    else process.env[WRITE_GATE_ENV] = saved;
  });

  it('generates exactly one tool per catalogued op, named as the op', () => {
    const names = getHaystackOpTools().map((t) => t.getMetadata().name).sort();
    expect(names).toEqual(VENDOR_OPS.map((o) => o.name).sort());
  });

  it('exposes read ops to both profiles and write/llm ops to routed only', async () => {
    const r = await registry();
    const local = new Set(r.listTools('local').map((t) => t.metadata.name));
    const routed = new Set(r.listTools('routed').map((t) => t.metadata.name));
    for (const op of VENDOR_OPS) {
      expect(routed.has(op.name)).toBe(true);
      expect(local.has(op.name)).toBe(op.exposure === 'read');
    }
  });

  it('advertises the spec params as the input schema', () => {
    const tool = getHaystackOpTools().find((t) => t.getMetadata().name === 'ssReadCase')!;
    const schema = tool.getMetadata().inputSchema;
    expect(schema.required).toEqual(['caseId']);
    expect(Object.keys(schema.properties).sort()).toEqual(['caseId', 'limit', 'offset', 'status']);
  });

  it('refuses a routed write with dryRun=false as POLICY_VIOLATION when the gate is closed', async () => {
    delete process.env[WRITE_GATE_ENV];
    const r = await registry();
    const res = await r.execute('ssPromoteDiscovered', { limit: 3, dryRun: false }, undefined, 'routed');
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('POLICY_VIOLATION');
    expect(res.error).toMatch(/SS_HAYSTACK_WRITE/);
  });

  it('rejects unknown parameters before touching the database', async () => {
    const r = await registry();
    const res = await r.execute('ssWorklist', { case_id: 'x' }, undefined, 'local');
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toMatch(/caseId/);
  });

  it('refuses write ops under local with TOOL_NOT_IN_PROFILE', async () => {
    const r = await registry();
    const res = await r.execute('ssCaseEnsure', { path: '/tmp' }, undefined, 'local');
    expect(res.errorCode).toBe('TOOL_NOT_IN_PROFILE');
  });
});
