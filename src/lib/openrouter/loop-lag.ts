/**
 * Event-loop lag guard for the OpenRouter bulk worker pool.
 *
 * When the main thread is busy (JSON parsing, LanceDB writes, OCR glue), more
 * bulk requests in flight only make every page and search slower. Every 5 s we
 * read the p95 event-loop delay. Above `highMs` (100) the lag limit steps down
 * by one (floor 2); under `lowMs` (50) it steps up by one, at most once per
 * 30 s. The pool runs `min(workerCount, 429 limit, lag limit)` bulk requests.
 *
 * Copied from Fantom MCP (src/openrouter/loopLag.ts).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

export interface LagState {
  p95Ms: number;
  maxMs: number;
  lagLimit: number;
  /** How often the limit was lowered since boot. */
  stepsDown: number;
  lastChangeAt: number | null;
}

export interface LagOptions {
  highMs?: number;
  lowMs?: number;
  sampleMs?: number;
  rampMs?: number;
  /** Lowest limit the guard steps down to (default 2), so lag the pool did
   *  not cause cannot starve a running ingestion. */
  floor?: number;
}

export class LoopLagGuard {
  private hist: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: LagState;
  private lastRampAt = 0;
  readonly highMs: number;
  readonly lowMs: number;
  readonly sampleMs: number;
  readonly rampMs: number;
  readonly floor: number;

  constructor(private ceiling: () => number, opts: LagOptions = {}) {
    this.highMs = opts.highMs ?? 100;
    this.lowMs = opts.lowMs ?? 50;
    this.sampleMs = opts.sampleMs ?? 5_000;
    this.rampMs = opts.rampMs ?? 30_000;
    this.floor = Math.max(1, opts.floor ?? 2);
    this.state = { p95Ms: 0, maxMs: 0, lagLimit: Number.POSITIVE_INFINITY, stepsDown: 0, lastChangeAt: null };
  }

  start(): void {
    if (this.timer) return;
    this.hist = monitorEventLoopDelay({ resolution: 20 });
    this.hist.enable();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hist?.disable();
    this.hist = null;
  }

  private sample(): void {
    if (!this.hist) return;
    const p95 = this.hist.percentile(95) / 1e6;
    const max = this.hist.max / 1e6;
    this.hist.reset();
    this.observe(p95, max);
  }

  /** Feed one sample (public for tests). */
  observe(p95Ms: number, maxMs = p95Ms, now = Date.now()): void {
    const ceil = Math.max(1, this.ceiling());
    let limit = Math.min(this.state.lagLimit, ceil);
    const floor = Math.min(this.floor, ceil);
    if (p95Ms > this.highMs && limit > floor) {
      limit -= 1;
      this.state.stepsDown++;
      this.state.lastChangeAt = now;
      this.lastRampAt = now;
    } else if (p95Ms < this.lowMs && limit < ceil && now - this.lastRampAt >= this.rampMs) {
      limit += 1;
      this.state.lastChangeAt = now;
      this.lastRampAt = now;
    }
    this.state = {
      ...this.state,
      p95Ms: Math.round(p95Ms * 10) / 10,
      maxMs: Math.round(maxMs * 10) / 10,
      lagLimit: limit,
    };
  }

  /** The current lag limit, never above the worker count. */
  limit(): number {
    return Math.min(this.state.lagLimit, Math.max(1, this.ceiling()));
  }

  stats(): LagState {
    return { ...this.state, lagLimit: this.limit() };
  }

  reset(): void {
    this.state = { p95Ms: 0, maxMs: 0, lagLimit: Number.POSITIVE_INFINITY, stepsDown: 0, lastChangeAt: null };
    this.lastRampAt = 0;
  }
}
