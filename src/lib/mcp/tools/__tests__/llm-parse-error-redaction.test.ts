/** @jest-environment node */
/**
 * v6 item 5 — the `LLM_PARSE_ERROR` log redaction, pinned.
 *
 * When the model answers with prose instead of JSON, `callLLMJson` throws an
 * `McpError` whose `message` embeds a 300-character snippet of the raw
 * response so the caller can diagnose the failure. That snippet is model
 * output derived from case text, so it must never reach the log:
 * `McpError.logSafeMessage` carries a shape-only twin, and `BaseMCPTool`
 * logs the twin *and withholds the error object* — its `message` and `stack`
 * carry the snippet too.
 *
 * That arrangement was previously verified only by inspection. Nothing stopped
 * a later edit from logging `err.message` directly and quietly writing case
 * text into the persisted logs, so this suite asserts both halves: the snippet
 * DOES reach the caller, and it does NOT reach any logger argument.
 *
 * All fixtures synthetic (see analysis-tool-harness.ts).
 */

jest.mock('../../../ai/ai-provider', () => ({ completeAI: jest.fn() }));
jest.mock('../../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ ollamaHost: 'http://127.0.0.1:11434' }),
}));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => results.slice(0, topN)),
}));

import { completeAI } from '../../../ai/ai-provider';
import { DetectContradictionsTool } from '../detect-contradictions';
import { AnalyzeToneTool } from '../analyze-tone';
import { CONFIG, aiResponse, makeHarness } from './analysis-tool-harness';

const ai = completeAI as unknown as jest.Mock;

/**
 * A marker that could only have come from the model response, so an assertion
 * against it is unambiguous. Placed at the start of the fixture because the
 * snippet on the error message is `raw.slice(0, 300)`.
 */
const MARKER = 'SYNTHETIC-CASE-TEXT-9f3a';

/** Unparseable model output — prose, not JSON. Invented content throughout. */
const PROSE =
  `${MARKER} Having reviewed the excerpts, the filings appear to disagree about ` +
  'whether the January conference took place. Tell me if you want the detail.';

/** Does `value` carry the marker anywhere a logging backend could persist it? */
function carriesMarker(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(MARKER);
  if (value instanceof Error) {
    // JSON.stringify(new Error(x)) is "{}", so an Error must be walked by hand
    // or this assertion passes vacuously against exactly the leak it guards.
    return value.message.includes(MARKER) || (value.stack ?? '').includes(MARKER);
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value as Record<string, unknown>).some(v => carriesMarker(v, seen));
  }
  return false;
}

beforeEach(() => {
  ai.mockReset();
  ai.mockResolvedValue(aiResponse(PROSE));
});

describe('LLM_PARSE_ERROR keeps the raw snippet out of the log', () => {
  it('sanity: carriesMarker walks an Error, which JSON.stringify flattens to {}', () => {
    expect(JSON.stringify(new Error(PROSE))).toBe('{}');
    expect(carriesMarker(new Error(PROSE))).toBe(true);
    expect(carriesMarker({ nested: [{ deep: PROSE }] })).toBe(true);
    expect(carriesMarker({ code: 'LLM_PARSE_ERROR' })).toBe(false);
  });

  it('returns the snippet to the caller but logs only the redacted twin', async () => {
    const { context, logger } = makeHarness();

    const out = await new DetectContradictionsTool().execute({ caseId: 'case-1' }, context, CONFIG);

    // The caller asked for the analysis and needs to see why it failed.
    expect(out.success).toBe(false);
    expect(out.errorCode).toBe('LLM_PARSE_ERROR');
    expect(out.error).toContain(MARKER);

    // The log gets shape only.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0];
    expect(message).toMatch(/withheld from logs/);
    expect(message).not.toContain(MARKER);
    expect(meta).toEqual({ code: 'LLM_PARSE_ERROR' });
  });

  it('no logger argument on any channel carries the raw snippet', async () => {
    const { context, logger } = makeHarness();

    await new DetectContradictionsTool().execute({ caseId: 'case-1' }, context, CONFIG);

    for (const [channel, spy] of Object.entries(logger)) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect({ channel, leaked: carriesMarker(arg) }).toEqual({ channel, leaked: false });
        }
      }
    }
  });

  it('holds for an object-shaped tool too, not just the list-shaped ones', async () => {
    const { context, logger } = makeHarness();

    const out = await new AnalyzeToneTool().execute({ documentId: 'doc-1' }, context, CONFIG);

    expect(out.success).toBe(false);
    expect(out.error).toContain(MARKER);
    for (const call of logger.error.mock.calls) {
      for (const arg of call) expect(carriesMarker(arg)).toBe(false);
    }
  });
});
