/**
 * @jest-environment node
 *
 * Task 43: a host's provisioning row is keyed by its advertised address, so when
 * the address changes the row has to be re-keyed. The automatic path in
 * ws-relay's register handler did that with a bare `upsert` onto the new key,
 * which silently overwrote whatever row already sat there.
 *
 * These drive the shared move directly. Addresses are RFC 5737 documentation
 * ranges and invented hostnames.
 */

import type { HostProvisioningRecord } from '@/lib/db/host-provisioning';

// A real in-memory store rather than bare jest.fn()s: the point of every case
// below is which rows exist afterwards, so the fake has to actually hold them.
const rows = new Map<string, HostProvisioningRecord>();
const writes: string[] = [];

jest.mock('@/lib/db/host-provisioning', () => ({
  normalizeSidecarUrl: (u: string) => (u || '').trim().replace(/\/+$/, ''),
  getProvisioning: jest.fn(async (url: string) => rows.get(url) ?? null),
  upsertProvisioning: jest.fn(async (rec: HostProvisioningRecord) => {
    writes.push(`upsert:${rec.sidecarUrl}`);
    rows.set(rec.sidecarUrl, { ...rec });
    return { ...rec };
  }),
  deleteProvisioning: jest.fn(async (url: string) => {
    writes.push(`delete:${url}`);
    rows.delete(url);
  }),
}));

import { moveProvisioningAddress } from '../provisioning-address-move';
import * as hp from '@/lib/db/host-provisioning';

const OLD = 'http://192.0.2.10:8098';
const NEW = 'http://192.0.2.44:8098';
const OTHER = 'http://192.0.2.77:8098';

function row(url: string, over: Partial<HostProvisioningRecord> = {}): HostProvisioningRecord {
  return {
    sidecarUrl: url,
    hostOsOverride: 'mac-docker-ollama',
    masterUrlForHost: 'http://master.invalid:3000',
    masterWsPortForHost: 3002,
    notes: null,
    ...over,
  };
}

beforeEach(() => {
  rows.clear();
  writes.length = 0;
  jest.clearAllMocks();
});

describe('a host that changed address', () => {
  it('carries its overrides to the new address and leaves nothing at the old one', async () => {
    rows.set(OLD, row(OLD, { notes: 'lab bench' }));

    const result = await moveProvisioningAddress(OLD, NEW);

    expect(result.status).toBe('moved');
    expect(rows.has(OLD)).toBe(false);
    expect(rows.get(NEW)).toMatchObject({
      sidecarUrl: NEW,
      hostOsOverride: 'mac-docker-ollama',
      masterUrlForHost: 'http://master.invalid:3000',
      masterWsPortForHost: 3002,
      notes: 'lab bench',
    });
  });

  it('writes the new row before removing the old one, so a crash cannot lose the overrides', async () => {
    rows.set(OLD, row(OLD));
    await moveProvisioningAddress(OLD, NEW);
    expect(writes).toEqual([`upsert:${NEW}`, `delete:${OLD}`]);
  });

  it('ignores a trailing slash rather than treating it as a different address', async () => {
    rows.set(OLD, row(OLD));
    const result = await moveProvisioningAddress(OLD, `${OLD}/`);
    expect(result.status).toBe('noop');
    expect(writes).toEqual([]);
  });
});

describe('moving onto an address another row already holds', () => {
  it('refuses with a named conflict and merges nothing', async () => {
    rows.set(OLD, row(OLD, { hostOsOverride: 'mac-docker-ollama' }));
    rows.set(NEW, row(NEW, { hostOsOverride: 'windows-docker-wsl2', notes: 'other host' }));

    const result = await moveProvisioningAddress(OLD, NEW);

    expect(result).toEqual({ status: 'conflict', conflictWith: NEW });
    // Both rows survive untouched — the whole point is that the occupant's OS
    // pin and master URL are not silently eaten.
    expect(rows.get(NEW)).toMatchObject({ hostOsOverride: 'windows-docker-wsl2', notes: 'other host' });
    expect(rows.get(OLD)).toMatchObject({ hostOsOverride: 'mac-docker-ollama' });
    expect(writes).toEqual([]);
  });

  it('still refuses when two hosts swap addresses, rather than clobbering one', async () => {
    rows.set(OLD, row(OLD, { notes: 'host A' }));
    rows.set(NEW, row(NEW, { notes: 'host B' }));

    expect((await moveProvisioningAddress(OLD, NEW)).status).toBe('conflict');
    expect((await moveProvisioningAddress(NEW, OLD)).status).toBe('conflict');
    expect(rows.get(OLD)?.notes).toBe('host A');
    expect(rows.get(NEW)?.notes).toBe('host B');
  });
});

describe('the register path calls this on every address move, so it has to be cheap', () => {
  it('issues no write when the host has no provisioning row', async () => {
    const result = await moveProvisioningAddress(OLD, NEW);
    expect(result).toEqual({ status: 'no-row' });
    expect(writes).toEqual([]);
    expect(hp.upsertProvisioning).not.toHaveBeenCalled();
  });

  it('is idempotent: repeating a completed move writes nothing further', async () => {
    rows.set(OLD, row(OLD));
    await moveProvisioningAddress(OLD, NEW);
    writes.length = 0;

    // The steady state after a move is a row at the destination and none at the
    // source. A sidecar reconnecting in a loop must not turn that into a write
    // per reconnect, nor into a spurious conflict against its own row.
    const again = await moveProvisioningAddress(OLD, NEW);
    expect(again).toEqual({ status: 'no-row' });
    expect(writes).toEqual([]);
  });

  it('does nothing when the address did not actually change', async () => {
    rows.set(OLD, row(OLD));
    const result = await moveProvisioningAddress(OLD, OLD);
    expect(result).toEqual({ status: 'noop' });
    expect(writes).toEqual([]);
    expect(hp.getProvisioning).not.toHaveBeenCalled();
  });

  it('treats an empty address as nothing to do instead of throwing', async () => {
    expect((await moveProvisioningAddress('', NEW)).status).toBe('noop');
    expect((await moveProvisioningAddress(OLD, '')).status).toBe('noop');
    expect(writes).toEqual([]);
  });
});

describe('when the database fails', () => {
  it('reports the error instead of throwing, so registration is never blocked', async () => {
    rows.set(OLD, row(OLD));
    (hp.upsertProvisioning as jest.Mock).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    const result = await moveProvisioningAddress(OLD, NEW);

    expect(result.status).toBe('error');
    expect(result).toMatchObject({ error: expect.stringContaining('SQLITE_BUSY') });
    // The old row is still there: nothing was deleted on the failing path.
    expect(rows.has(OLD)).toBe(true);
  });

  it('does not delete the old row when the read of the destination fails', async () => {
    rows.set(OLD, row(OLD));
    (hp.getProvisioning as jest.Mock)
      .mockImplementationOnce(async () => rows.get(OLD) ?? null)
      .mockRejectedValueOnce(new Error('read failed'));

    expect((await moveProvisioningAddress(OLD, OTHER)).status).toBe('error');
    expect(rows.has(OLD)).toBe(true);
    expect(rows.has(OTHER)).toBe(false);
  });
});
