/** @jest-environment node */
/**
 * Regression cover for the duplicate-load bug (2026-09-15): the Active Tasks
 * panel showed the SAME model loading several times concurrently and never
 * finishing. Root cause — `fireAndForgetLoad`'s `modelLoading` guard was
 * released via a blanket `.finally()` the instant an attempt's promise
 * settled, including a FAILED attempt, which schedules its retry 30s later
 * via `setTimeout`. `.finally` ran immediately, before that timer fired, so
 * for the whole 30s gap the role read as free: the heartbeat auto-loader
 * (containers.ts, a separate call site sharing `state.modelLoading`) or
 * another `/acquire` calling `ensureOllamaModel` again could both start a
 * second load, and then the scheduled retry started a third.
 *
 * No live network calls: ollama-api, containers and docker are mocked at the
 * module boundary — `fireAndForgetLoad` never reaches a real Ollama or Docker.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const ollamaLoadMock = jest.fn();
jest.mock('@/lib/ollama-api', () => ({
  ollamaList: jest.fn().mockResolvedValue([]),
  ollamaShow: jest.fn().mockResolvedValue(false),
  ollamaPull: jest.fn().mockResolvedValue(undefined),
  ollamaLoad: (...args: unknown[]) => ollamaLoadMock(...args),
  ollamaUnload: jest.fn().mockResolvedValue(true),
  waitForOllama: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/containers', () => ({
  loadGpuOnly: jest.fn(),
  ensureContainerForRole: jest.fn(),
  getAllContainerStates: jest.fn(),
}));

jest.mock('@/lib/docker', () => ({
  getContainerState: jest.fn(),
  startContainer: jest.fn(),
  stopContainer: jest.fn(),
  removeContainer: jest.fn(),
  createContainer: jest.fn(),
  pullImage: jest.fn(),
  getDockerMode: jest.fn(),
  isDockerAvailable: jest.fn(),
  buildExpectedConfig: jest.fn(),
  detectConfigDrift: jest.fn(),
  isPortConflict: jest.fn(),
  findContainerOnPort: jest.fn(),
  dockerRequest: jest.fn(),
}));

import { ensureSet } from '@/lib/state';
import { __fireAndForgetLoadForTest as fireAndForgetLoad } from '@/lib/handlers';
import { tasks, __resetTasksForTest } from '@/lib/task-tracker';

// A role deliberately absent from state.registry — fireAndForgetLoad skips
// the VRAM pre-check for an unregistered role (`def` is undefined) and goes
// straight to the mocked ollamaLoad, which is all these tests need to drive.
const ROLE = 'test-load-role';
const RETRY_DELAY = 30_000; // matches handlers.ts LOAD_RETRY_DELAY

async function flush(): Promise<void> {
  // Let the queued .then()/.catch() microtasks run before inspecting state.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('fireAndForgetLoad — modelLoading guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    ollamaLoadMock.mockReset();
    ensureSet('modelLoading').clear();
    __resetTasksForTest();
  });

  afterEach(() => {
    ensureSet('modelLoading').clear();
    __resetTasksForTest();
    jest.useRealTimers();
  });

  it('holds the guard through a failed attempt and its scheduled retry — a concurrent call in between is rejected', async () => {
    ollamaLoadMock.mockResolvedValueOnce(false); // attempt 1 fails
    ollamaLoadMock.mockResolvedValueOnce(true); // attempt 2 (the retry) succeeds

    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();

    // Attempt 1 has already settled (failed) but its retry hasn't fired yet —
    // this is exactly the window the bug lived in. The guard must still be held.
    expect(ollamaLoadMock).toHaveBeenCalledTimes(1);
    expect(ensureSet('modelLoading').has(ROLE)).toBe(true);

    // A concurrent caller (heartbeat auto-loader / another /acquire) tries
    // during the retry-delay window — must be rejected outright, not start a
    // second concurrent load. Attempt 1 already failed and moved itself to
    // history (tasks.fail()), so the regression to guard against is a SECOND
    // "running" task appearing from this rejected call — there must be none.
    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();
    expect(ollamaLoadMock).toHaveBeenCalledTimes(1);
    expect(tasks.getActive().filter((t) => t.role === ROLE)).toHaveLength(0);

    // Advance to the scheduled retry.
    await jest.advanceTimersByTimeAsync(RETRY_DELAY);
    await flush();

    expect(ollamaLoadMock).toHaveBeenCalledTimes(2);
    expect(ensureSet('modelLoading').has(ROLE)).toBe(false); // released on success
    expect(tasks.getActive().filter((t) => t.role === ROLE)).toHaveLength(0);
  });

  it('releases the guard once the retry chain exhausts MAX_ATTEMPTS, and a fresh chain can then start', async () => {
    ollamaLoadMock.mockResolvedValue(false); // every attempt fails

    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();
    expect(ensureSet('modelLoading').has(ROLE)).toBe(true);

    await jest.advanceTimersByTimeAsync(RETRY_DELAY); // attempt 2
    await flush();
    expect(ensureSet('modelLoading').has(ROLE)).toBe(true); // still held — one attempt left

    await jest.advanceTimersByTimeAsync(RETRY_DELAY); // attempt 3 (final)
    await flush();

    expect(ollamaLoadMock).toHaveBeenCalledTimes(3);
    expect(ensureSet('modelLoading').has(ROLE)).toBe(false); // released — chain exhausted
    expect(tasks.getActive().filter((t) => t.role === ROLE)).toHaveLength(0);

    // A caller after exhaustion starts a genuinely NEW chain — not blocked forever.
    ollamaLoadMock.mockResolvedValueOnce(true);
    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();
    expect(ollamaLoadMock).toHaveBeenCalledTimes(4);
    expect(ensureSet('modelLoading').has(ROLE)).toBe(false);
  });

  it('releases the guard immediately on a successful first attempt (no unnecessary hold)', async () => {
    ollamaLoadMock.mockResolvedValueOnce(true);
    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();

    expect(ensureSet('modelLoading').has(ROLE)).toBe(false);
    expect(tasks.getActive().filter((t) => t.role === ROLE)).toHaveLength(0);
  });

  it('a thrown/rejected attempt also holds the guard across its retry, and releases on final exhaustion', async () => {
    ollamaLoadMock.mockRejectedValue(new Error('connection reset'));

    fireAndForgetLoad(ROLE, 11434, 'test-model:1b');
    await flush();
    expect(ensureSet('modelLoading').has(ROLE)).toBe(true);

    fireAndForgetLoad(ROLE, 11434, 'test-model:1b'); // concurrent call during the wait — rejected
    await flush();
    expect(ollamaLoadMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RETRY_DELAY);
    await jest.advanceTimersByTimeAsync(RETRY_DELAY);
    await flush();

    expect(ollamaLoadMock).toHaveBeenCalledTimes(3);
    expect(ensureSet('modelLoading').has(ROLE)).toBe(false);
  });
});
