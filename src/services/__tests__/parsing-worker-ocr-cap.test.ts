/**
 * @jest-environment node
 *
 * docs/tasks/34 item 4 — the OCR-not-ready requeue must be bounded.
 *
 * Why this matters more than an ordinary retry cap: the OCR branch pauses
 * claims for *every* worker in the process for 30s per requeue, and claims are
 * ordered `createdAt asc`, so an uncapped document returns to the head of the
 * queue each cycle. One permanently-unparseable document therefore stalls the
 * whole pipeline rather than merely failing itself.
 */

jest.mock('../../lib/redis', () => ({
  getRedis: jest.fn(async () => null),
  isRedisAvailable: jest.fn(async () => false),
}));

jest.mock('../filings-cache', () => ({
  FilingsCacheService: class {
    async invalidateCase() {}
  },
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { ParsingWorker, resetOcrAttempts, getOcrAttempts } from '../parsing-worker';
import { OcrNotReadyError } from '../../lib/ingestion/errors';

function fakePrisma() {
  const updates: any[] = [];
  return {
    updates,
    client: {
      document: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ id: where.id, ...data });
          return { id: where.id };
        }),
        findUnique: jest.fn(async () => ({ caseId: 'case-1' })),
      },
    } as any,
  };
}

/** Reach the private method under test without exercising the poll loop. */
const process1 = (w: ParsingWorker, id: string, p: string) =>
  (w as any).processClaimedDocument(id, p);

describe('ParsingWorker — OCR requeue cap', () => {
  beforeEach(() => resetOcrAttempts());

  it('requeues up to maxRetries, then fails the document with a named cause', async () => {
    const { client, updates } = fakePrisma();
    const worker = new ParsingWorker(
      { workerId: 'w1', maxRetries: 2 },
      async () => {
        throw new OcrNotReadyError('no gpu-ready OCR endpoint');
      },
      client
    );

    await process1(worker, 'doc-1', '/x/motion.pdf');
    await process1(worker, 'doc-1', '/x/motion.pdf');
    expect(updates.map((u) => u.status)).toEqual(['QUEUED', 'QUEUED']);

    // Third failure is past the cap.
    await process1(worker, 'doc-1', '/x/motion.pdf');

    expect(updates).toHaveLength(3);
    expect(updates[2].status).toBe('ERROR');
    // The cause is named, not merely counted — a bare "failed" here would make
    // the cap indistinguishable from an ordinary parse failure.
    expect(updates[2].errorMessage).toMatch(/OCR not ready after 2 requeues/);
    expect(updates[2].errorMessage).toMatch(/no gpu-ready OCR endpoint/);
  });

  it('counts per document, so one bad document does not spend another one budget', async () => {
    const { client, updates } = fakePrisma();
    const worker = new ParsingWorker(
      { workerId: 'w1', maxRetries: 1 },
      async () => {
        throw new OcrNotReadyError('not ready');
      },
      client
    );

    await process1(worker, 'doc-a', '/a.pdf');
    await process1(worker, 'doc-b', '/b.pdf');
    await process1(worker, 'doc-a', '/a.pdf');

    expect(updates).toEqual([
      expect.objectContaining({ id: 'doc-a', status: 'QUEUED' }),
      expect.objectContaining({ id: 'doc-b', status: 'QUEUED' }),
      expect.objectContaining({ id: 'doc-a', status: 'ERROR' }),
    ]);
  });

  it('clears the count on success so a later requeue starts fresh', async () => {
    const { client } = fakePrisma();
    let fail = true;
    const worker = new ParsingWorker(
      { workerId: 'w1', maxRetries: 3 },
      async () => {
        if (fail) throw new OcrNotReadyError('not ready');
      },
      client
    );

    await process1(worker, 'doc-1', '/x.pdf');
    expect(getOcrAttempts('doc-1')).toBe(1);

    fail = false;
    await process1(worker, 'doc-1', '/x.pdf');
    expect(getOcrAttempts('doc-1')).toBe(0);
  });

  it('does not spend OCR budget on an ordinary parse failure — that is ERROR at once', async () => {
    const { client, updates } = fakePrisma();
    const worker = new ParsingWorker(
      { workerId: 'w1', maxRetries: 3 },
      async () => {
        throw new Error('pdf is corrupt');
      },
      client
    );

    await process1(worker, 'doc-1', '/x.pdf');

    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('ERROR');
    expect(getOcrAttempts('doc-1')).toBe(0);
  });
});
