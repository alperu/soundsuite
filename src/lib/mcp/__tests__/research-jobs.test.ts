/** @jest-environment node */

import {
  startJob,
  getJobStatus,
  getJobResult,
  cancelJob,
  listJobs,
  readEvents,
  subscribe,
  isJobFinished,
  parseJobKind,
  _resetJobsForTests,
  type JobHandle,
} from '../research-jobs';
import type { EvidenceItem, ResearchJobEvent } from '../research-types';

const flush = () => new Promise<void>((r) => setImmediate(r));

function item(i: number): EvidenceItem {
  return { id: `ev-${i}`, documentId: `doc-${i % 3}`, text: `synthetic passage ${i}`, score: 1 - i / 100, hits: 1, source: 'retrieval' };
}

/** A run() whose steps are driven from the test. */
function controlled() {
  let handle!: JobHandle;
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  let markReady!: () => void;
  const ready = new Promise<void>((r) => { markReady = r; });
  const run = async (h: JobHandle): Promise<unknown> => {
    handle = h;
    markReady();
    return new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  };
  return {
    run,
    ready,
    handle: () => handle,
    resolve: (v: unknown) => resolve(v),
    reject: (e: unknown) => reject(e),
  };
}

describe('research-jobs', () => {
  afterEach(() => _resetJobsForTests());

  it('runs to done, exposes the result and a monotonic cursor', async () => {
    const c = controlled();
    const view = startJob({ kind: 'research', profile: 'local', query: 'q', run: c.run });
    expect(view.status).toBe('queued');
    expect(view.cursor).toBe(0);

    await c.ready;
    expect(getJobStatus(view.id)!.status).toBe('running');

    c.handle().evidence([item(0), item(1), item(2)]);
    const s1 = getJobStatus(view.id, 0)!;
    expect(s1.cursor).toBe(3);
    expect(s1.newEvidenceCount).toBe(3);
    expect(s1.evidence.map((e) => e.id)).toEqual(['ev-0', 'ev-1', 'ev-2']);

    c.handle().evidence([item(3)]);
    const s2 = getJobStatus(view.id, s1.cursor)!;
    expect(s2.cursor).toBe(4);
    expect(s2.newEvidenceCount).toBe(1);
    expect(s2.evidence.map((e) => e.id)).toEqual(['ev-3']);

    // Re-polling with the same cursor is idempotent; a stale cursor never rewinds the total.
    expect(getJobStatus(view.id, s2.cursor)!.newEvidenceCount).toBe(0);
    expect(getJobStatus(view.id, 1)!.cursor).toBe(4);
    expect(getJobStatus(view.id, 999)!.evidence).toEqual([]);

    expect(getJobResult(view.id)).toBeNull();
    c.resolve({ done: true });
    await flush();

    const final = getJobStatus(view.id)!;
    expect(final.status).toBe('done');
    expect(getJobResult(view.id)).toEqual({ done: true });
    expect(isJobFinished(view.id)).toBe(true);
  });

  it('tracks phaseStartedAt / phaseElapsedMs per phase change', async () => {
    const c = controlled();
    const view = startJob({ kind: 'research', profile: 'local', query: 'q', run: c.run });
    expect(view.phaseStartedAt).toBe(view.startedAt);
    expect(view.phaseElapsedMs).toBeGreaterThanOrEqual(0);
    await c.ready;

    c.handle().progress({ phase: 'decompose', message: 'breaking question into sub-queries' });
    const s1 = getJobStatus(view.id)!;
    expect(s1.phase).toBe('decompose');
    const decomposeStart = s1.phaseStartedAt;
    expect(decomposeStart).toBeGreaterThanOrEqual(view.startedAt);

    // Same phase again → the phase clock keeps running from the first event.
    await new Promise((r) => setTimeout(r, 15));
    c.handle().progress({ phase: 'decompose', message: 'still decomposing' });
    const s2 = getJobStatus(view.id)!;
    expect(s2.phaseStartedAt).toBe(decomposeStart);
    expect(s2.phaseElapsedMs).toBeGreaterThanOrEqual(10);

    // New phase → clock resets.
    c.handle().progress({ phase: 'retrieve', message: 'searching' });
    const s3 = getJobStatus(view.id)!;
    expect(s3.phase).toBe('retrieve');
    expect(s3.phaseStartedAt).toBeGreaterThanOrEqual(decomposeStart);
    expect(s3.phaseElapsedMs).toBeLessThan(s2.phaseElapsedMs + 5);

    c.resolve({ done: true });
    await flush();
    const final = getJobStatus(view.id)!;
    const frozen = final.phaseElapsedMs;
    await new Promise((r) => setTimeout(r, 10));
    expect(getJobStatus(view.id)!.phaseElapsedMs).toBe(frozen);
  });

  it('appends tokens to partialReport only for routed', async () => {
    const local = controlled();
    const routed = controlled();
    const l = startJob({ kind: 'research', profile: 'local', query: 'q', run: local.run });
    const r = startJob({ kind: 'report', profile: 'routed', query: 'q', run: routed.run });
    await Promise.all([local.ready, routed.ready]);

    local.handle().token('should be dropped');
    routed.handle().token('Hello, ');
    routed.handle().token('world');

    const ls = getJobStatus(l.id)!;
    expect(ls.partialReport).toBeUndefined();
    expect(readEvents(l.id).filter((e) => e.type === 'token')).toHaveLength(0);

    const rs = getJobStatus(r.id)!;
    expect(rs.partialReport).toBe('Hello, world');
    expect(readEvents(r.id).filter((e) => e.type === 'token')).toHaveLength(2);
  });

  it('cancel aborts the signal and finishes the job as cancelled', async () => {
    const c = controlled();
    const v = startJob({ kind: 'research', profile: 'local', query: 'q', run: c.run });
    await c.ready;
    const signal = c.handle().signal;
    expect(signal.aborted).toBe(false);

    expect(cancelJob(v.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(getJobStatus(v.id)!.status).toBe('cancelled');
    expect(cancelJob(v.id)).toBe(false);

    // A late resolve / evidence after cancel is ignored.
    c.handle().evidence([item(9)]);
    c.resolve({ late: true });
    await flush();
    expect(getJobStatus(v.id)!.status).toBe('cancelled');
    expect(getJobStatus(v.id)!.cursor).toBe(0);
    expect(getJobResult(v.id)).toBeNull();
  });

  it('captures thrown errors as status error', async () => {
    const c = controlled();
    const v = startJob({ kind: 'report', profile: 'routed', query: 'q', run: c.run });
    await c.ready;
    c.reject(new Error('synthetic failure'));
    await flush();
    const s = getJobStatus(v.id)!;
    expect(s.status).toBe('error');
    expect(s.error).toBe('synthetic failure');
    const last = readEvents(v.id).at(-1)!;
    expect(last.type).toBe('error');
  });

  it('replays events in seq order and tails via subscribe', async () => {
    const c = controlled();
    const v = startJob({ kind: 'research', profile: 'local', query: 'q', run: c.run });
    await c.ready;

    const tail: ResearchJobEvent[] = [];
    const unsub = subscribe(v.id, (e) => tail.push(e));

    c.handle().progress({ phase: 'retrieve', message: 'retrieving' });
    c.handle().evidence([item(0)]);
    c.handle().thoughts('narration');
    c.handle().rlmNote('round 1 filled a gap');
    c.handle().setOutline({ sections: [{ title: 'A', evidenceIds: ['ev-0'] }], gaps: [] });

    const all = readEvents(v.id);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all.map((e) => e.type)).toEqual(['progress', 'evidence', 'thoughts']);
    expect(readEvents(v.id, 1).map((e) => e.seq)).toEqual([1, 2]);
    expect(tail.map((e) => e.seq)).toEqual([0, 1, 2]);

    const s = getJobStatus(v.id)!;
    expect(s.phase).toBe('retrieve');
    expect(s.rlmNotes).toEqual(['round 1 filled a gap']);
    expect(s.outline?.sections[0].title).toBe('A');

    unsub();
    c.resolve({ ok: 1 });
    await flush();
    expect(tail).toHaveLength(3); // unsubscribed before the result event
    expect(readEvents(v.id).at(-1)!.type).toBe('result');
  });

  it('lists jobs newest-first and scopes by session', async () => {
    const a = startJob({ kind: 'research', profile: 'local', query: 'a', sessionId: 's1', run: async () => 1 });
    const b = startJob({ kind: 'report', profile: 'routed', query: 'b', sessionId: 's2', run: async () => 2 });
    await flush();
    expect(listJobs().map((j) => j.id)).toHaveLength(2);
    expect(listJobs('s1').map((j) => j.id)).toEqual([a.id]);
    expect(listJobs('s2').map((j) => j.id)).toEqual([b.id]);
    expect(listJobs('nope')).toEqual([]);
  });

  it('validates kind', () => {
    expect(parseJobKind('research')).toBe('research');
    expect(parseJobKind('report')).toBe('report');
    expect(parseJobKind('tools')).toBeNull();
    expect(parseJobKind(undefined)).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(getJobStatus('missing')).toBeNull();
    expect(getJobResult('missing')).toBeNull();
    expect(cancelJob('missing')).toBe(false);
    expect(readEvents('missing')).toEqual([]);
    expect(isJobFinished('missing')).toBe(true);
  });
});
