/** @jest-environment node */
/**
 * Regression cover: nothing used to reap a task that never settles. A
 * promise that hangs (dropped Ollama connection mid-load, a container that
 * vanishes mid-pull) left its task "running" in the Active Tasks panel
 * forever — this is what made the duplicate-load guard bug (handlers.ts
 * fireAndForgetLoad) show as PERMANENT stuck rows rather than something that
 * eventually cleared on its own.
 */
import { tasks, sweepStaleTasks, __resetTasksForTest } from '@/lib/task-tracker';

describe('task-tracker stale sweep', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetTasksForTest();
    delete process.env.SS_TASK_STALE_MS;
  });

  afterEach(() => {
    __resetTasksForTest();
    delete process.env.SS_TASK_STALE_MS;
    jest.useRealTimers();
  });

  it('reaps a task that never settles once it exceeds the stale TTL', () => {
    process.env.SS_TASK_STALE_MS = '1000';
    const id = tasks.start('model-load', 'Load stuck-model into VRAM', 'stuck-role');
    expect(tasks.getActive()).toHaveLength(1);

    jest.setSystemTime(Date.now() + 5_000);
    expect(sweepStaleTasks()).toBe(1);

    expect(tasks.getActive()).toHaveLength(0);
    const reaped = tasks.getAll().find((t) => t.id === id);
    expect(reaped?.status).toBe('failed');
    expect(reaped?.error).toMatch(/stale/i);
  });

  it('does not reap a task that is still receiving progress updates (measured from last activity, not start)', () => {
    process.env.SS_TASK_STALE_MS = '1000';
    const id = tasks.start('model-pull', 'Pull big-model', 'role-a');

    // 800ms since start — an update lands, resetting the staleness clock.
    jest.setSystemTime(Date.now() + 800);
    tasks.update(id, { progress: 40, detail: 'still going' });

    // Another 800ms — 1600ms since START (would be stale if measured from
    // startedAt) but only 800ms since the last UPDATE — must survive.
    jest.setSystemTime(Date.now() + 800);
    expect(sweepStaleTasks()).toBe(0);
    expect(tasks.getActive()).toHaveLength(1);

    // Now let it go stale from that last update.
    jest.setSystemTime(Date.now() + 1_500);
    expect(sweepStaleTasks()).toBe(1);
    expect(tasks.getActive()).toHaveLength(0);
  });

  it('a TTL of 0 disables the sweep', () => {
    process.env.SS_TASK_STALE_MS = '0';
    tasks.start('model-load', 'Load x', 'role-b');
    jest.setSystemTime(Date.now() + 86_400_000);
    expect(sweepStaleTasks()).toBe(0);
    expect(tasks.getActive()).toHaveLength(1);
  });

  it('reaps multiple stale tasks across different roles in one sweep, leaving fresh ones alone', () => {
    process.env.SS_TASK_STALE_MS = '1000';
    tasks.start('model-load', 'Load a', 'role-a');
    tasks.start('model-pull', 'Pull b', 'role-b');

    jest.setSystemTime(Date.now() + 5_000);
    tasks.start('model-load', 'Load c', 'role-c'); // fresh — started just now

    expect(sweepStaleTasks()).toBe(2);
    const active = tasks.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].role).toBe('role-c');
  });

  it('the periodic sweeper reaps automatically once its interval elapses, without a manual sweepStaleTasks() call', async () => {
    process.env.SS_TASK_STALE_MS = '1000';
    tasks.start('model-load', 'Load y', 'role-c'); // also arms the sweeper (60s interval)
    expect(tasks.getActive()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(61_000);

    expect(tasks.getActive()).toHaveLength(0);
    expect(tasks.getAll().find((t) => t.role === 'role-c')?.status).toBe('failed');
  });

  it('never reaps a task that already completed or failed normally (nothing left to sweep)', () => {
    process.env.SS_TASK_STALE_MS = '1000';
    const okId = tasks.start('model-load', 'Load ok-model', 'role-ok');
    tasks.complete(okId);
    const failId = tasks.start('model-load', 'Load bad-model', 'role-bad');
    tasks.fail(failId, 'boom');

    jest.setSystemTime(Date.now() + 86_400_000);
    expect(sweepStaleTasks()).toBe(0);

    const ok = tasks.getAll().find((t) => t.id === okId);
    expect(ok?.status).toBe('completed');
    expect(ok?.error).toBeUndefined();
  });
});
