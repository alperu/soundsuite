/** @jest-environment node */

/**
 * Profile visibility + LLM policy at the registry choke point
 * (docs/tasks/06-mcp-two-profiles.md, work item 1). Synthetic tools only.
 */

jest.mock('../shared-dependencies', () => ({
  ollamaAvailable: jest.fn(),
  resetOllamaProbeCache: jest.fn(),
}));

jest.mock('../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ ollamaCompletionModel: 'test-local-model' }),
}));

import { ToolRegistry } from '../tool-registry';
import { ToolExecutionLogger } from '../tool-execution-logger';
import { BaseMCPTool } from '../tools/base-tool';
import { ollamaAvailable } from '../shared-dependencies';
import type { ToolMetadata, ToolExecutionContext } from '../tool-types';

const mockOllama = ollamaAvailable as jest.MockedFunction<typeof ollamaAvailable>;

class FakeTool extends BaseMCPTool {
  public lastContext: ToolExecutionContext | null = null;
  constructor(private meta: ToolMetadata) { super(); }
  getMetadata() { return this.meta; }
  async executeImpl(params: any, context: ToolExecutionContext) {
    this.lastContext = context;
    return { ok: true, params };
  }
}

function meta(name: string, extra: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name,
    displayName: name,
    description: `synthetic ${name}`,
    version: '0.0.0',
    category: 'search',
    inputSchema: { type: 'object', properties: {}, required: [] },
    ...extra,
  };
}

async function build(tools: BaseMCPTool[]) {
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
  const registry = new ToolRegistry(configStore, new ToolExecutionLogger(), context);
  await registry.registerAll(tools);
  return registry;
}

describe('ToolRegistry profiles', () => {
  let both: FakeTool;
  let routedOnly: FakeTool;
  let localOnly: FakeTool;
  let llmTool: FakeTool;
  let registry: ToolRegistry;

  beforeEach(async () => {
    mockOllama.mockReset();
    mockOllama.mockResolvedValue(true);
    both = new FakeTool(meta('search_both'));
    routedOnly = new FakeTool(meta('report_thing', { profiles: ['routed'] }));
    localOnly = new FakeTool(meta('evidence_thing', { profiles: ['local'] }));
    llmTool = new FakeTool(meta('analyze_thing', { category: 'review' }));
    registry = await build([both, routedOnly, localOnly, llmTool]);
  });

  describe('listTools', () => {
    it('lists everything when no profile is given (dashboard)', () => {
      const names = registry.listTools().map((t) => t.metadata.name).sort();
      expect(names).toEqual(['analyze_thing', 'evidence_thing', 'report_thing', 'search_both']);
    });

    it('hides routed-only tools from local and local-only tools from routed', () => {
      const local = registry.listTools('local').map((t) => t.metadata.name);
      const routed = registry.listTools('routed').map((t) => t.metadata.name);
      expect(local).toContain('search_both');
      expect(local).toContain('evidence_thing');
      expect(local).not.toContain('report_thing');
      expect(routed).toContain('search_both');
      expect(routed).toContain('report_thing');
      expect(routed).not.toContain('evidence_thing');
    });

    it('marks LLM tools not ready under local when Ollama is down, search tools unaffected', async () => {
      mockOllama.mockResolvedValue(false);
      await registry.refreshDependencies();

      const local = new Map(registry.listTools('local').map((t) => [t.metadata.name, t]));
      expect(local.get('analyze_thing')!.ready).toBe(false);
      expect(local.get('analyze_thing')!.readyReasons).toEqual([
        'Ollama unavailable — local profile pins LLM tools to Ollama',
      ]);
      expect(local.get('search_both')!.ready).toBe(true);

      // routed and the unfiltered dashboard view do not gate on Ollama
      const routed = new Map(registry.listTools('routed').map((t) => [t.metadata.name, t]));
      expect(routed.get('analyze_thing')!.ready).toBe(true);
      const all = new Map(registry.listTools().map((t) => [t.metadata.name, t]));
      expect(all.get('analyze_thing')!.ready).toBe(true);
    });
  });

  describe('execute', () => {
    it('refuses a routed-only tool under local with TOOL_NOT_IN_PROFILE', async () => {
      const res = await registry.execute('report_thing', {}, undefined, 'local');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TOOL_NOT_IN_PROFILE');
    });

    it('refuses a local-only tool under routed with TOOL_NOT_IN_PROFILE', async () => {
      const res = await registry.execute('evidence_thing', {}, undefined, 'routed');
      expect(res.errorCode).toBe('TOOL_NOT_IN_PROFILE');
    });

    it('defaults to local when no profile is passed (fail-closed)', async () => {
      const res = await registry.execute('report_thing', {});
      expect(res.errorCode).toBe('TOOL_NOT_IN_PROFILE');
    });

    it('returns POLICY_VIOLATION for a local execute with a cloud provider override', async () => {
      const res = await registry.execute('search_both', {}, { aiProvider: 'anthropic', aiModel: 'claude-x' }, 'local');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('POLICY_VIOLATION');
      expect(res.error).toContain('anthropic');
      expect(both.lastContext).toBeNull();
    });

    it('pins local calls to ollama and the configured completion model when no override is given', async () => {
      const res = await registry.execute('analyze_thing', {}, undefined, 'local');
      expect(res.success).toBe(true);
      expect(llmTool.lastContext?.profile).toBe('local');
      expect(llmTool.lastContext?.aiProvider).toBe('ollama');
      expect(llmTool.lastContext?.aiModel).toBe('test-local-model');
    });

    it('returns TOOL_NOT_READY for a local LLM tool when Ollama is down', async () => {
      mockOllama.mockResolvedValue(false);
      const res = await registry.execute('analyze_thing', {}, undefined, 'local');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TOOL_NOT_READY');
      expect(res.error).toMatch(/Ollama unavailable/);
    });

    it('lets routed pass a cloud provider through and stamps the profile', async () => {
      const res = await registry.execute('analyze_thing', {}, { aiProvider: 'anthropic', aiModel: 'claude-x' }, 'routed');
      expect(res.success).toBe(true);
      expect(llmTool.lastContext?.profile).toBe('routed');
      expect(llmTool.lastContext?.aiProvider).toBe('anthropic');
      expect(llmTool.lastContext?.aiModel).toBe('claude-x');
    });

    it('forwards sessionId from the overlay', async () => {
      await registry.execute('search_both', {}, { sessionId: 'sess-1' }, 'routed');
      expect(both.lastContext?.sessionId).toBe('sess-1');
    });
  });
});
