/** @jest-environment node */
/**
 * Regression cover for the `activeRequests` leak measured on 2026-09-15: two
 * macOS host-ollama hosts reported 6,548 and 6,328 concurrent requests while
 * serving a handful, because every successful acquire incremented a counter
 * that only a cooperative master ever decremented.
 */
import { state } from '@/lib/state';
import {
  openLease,
  closeLease,
  closeLeasesForOwner,
  closeAllLeases,
  touchRoleLeases,
  sweepExpiredLeases,
  countOpenLeases,
  leaseSummary,
  __resetLeasesForTest,
} from '@/lib/leases';

const ROLE = 'code-embedding';

describe('role leases', () => {
  beforeEach(() => {
    __resetLeasesForTest();
    for (const r of Object.keys(state.perRole)) {
      state.perRole[r].activeRequests = 0;
      if (state.perRole[r].idleTimer) {
        clearTimeout(state.perRole[r].idleTimer!);
        state.perRole[r].idleTimer = null;
      }
    }
    delete process.env.SS_LEASE_TTL_MS;
  });

  afterEach(() => {
    __resetLeasesForTest();
    delete process.env.SS_LEASE_TTL_MS;
  });

  it('derives activeRequests from open leases', () => {
    openLease(ROLE, 'master-a');
    openLease(ROLE, 'master-a');
    expect(state.perRole[ROLE].activeRequests).toBe(2);
    expect(countOpenLeases(ROLE)).toBe(2);
  });

  it('closes a specific lease by id and ignores a duplicate release', () => {
    const a = openLease(ROLE, 'master-a');
    openLease(ROLE, 'master-a');

    expect(closeLease(ROLE, a)).toEqual({ closed: true, remaining: 1 });
    // The double-decrement the bare counter allowed: releasing the same lease
    // twice must not take the count below the work actually outstanding.
    expect(closeLease(ROLE, a)).toEqual({ closed: false, remaining: 1 });
    expect(state.perRole[ROLE].activeRequests).toBe(1);
  });

  it('closes the oldest lease when the master sends no lease id', () => {
    openLease(ROLE, 'legacy-master');
    openLease(ROLE, 'legacy-master');
    expect(closeLease(ROLE).remaining).toBe(1);
    expect(closeLease(ROLE).remaining).toBe(0);
    // Never negative, however many stray releases arrive.
    expect(closeLease(ROLE).remaining).toBe(0);
  });

  it('expires leases the master never released', () => {
    process.env.SS_LEASE_TTL_MS = '1000';
    openLease(ROLE, 'forgetful-master');
    openLease(ROLE, 'forgetful-master');
    expect(state.perRole[ROLE].activeRequests).toBe(2);

    // Nothing expires before the TTL.
    expect(sweepExpiredLeases()).toBe(0);
    expect(state.perRole[ROLE].activeRequests).toBe(2);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
    try {
      expect(sweepExpiredLeases()).toBe(2);
      expect(state.perRole[ROLE].activeRequests).toBe(0);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  it('a touched lease survives a TTL that would otherwise expire it', () => {
    process.env.SS_LEASE_TTL_MS = '1000';
    openLease(ROLE, 'heartbeating-master');

    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 5_000);
    try {
      // The master says the work is still live before the sweep runs — this is
      // what keeps an 8-hour re-embed alive under any finite TTL.
      expect(touchRoleLeases(ROLE)).toBe(1);
      expect(sweepExpiredLeases()).toBe(0);
      expect(state.perRole[ROLE].activeRequests).toBe(1);

      spy.mockReturnValue(realNow + 11_000);
      expect(sweepExpiredLeases()).toBe(1);
      expect(state.perRole[ROLE].activeRequests).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('TTL of 0 disables expiry', () => {
    process.env.SS_LEASE_TTL_MS = '0';
    openLease(ROLE, 'master-a');
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000);
    try {
      expect(sweepExpiredLeases()).toBe(0);
      expect(state.perRole[ROLE].activeRequests).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('releases every lease a disconnected master still owed', () => {
    openLease(ROLE, 'master-gone');
    openLease('embedding', 'master-gone');
    openLease(ROLE, 'master-live');

    expect(closeLeasesForOwner('master-gone')).toBe(2);
    expect(state.perRole[ROLE].activeRequests).toBe(1);
    expect(state.perRole.embedding.activeRequests).toBe(0);
    // The surviving master's lease is untouched.
    expect(countOpenLeases(ROLE)).toBe(1);
  });

  it('clears leases for reset-counters so the count cannot come back', () => {
    openLease(ROLE, 'master-a');
    openLease(ROLE, 'master-b');
    expect(closeAllLeases(ROLE)).toBe(2);
    expect(state.perRole[ROLE].activeRequests).toBe(0);
    // Zeroing the field alone used to be undone by the next recompute.
    expect(countOpenLeases(ROLE)).toBe(0);
  });

  it('reports open leases and the oldest age per role', () => {
    openLease(ROLE, 'master-a');
    openLease('embedding', 'master-a');
    const summary = leaseSummary();
    expect(summary.total).toBe(2);
    expect(summary.byRole[ROLE].open).toBe(1);
    expect(summary.byRole.embedding.open).toBe(1);
    expect(summary.ttlMs).toBeGreaterThan(0);
  });
});
