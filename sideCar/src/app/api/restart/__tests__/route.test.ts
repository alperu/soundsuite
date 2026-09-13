/** @jest-environment node */
/**
 * Task #45 — POST /api/restart ordering and refusal contract.
 *
 * `@/lib/docker` is mocked wholesale, so no Docker call of any kind leaves
 * this suite. The assertions that matter: the response is produced BEFORE any
 * restart is issued, and a refusal never issues one at all.
 */

const resolveSelfContainer = jest.fn();
const restartContainer = jest.fn().mockResolvedValue('restarted');

jest.mock('@/lib/docker', () => ({ resolveSelfContainer, restartContainer }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { GET, POST } from '@/app/api/restart/route';

const SELF_ID = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';

const resolvedOk = {
  ok: true,
  id: SELF_ID,
  shortId: SELF_ID.slice(0, 12),
  name: 'ss-sidecar',
  source: 'mountinfo',
  corroborated: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  restartContainer.mockResolvedValue('restarted');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GET /api/restart — feasibility for the UI', () => {
  it('reports the resolved target when a restart is possible', async () => {
    resolveSelfContainer.mockResolvedValue(resolvedOk);
    const res = await GET();
    const body = await res.json();
    expect(body.canRestart).toBe(true);
    expect(body.target).toMatchObject({ shortId: SELF_ID.slice(0, 12), name: 'ss-sidecar' });
    // The UI must be able to say this is not the Docker engine.
    expect(body.note).toMatch(/does not restart the Docker engine/);
  });

  it('reports a named reason when it is not, so the button can be disabled with a tooltip', async () => {
    resolveSelfContainer.mockResolvedValue({
      ok: false,
      reason: 'docker-unreachable',
      detail: 'The Docker API is not reachable from the sidecar.',
    });
    const res = await GET();
    const body = await res.json();
    expect(body).toMatchObject({ canRestart: false, reason: 'docker-unreachable' });
    expect(body.detail).toBeTruthy();
  });
});

describe('POST /api/restart — respond first, restart after', () => {
  it('returns 202 and has NOT restarted anything by the time the response exists', async () => {
    jest.useFakeTimers();
    resolveSelfContainer.mockResolvedValue(resolvedOk);

    const res = await POST();

    expect(res.status).toBe(202);
    // The ordering guarantee: nothing has been killed yet.
    expect(restartContainer).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.restarting).toBe(true);
    expect(body.target.id).toBe(SELF_ID);
    // It must not claim success — it reports the request, not the outcome.
    expect(body.outcome).toMatch(/unknown/i);
    expect(body).not.toHaveProperty('restarted');

    // Only once the delay elapses is the restart issued — by resolved ID.
    jest.advanceTimersByTime(body.delayMs);
    expect(restartContainer).toHaveBeenCalledTimes(1);
    expect(restartContainer).toHaveBeenCalledWith(SELF_ID, body.stopGraceSeconds);
  });

  it('swallows a transport error from the restart call (expected once the kill lands)', async () => {
    jest.useFakeTimers();
    resolveSelfContainer.mockResolvedValue(resolvedOk);
    restartContainer.mockRejectedValue(new Error('socket hang up'));

    const res = await POST();
    expect(res.status).toBe(202);
    jest.advanceTimersByTime(1000);
    // An unhandled rejection here would fail the suite; reaching this line is the assertion.
    await Promise.resolve();
    expect(restartContainer).toHaveBeenCalled();
  });
});

describe('POST /api/restart — refusals never restart anything', () => {
  it('refuses 409 naming both identities when self resolves to a managed sibling', async () => {
    resolveSelfContainer.mockResolvedValue({
      ok: false,
      reason: 'resolved-is-managed',
      detail:
        `Resolved own container as "ss-reranker" (${SELF_ID.slice(0, 12)}), but that is a ` +
        'container this sidecar manages (managed set: ss-reranker, ss-ocr). Refusing.',
    });

    const res = await POST();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.restarting).toBe(false);
    expect(body.reason).toBe('resolved-is-managed');
    expect(body.detail).toContain('ss-reranker');
    expect(body.detail).toContain(SELF_ID.slice(0, 12));
    // THE test: no sibling model container is ever touched.
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it.each([
    'docker-unreachable',
    'not-in-container',
    'self-unresolvable',
    'sources-disagree',
  ])('refuses %s with its own reason code and no restart', async (reason) => {
    resolveSelfContainer.mockResolvedValue({ ok: false, reason, detail: `refused: ${reason}` });
    const res = await POST();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe(reason);
    expect(body.detail).toBe(`refused: ${reason}`);
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it('reports a reason rather than a bare 500 if resolution itself throws', async () => {
    resolveSelfContainer.mockRejectedValue(new Error('mountinfo exploded'));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe('self-unresolvable');
    expect(body.detail).toContain('mountinfo exploded');
    expect(restartContainer).not.toHaveBeenCalled();
  });
});
