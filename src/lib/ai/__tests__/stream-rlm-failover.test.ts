/**
 * streamRlm() failover across sandbox hosts.
 *
 * The bug this pins: a cloud-only run resolved the first sidecar whose cached
 * status said rlm-sandbox=running, that host's :8101 was mid-restart, `fetch`
 * threw `fetch failed`, and the run ended — with three other healthy sandboxes
 * in the fleet never tried. Now a network failure or a 5xx excludes the host
 * and re-resolves. A 4xx does not: it is our request, and would repeat on
 * every host.
 *
 * Unlike stream-rlm-sandbox-fallback.test.ts this file mocks global.fetch —
 * that is the whole point — so it lives on its own rather than breaking that
 * file's "no live network calls" promise.
 */

jest.mock('@/lib/gpu/fleet-router', () => ({ getFleetStatus: jest.fn() }));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn() }));
jest.mock('@/lib/gpu/master-identity', () => ({
  getCanonicalMasterUrl: jest.fn().mockResolvedValue('http://master:3000'),
}));

import { getFleetStatus } from '@/lib/gpu/fleet-router';
import { getConfig } from '@/lib/db/config';
import { streamRlm, type StreamRlmEvent } from '../stream-rlm';

const mockFleet = getFleetStatus as jest.Mock;
const mockCfg = getConfig as jest.Mock;

function sandboxSidecar(name: string) {
  return {
    url: `http://${name}:8098`,
    hostname: name,
    status: 'connected',
    sidecarStatus: { containers: { rlm: { status: 'exited' }, 'rlm-sandbox': { status: 'running' } } },
  };
}

/** A minimal non-streaming completion, the shape the sandbox path reads. */
const okCompletion = (text: string) => ({
  ok: true,
  status: 200,
  body: {},
  json: async () => ({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
  text: async () => '',
});

const httpErr = (status: number) => ({
  ok: false,
  status,
  body: {},
  json: async () => ({}),
  text: async () => `err ${status}`,
});

async function drain(gen: AsyncGenerator<StreamRlmEvent>): Promise<StreamRlmEvent[]> {
  const out: StreamRlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** The answer text, wherever this path surfaces it (token text or done content). */
function answerText(events: StreamRlmEvent[]): string {
  return events.map((e) => e.text ?? e.content ?? '').join('');
}

describe('streamRlm — failover across sandbox hosts', () => {
  const realFetch = global.fetch;
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  beforeEach(() => {
    jest.clearAllMocks();
    mockFleet.mockResolvedValue({
      sidecars: [sandboxSidecar('sidecar-a'), sandboxSidecar('sidecar-b'), sandboxSidecar('sidecar-c')],
    });
    mockCfg.mockResolvedValue({ virtualInferenceModeRlm: 'cloud-only', rlmSandboxModel: 'deepseek/deepseek-v4-flash' });
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('a network failure on the first host fails over to the next and completes there', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(okCompletion('answer from b'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const events = await drain(streamRlm({ messages: msgs }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://sidecar-a:8101/v1/chat/completions');
    expect(fetchMock.mock.calls[1][0]).toBe('http://sidecar-b:8101/v1/chat/completions');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(answerText(events)).toContain('answer from b');
  });

  it('a 5xx fails over; the answer comes from the healthy host', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(httpErr(503)).mockResolvedValueOnce(okCompletion('answer from b'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const events = await drain(streamRlm({ messages: msgs }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(answerText(events)).toContain('answer from b');
  });

  it('a 4xx does NOT fail over — it is our request, and would repeat on every host', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(httpErr(409));
    global.fetch = fetchMock as unknown as typeof fetch;

    const events = await drain(streamRlm({ messages: msgs }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.type === 'error');
    expect(err?.message).toMatch(/HTTP 409/);
    // Single host tried → no "tried N hosts" suffix; the message is what it was before.
    expect(err?.message).not.toMatch(/tried \d+ hosts/);
  });

  it('when every host fails, the error names all of them — not just the first', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const events = await drain(streamRlm({ messages: msgs }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const err = events.find((e) => e.type === 'error');
    expect(err?.message).toMatch(/tried 3 hosts/);
    expect(err?.message).toMatch(/sidecar-a/);
    expect(err?.message).toMatch(/sidecar-b/);
    expect(err?.message).toMatch(/sidecar-c/);
  });

  it('does not fail over when the caller aborted — a cancel is not a host failure', async () => {
    const ac = new AbortController();
    const fetchMock = jest.fn().mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const events = await drain(streamRlm({ messages: msgs, signal: ac.signal }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
