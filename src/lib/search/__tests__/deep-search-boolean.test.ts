// Verify boolean-syntax bypass skips the LLM decomposition path entirely.

// jsdom in this repo doesn't auto-polyfill TextEncoder; some transitive
// imports (Prisma → noble-hashes) need it at module load.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (global as any).TextEncoder === 'undefined') (global as any).TextEncoder = NodeTextEncoder;
if (typeof (global as any).TextDecoder === 'undefined') (global as any).TextDecoder = NodeTextDecoder;

const callLLMJsonMock = jest.fn();
const callLLMMock = jest.fn();

jest.mock('../../mcp/tools/ai-helper', () => ({
  callLLM: (...args: any[]) => callLLMMock(...args),
  callLLMJson: (...args: any[]) => callLLMJsonMock(...args),
  buildContext: jest.fn(),
  getAvailableProvider: jest.fn(),
}));

jest.mock('../../ai/ai-provider', () => ({ streamAI: jest.fn() }));
jest.mock('../reranker', () => ({
  rerank: jest.fn(),
  RerankableResult: class {},
}));

import { decomposeQuery } from '../deep-search';

describe('decomposeQuery — boolean bypass', () => {
  beforeEach(() => {
    callLLMJsonMock.mockReset();
    callLLMMock.mockReset();
  });

  test('plain natural-language query calls LLM', async () => {
    callLLMJsonMock.mockResolvedValueOnce({
      subQueries: ['x', 'y'],
      intent: 'i',
    });
    const r = await decomposeQuery('what did the witness say about hiring a realtor');
    expect(callLLMJsonMock).toHaveBeenCalledTimes(1);
    expect(r.subQueries.length).toBeGreaterThan(0);
  });

  test('boolean query with operators skips LLM, splits at or', async () => {
    const r = await decomposeQuery('(motion and compel) or appeal');
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(r.subQueries.length).toBe(2);
    // Each branch should be parseable as boolean
    expect(r.intent).toBe('(motion and compel) or appeal');
  });

  test('boolean query without or yields a single branch, still skips LLM', async () => {
    const r = await decomposeQuery('motion and compel');
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(r.subQueries.length).toBe(1);
  });

  test('phrase-only query skips LLM (operators detected)', async () => {
    const r = await decomposeQuery('"motion to compel"');
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(r.subQueries).toEqual(['"motion to compel"']);
  });
});
