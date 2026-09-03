/** @jest-environment node */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../db/prisma', () => ({
  prisma: {
    actionLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    searchPreset: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('../ai-helper', () => ({
  DEFAULT_MODELS: { ollama: 'qwen2.5:14b', groq: 'g', openai: 'gpt-5.6-terra', anthropic: 'claude-sonnet-5', gemini: 'gm', grok: 'grok-4.5' },
  getAvailableProvider: jest.fn(),
}));
jest.mock('../../routing-defaults', () => ({
  getDefaultRouting: jest.fn().mockResolvedValue({
    fast: { provider: 'ollama', model: 'qwen2.5:14b' },
    deep: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true },
    'deep-report': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, multiPass: true },
    'deep-rlm': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, useRlm: true, rlmMaxRounds: 4 },
  }),
}));
jest.mock('../../../search/deep-search', () => ({ deepSearch: jest.fn() }));
jest.mock('../../get-tool-registry', () => ({ getToolRegistry: jest.fn().mockResolvedValue({}) }));

import { deepSearch, type DeepSearchOptions, type DeepSearchResult } from '../../../search/deep-search';
import { _resetJobsForTests } from '../../research-jobs';
import { _resetForTests } from '../../presets/preset-session';
import { getRoutedReportTools, type PromotedReport } from '../routed-report-tools';
import { getPresetTools } from '../preset-tools';
import type { ToolExecutionContext, ToolConfigEntry } from '../../tool-types';
import type { ReportResult, ResearchJobStatusView } from '../../research-types';

const mockedDeepSearch = deepSearch as jest.MockedFunction<typeof deepSearch>;
const flush = () => new Promise<void>((r) => setImmediate(r));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const context = { logger, sessionId: 'sess-t', profile: 'routed' } as unknown as ToolExecutionContext;
const config: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

const tools = Object.fromEntries(getRoutedReportTools().map((t) => [t.getMetadata().name, t]));

function fakeResult(): DeepSearchResult {
  return {
    report: 'final synthetic report',
    sources: [{ documentId: 'doc-1', document: 'motion.pdf', page: 1, text: 'synthetic passage', score: 0.8, matchedSubQueries: ['q'] } as never],
    subQueries: ['q'],
    intent: 'x',
    searchStats: { totalRetrieved: 5, uniqueAfterDedup: 4, finalAfterRerank: 1, subQueryCount: 1 },
    model: 'claude-sonnet-5',
    provider: 'anthropic',
  };
}

beforeEach(() => {
  mockedDeepSearch.mockReset();
  _resetJobsForTests();
  _resetForTests();
});

describe('tool metadata', () => {
  it('every routed tool is routed-only and in the search category', () => {
    for (const t of [...getRoutedReportTools(), ...getPresetTools()]) {
      const m = t.getMetadata();
      expect(m.profiles).toEqual(['routed']);
      expect(m.category).toBe('search');
    }
    expect(Object.keys(tools).sort()).toEqual(['report_cancel', 'report_result', 'report_start', 'report_status', 'research_report']);
    expect(getPresetTools().map((t) => t.getMetadata().name).sort()).toEqual([
      'preset_apply', 'preset_define', 'preset_delete', 'preset_get', 'preset_list', 'preset_save', 'routing_explain',
    ]);
  });
});

describe('research_report', () => {
  it('runs synchronously when the estimate is under 45 s', async () => {
    mockedDeepSearch.mockResolvedValue(fakeResult());
    const res = await tools.research_report.execute({ query: 'synthetic question', mode: 'fast' }, context, config);
    expect(res.success).toBe(true);
    const data = res.data as ReportResult;
    expect(data.profile).toBe('routed');
    expect(data.report).toBe('final synthetic report');
    expect(data.routing.mode).toBe('fast');
  });

  it('self-promotes to a job when the estimate exceeds 45 s', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockedDeepSearch.mockImplementation(async () => { await gate; return fakeResult(); });

    const res = await tools.research_report.execute({ query: 'synthetic question', mode: 'deep-report' }, context, config);
    expect(res.success).toBe(true);
    const data = res.data as PromotedReport;
    expect(data.promoted).toBe(true);
    expect(data.kind).toBe('report');
    expect(data.estimatedSeconds).toBe(90);
    expect(data.hint).toMatch(/report_status/);
    expect(typeof data.jobId).toBe('string');

    await flush();
    const status = await tools.report_status.execute({ jobId: data.jobId }, context, config);
    expect(status.success).toBe(true);
    expect((status.data as ResearchJobStatusView).status).toBe('running');
    // the job stamped the planned provider/model as an early cost row
    expect((status.data as ResearchJobStatusView).cost).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });

    release();
    await flush(); await flush();
    const done = await tools.report_result.execute({ jobId: data.jobId }, context, config);
    expect(done.data).toMatchObject({ ready: true, report: 'final synthetic report' });
  });

  it('rejects an empty query', async () => {
    const res = await tools.research_report.execute({ query: '' }, context, config);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
  });
});

describe('report_start / report_status / report_result / report_cancel', () => {
  it('report_status carries a growing partialReport between polls', async () => {
    let emit!: (t: string) => void;
    let finish!: () => void;
    const gotOpts = new Promise<void>((resolveOpts) => {
      mockedDeepSearch.mockImplementation(async (_q, _r, opts: DeepSearchOptions = {}) => {
        emit = (t) => opts.onToken?.(t);
        resolveOpts();
        await new Promise<void>((r) => { finish = r; });
        return fakeResult();
      });
    });

    const started = await tools.report_start.execute({ query: 'synthetic question', mode: 'deep' }, context, config);
    expect(started.success).toBe(true);
    const job = started.data as ResearchJobStatusView;
    expect(job.kind).toBe('report');
    expect(job.profile).toBe('routed');
    expect(job.partialReport).toBe('');

    await gotOpts;
    emit('## Sum');
    let s = (await tools.report_status.execute({ jobId: job.id }, context, config)).data as ResearchJobStatusView;
    expect(s.status).toBe('running');
    expect(s.partialReport).toBe('## Sum');

    emit('mary\n\nfirst finding');
    s = (await tools.report_status.execute({ jobId: job.id, cursor: s.cursor }, context, config)).data as ResearchJobStatusView;
    expect(s.partialReport).toBe('## Summary\n\nfirst finding');

    const notReady = (await tools.report_result.execute({ jobId: job.id }, context, config)).data;
    expect(notReady).toMatchObject({ ready: false, status: 'running', partialReport: '## Summary\n\nfirst finding' });

    finish();
    await flush(); await flush();
    s = (await tools.report_status.execute({ jobId: job.id, cursor: s.cursor }, context, config)).data as ResearchJobStatusView;
    expect(s.status).toBe('done');
    expect(s.newEvidenceCount).toBe(1);
    expect(s.cost).toMatchObject({ provider: 'anthropic', estimated: true });

    const result = (await tools.report_result.execute({ jobId: job.id }, context, config)).data as { ready: true } & ReportResult;
    expect(result.ready).toBe(true);
    expect(result.provenance.documentIdsSent).toEqual(['doc-1']);
  });

  it('report_cancel aborts a running job', async () => {
    mockedDeepSearch.mockImplementation(async (_q, _r, opts: DeepSearchOptions = {}) =>
      new Promise((_res, rej) => {
        opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
    const job = (await tools.report_start.execute({ query: 'synthetic question', mode: 'deep' }, context, config)).data as ResearchJobStatusView;
    await flush();
    const cancelled = await tools.report_cancel.execute({ jobId: job.id }, context, config);
    expect(cancelled.data).toMatchObject({ cancelled: true, status: 'cancelled' });
    await flush();
    const notReady = (await tools.report_result.execute({ jobId: job.id }, context, config)).data;
    expect(notReady).toMatchObject({ ready: false, status: 'cancelled' });
  });

  it('unknown job ids are NOT_FOUND', async () => {
    const res = await tools.report_status.execute({ jobId: 'nope' }, context, config);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('NOT_FOUND');
  });
});
