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

  test('chip-syntax boolean query skips LLM, splits at top-level or', async () => {
    // Product rule (commit 9b15196): boolean operators are honored ONLY inside
    // `{{ … }}` chip syntax. Chip queries bypass LLM decomposition and split
    // at top-level OR into parallel sub-queries.
    const q = '{{motion and compel}} or {{appeal}}';
    const r = await decomposeQuery(q);
    expect(callLLMJsonMock).not.toHaveBeenCalled();
    expect(r.subQueries).toEqual(['{{motion and compel}}', '{{appeal}}']);
    expect(r.intent).toBe(q);
  });

  test('plain boolean text with parens + or (no chips) goes through LLM', async () => {
    // Incidental parens/quotes in prose ("(via Mr. X)") used to trigger the
    // bypass and mangle the paragraph; without `{{ }}` chips the query must
    // fall through to LLM decomposition.
    callLLMJsonMock.mockResolvedValueOnce({ subQueries: ['x', 'y'], intent: 'i' });
    const r = await decomposeQuery('(motion and compel) or appeal');
    expect(callLLMJsonMock).toHaveBeenCalledTimes(1);
    // The LLM path prepends the original query to the decomposed sub-queries.
    expect(r.subQueries).toEqual(expect.arrayContaining(['x', 'y']));
  });

  test('natural-language "X and Y" — bare lowercase and is NOT structured, calls LLM', async () => {
    // Regression: a paragraph of English ("Now, she may have used... and I,
    // in no way, ignored my obligation...") was being treated as a boolean
    // query because of the bare lowercase "and" / "no" / "not" words. The
    // bypass now requires structured syntax (parens, quotes, field ops,
    // unary -term) before triggering.
    callLLMJsonMock.mockResolvedValueOnce({ subQueries: ['x'], intent: 'i' });
    await decomposeQuery('motion and compel');
    expect(callLLMJsonMock).toHaveBeenCalledTimes(1);
  });

  test('phrase-only query (no chips) goes through LLM — quotes alone are not structured', async () => {
    // Quoted phrases no longer count as boolean syntax on their own; only
    // `{{ }}` chips gate the bypass.
    callLLMJsonMock.mockResolvedValueOnce({ subQueries: ['"motion to compel"'], intent: 'i' });
    const r = await decomposeQuery('"motion to compel"');
    expect(callLLMJsonMock).toHaveBeenCalledTimes(1);
    expect(r.subQueries).toEqual(['"motion to compel"']);
  });

  test('long natural-language paragraph with stray "and"/"or"/"not" does NOT bypass', async () => {
    callLLMJsonMock.mockResolvedValueOnce({ subQueries: ['a', 'b'], intent: 'i' });
    const longPaste = "Now, she may have used to say similar to a trust, but I, in no way, ignored my obligation to correct that testimony that was previously given, and after it was corrected, I did confirm.";
    await decomposeQuery(longPaste);
    expect(callLLMJsonMock).toHaveBeenCalledTimes(1);
  });
});
