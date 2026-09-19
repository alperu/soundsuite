/** @jest-environment node */

/**
 * The profile stamp and the `expectProfile` guard at the registry choke
 * point (docs/tasks/54-profiles.md). Synthetic tools only.
 */
jest.mock('../shared-dependencies', () => ({
  ollamaReadiness: jest.fn().mockResolvedValue({ reachable: true, generates: true, model: 'm' }),
  ollamaAvailable: jest.fn(),
  resetOllamaProbeCache: jest.fn(),
}));
jest.mock('../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/profiles/registry', () => ({ activeProfileName: jest.fn(() => 'alpha') }));

import { ToolRegistry } from '../tool-registry';
import { ToolExecutionLogger } from '../tool-execution-logger';
import { BaseMCPTool } from '../tools/base-tool';
import type { ToolMetadata, ToolExecutionContext } from '../tool-types';

class EchoTool extends BaseMCPTool {
  public seen: unknown = null;
  getMetadata(): ToolMetadata {
    return {
      name: 'echo_thing',
      displayName: 'echo',
      description: 'synthetic',
      version: '0.0.0',
      category: 'search',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
    };
  }
  protected rejectsUnknownParams(): boolean {
    return true;
  }
  async executeImpl(params: unknown) {
    this.seen = params;
    return { ok: true };
  }
}

async function build(tool: BaseMCPTool) {
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
  await r.registerAll([tool]);
  return r;
}

describe('profile stamp and guard', () => {
  it('stamps the active data profile on every result, success or failure', async () => {
    const r = await build(new EchoTool());
    const ok = await r.execute('echo_thing', { q: 'x' }, undefined, 'local');
    expect(ok.success).toBe(true);
    expect(ok.profile).toBe('alpha');
    const missing = await r.execute('nope', {}, undefined, 'local');
    expect(missing.errorCode).toBe('TOOL_NOT_FOUND');
    expect(missing.profile).toBe('alpha');
  });

  it('accepts expectProfile when it names the active profile and strips it before the tool sees params', async () => {
    const tool = new EchoTool();
    const r = await build(tool);
    const res = await r.execute('echo_thing', { q: 'x', expectProfile: 'alpha' }, undefined, 'local');
    expect(res.success).toBe(true);
    // The tool rejects unknown params, so reaching executeImpl proves the guard consumed it.
    expect(tool.seen).toEqual({ q: 'x' });
  });

  it('refuses with PROFILE_MISMATCH when expectProfile names another profile', async () => {
    const tool = new EchoTool();
    const r = await build(tool);
    const res = await r.execute('echo_thing', { expectProfile: 'demo' }, undefined, 'local');
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('PROFILE_MISMATCH');
    expect(res.error).toMatch(/"demo" does not match the active profile "alpha"/);
    expect(res.profile).toBe('alpha');
    expect(tool.seen).toBeNull();
  });

  it('treats an explicit null expectProfile as absent', async () => {
    const r = await build(new EchoTool());
    const res = await r.execute('echo_thing', { expectProfile: null }, undefined, 'local');
    expect(res.success).toBe(true);
  });
});
