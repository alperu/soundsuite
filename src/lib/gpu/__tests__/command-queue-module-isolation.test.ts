/**
 * @jest-environment node
 *
 * Regression test for a fleet-wide command-delivery outage: `waiters` in
 * command-queue.ts used to be a plain module-level Map. Next.js re-evaluates
 * this module in separate webpack layers (worker-init vs. an API route
 * handler), so `queueSidecarCommand` (called from worker-init) and
 * `reportCommandResult` (always called from the
 * /api/admin/gpu/sidecars/result route handler) observed two DIFFERENT Map
 * instances. The DB row updated fine — the sidecar really had polled and
 * reported back in a second or two — but `waiters.get(commandId)` in the
 * route-handler instance always missed, so the caller's promise was never
 * resolved and every HTTP-fallback command sat until its own 15s timer fired
 * and rejected with a misleading "sidecar did not poll in time" (it had).
 *
 * ws-relay.ts already solved this exact class of bug for its own
 * `pendingCommands`/`sidecars` maps via a `globalThis`-backed singleton (see
 * that file's module-isolation comment); this test locks the same invariant
 * for command-queue.ts's `waiters` map.
 */

jest.mock('@/lib/gpu/ws-relay', () => ({
  hasSidecarConnection: () => false,
  sendCommand: jest.fn(),
}));

describe('command-queue waiters map survives Next.js module isolation', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('lets a waiter registered in one module instance be resolved by a different instance', async () => {
    // Fresh in-memory "DB" shared by both instances, the way Prisma's real
    // client is shared across webpack layers in production.
    const store = new Map<string, any>();
    let idCounter = 0;
    jest.doMock('@/lib/db/prisma', () => ({
      prisma: {
        sidecarCommand: {
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `cmd-${++idCounter}`, createdAt: new Date(), ...data };
            store.set(row.id, row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const row = store.get(where.id);
            Object.assign(row, data);
            return row;
          }),
        },
      },
    }));

    let modA: typeof import('../command-queue');
    let modB: typeof import('../command-queue');
    jest.isolateModules(() => {
      modA = require('../command-queue');
    });
    jest.isolateModules(() => {
      modB = require('../command-queue');
    });

    // Sanity: isolateModules really did give us two distinct module
    // instances (this is the setup that reproduced the bug — without it the
    // test would pass for the wrong reason).
    expect(modA!.queueSidecarCommand).not.toBe(modB!.queueSidecarCommand);

    // modA plays the role of worker-init: it queues a command and awaits
    // the result the way FleetRouter's sendToSidecar does.
    const resultPromise = modA!.queueSidecarCommand(
      'http://sidecar-under-test:8098',
      'acquire',
      { role: 'embedding' },
      5_000,
    );

    // The sidecar polled and reported back quickly — but through the route
    // handler, i.e. modB.
    const [commandId] = store.keys();
    await modB!.reportCommandResult(commandId, { activeRequests: 1 });

    // Before the fix this hangs until the 5s timer above rejects with
    // "did not poll in time" even though the result was reported instantly.
    await expect(resultPromise).resolves.toEqual({ activeRequests: 1 });
  });
});
