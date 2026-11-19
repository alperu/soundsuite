/** @jest-environment node */
/**
 * OpenRouter worker pool (src/lib/openrouter/worker-pool.ts), its lag guard
 * (loop-lag.ts) and the Workers setting range checks (pool-settings.ts).
 * No network: every job is a local promise.
 */
import { OpenRouterWorkerPool } from '../worker-pool';
import { LoopLagGuard } from '../loop-lag';
import { clampWorkerCount, validateWorkerCount, POOL_LIMITS } from '../pool-settings';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class HttpErr extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`HTTP ${status}`);
  }
}

describe('OpenRouterWorkerPool — concurrency', () => {
  it('never runs more than workerCount bulk jobs at once', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 3 });
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 10 }, () =>
      pool.submit({
        role: 'embedding',
        lane: 'bulk',
        run: async () => {
          running++;
          peak = Math.max(peak, running);
          await tick(5);
          running--;
          return 1;
        },
      }),
    );
    const out = await Promise.all(jobs);
    expect(out).toHaveLength(10);
    expect(peak).toBe(3);
    expect(pool.stats().totals.done).toBe(10);
  });

  it('runs an interactive job while the bulk lane is full', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 2 });
    const gate = deferred();
    const bulk = Array.from({ length: 5 }, () =>
      pool.submit({ role: 'embedding', lane: 'bulk', run: () => gate.promise }),
    );
    await tick();
    expect(pool.stats().bulk).toMatchObject({ running: 2, queued: 3 });

    const inter = await pool.submit({ role: 'reranker', lane: 'interactive', run: async () => 'fast' });
    expect(inter).toBe('fast');
    expect(pool.stats().bulk.running).toBe(2);

    gate.resolve();
    await Promise.all(bulk);
  });

  it('applies a new worker count to the next job start', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 1 });
    pool.setWorkerCount(99);
    expect(pool.getSettings().workerCount).toBe(POOL_LIMITS.workerCount.max);
    pool.setWorkerCount(0);
    expect(pool.getSettings().workerCount).toBe(1);
  });
});

describe('OpenRouterWorkerPool — retries', () => {
  it('halves the bulk limit on a 429 and retries the job', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 4 });
    const gate = deferred();
    let calls = 0;
    const others = Array.from({ length: 3 }, () =>
      pool.submit({ role: 'embedding', lane: 'bulk', run: () => gate.promise }),
    );
    const limited = pool.submit({
      role: 'embedding',
      lane: 'bulk',
      run: async () => {
        calls++;
        if (calls === 1) throw new HttpErr(429, 20);
        return 'ok';
      },
    });
    await tick(5);
    const s = pool.stats();
    expect(s.rateLimit.hits).toBe(1);
    expect(s.rateLimit.adaptiveLimit).toBe(2); // 4 running → halved
    expect(s.bulk.limit).toBe(2);

    gate.resolve();
    await expect(limited).resolves.toBe('ok');
    await Promise.all(others);
    expect(calls).toBe(2);
    expect(pool.stats().byRole.embedding).toMatchObject({ rateLimited: 1, retried: 1, failed: 0 });
  });

  it('gives up on a 429 after 3 retries', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 2 });
    let calls = 0;
    const p = pool.submit({
      role: 'embedding',
      lane: 'bulk',
      run: async () => {
        calls++;
        throw new HttpErr(429, 1);
      },
    });
    await expect(p).rejects.toThrow('HTTP 429');
    expect(calls).toBe(4);
  });

  it('retries a 5xx once', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 2 });
    let calls = 0;
    const p = pool.submit({
      role: 'reranker',
      lane: 'interactive',
      run: async () => {
        calls++;
        throw new HttpErr(503);
      },
    });
    await expect(p).rejects.toThrow('HTTP 503');
    expect(calls).toBe(2);
  });

  it('never retries a 4xx', async () => {
    const pool = new OpenRouterWorkerPool({ workerCount: 2 });
    let calls = 0;
    const p = pool.submit({
      role: 'completion',
      lane: 'interactive',
      run: async () => {
        calls++;
        throw new HttpErr(401);
      },
    });
    await expect(p).rejects.toThrow('HTTP 401');
    expect(calls).toBe(1);
    expect(pool.stats().totals.failed).toBe(1);
  });
});

describe('LoopLagGuard', () => {
  it('steps down by one per slow sample, never below the floor of 2', () => {
    const g = new LoopLagGuard(() => 6);
    const t = 1_000_000;
    expect(g.limit()).toBe(6);
    g.observe(150, 150, t);
    expect(g.limit()).toBe(5);
    for (let i = 1; i <= 10; i++) g.observe(150, 150, t + i * 5_000);
    expect(g.limit()).toBe(2);
    expect(g.stats().stepsDown).toBe(4);
  });

  it('steps up by one when calm, at most once per 30 s', () => {
    const g = new LoopLagGuard(() => 6);
    const t = 1_000_000;
    g.observe(150, 150, t);
    g.observe(150, 150, t + 5_000); // 4
    expect(g.limit()).toBe(4);
    g.observe(10, 10, t + 10_000); // too soon after the last change
    expect(g.limit()).toBe(4);
    g.observe(10, 10, t + 35_000);
    expect(g.limit()).toBe(5);
    g.observe(10, 10, t + 40_000);
    expect(g.limit()).toBe(5);
    g.observe(10, 10, t + 65_000);
    expect(g.limit()).toBe(6);
    g.observe(10, 10, t + 100_000); // already at the worker count
    expect(g.limit()).toBe(6);
  });

  it('does nothing between 50 and 100 ms', () => {
    const g = new LoopLagGuard(() => 6);
    g.observe(150, 150, 1_000);
    g.observe(75, 75, 100_000);
    expect(g.limit()).toBe(5);
  });

  it('caps the bulk limit in the pool', () => {
    const lag = new LoopLagGuard(() => 6);
    const pool = new OpenRouterWorkerPool({ workerCount: 6 }, lag);
    for (let i = 0; i < 10; i++) lag.observe(500, 500, 1_000 + i);
    expect(pool.bulkLimit()).toBe(2);
  });
});

describe('Workers setting', () => {
  it('clamps to 1-8 and defaults to 6', () => {
    expect(clampWorkerCount(0)).toBe(1);
    expect(clampWorkerCount(-3)).toBe(1);
    expect(clampWorkerCount(99)).toBe(8);
    expect(clampWorkerCount('4')).toBe(4);
    expect(clampWorkerCount(undefined)).toBe(6);
    expect(clampWorkerCount('abc')).toBe(6);
    expect(clampWorkerCount('')).toBe(6);
  });

  it('rejects out-of-range or non-integer input on save', () => {
    expect(validateWorkerCount(9)).toMatch(/1 to 8/);
    expect(validateWorkerCount(0)).toMatch(/1 to 8/);
    expect(validateWorkerCount(2.5)).toMatch(/whole number/);
    expect(validateWorkerCount('x')).not.toBeNull();
    expect(validateWorkerCount(8)).toBeNull();
    expect(validateWorkerCount('3')).toBeNull();
    expect(validateWorkerCount(undefined)).toBeNull();
    expect(validateWorkerCount('')).toBeNull();
  });
});
