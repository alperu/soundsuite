/** @jest-environment node */
/**
 * Task #45 — self-restart target resolution.
 *
 * The whole point of these tests is that nothing here ever talks to Docker.
 * `resolveSelfContainer` takes injected probes, and `restartContainer`'s HTTP
 * is intercepted at the `http` module, so no restart is ever issued against a
 * real daemon.
 *
 * Container IDs below are invented hex. No real host identifiers appear.
 */

import type { SelfProbes } from '@/lib/docker';
import type { EventEmitter as EventEmitterType } from 'events';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

/** Intercept http.request so restartContainer's call is observed, never sent. */
const httpCalls: Array<{ method?: string; path?: string }> = [];
let httpStatus = 204;
let httpBody = '';

jest.mock('http', () => {
  const { EventEmitter } = require('events');
  return {
    request: (opts: { method?: string; path?: string }, cb?: (res: unknown) => void) => {
      httpCalls.push({ method: opts.method, path: opts.path });
      const req = new EventEmitter() as EventEmitterType & {
        end: () => void; write: () => void; setTimeout: () => void; destroy: () => void;
      };
      req.end = () => {
        const res = new EventEmitter() as EventEmitterType & { statusCode?: number };
        res.statusCode = httpStatus;
        setImmediate(() => {
          cb?.(res);
          if (httpBody) res.emit('data', Buffer.from(httpBody));
          res.emit('end');
        });
      };
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      return req;
    },
  };
});

// Docker reachability in the real module consults fs for the socket path.
jest.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => { throw new Error('not stubbed — tests inject probes instead'); },
}));

const SELF_ID = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';
const OTHER_ID = '9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff';

/** mountinfo line shaped like Docker's /etc/hostname bind mount. */
function mountinfoWith(...ids: string[]): string {
  return ids
    .map(
      (id, i) =>
        `${600 + i} 590 0:56 /var/lib/docker/containers/${id}/hostname /etc/hostname ` +
        'rw,relatime - ext4 /dev/vda1 rw',
    )
    .join('\n');
}

function probes(over: Partial<SelfProbes> = {}): SelfProbes {
  return {
    readMountinfo: () => mountinfoWith(SELF_ID),
    readHostname: () => SELF_ID.slice(0, 12),
    dockerEnvFileExists: () => true,
    dockerAvailable: () => true,
    inspectName: async () => 'ss-sidecar',
    ...over,
  };
}

describe('resolveSelfContainer', () => {
  let resolveSelfContainer: typeof import('@/lib/docker').resolveSelfContainer;
  let restartContainer: typeof import('@/lib/docker').restartContainer;
  let managedContainerNames: typeof import('@/lib/docker').managedContainerNames;

  beforeEach(() => {
    jest.resetModules();
    httpCalls.length = 0;
    httpStatus = 204;
    httpBody = '';
    const mod = require('@/lib/docker');
    resolveSelfContainer = mod.resolveSelfContainer;
    restartContainer = mod.restartContainer;
    managedContainerNames = mod.managedContainerNames;
  });

  it('resolves self from mountinfo and corroborates with the hostname', async () => {
    const r = await resolveSelfContainer(probes());
    expect(r).toMatchObject({
      ok: true,
      id: SELF_ID,
      shortId: SELF_ID.slice(0, 12),
      name: 'ss-sidecar',
      source: 'mountinfo',
      corroborated: true,
    });
  });

  it('falls back to the hostname short ID when mountinfo carries no container path', async () => {
    const r = await resolveSelfContainer(
      probes({ readMountinfo: () => '600 590 0:56 / / rw - ext4 /dev/vda1 rw' }),
    );
    expect(r).toMatchObject({ ok: true, id: SELF_ID.slice(0, 12), source: 'hostname', corroborated: false });
  });

  it('refuses when mountinfo and the hostname name different containers', async () => {
    const r = await resolveSelfContainer(probes({ readHostname: () => OTHER_ID.slice(0, 12) }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('sources-disagree');
    // Both identities must be named, per the refusal contract.
    expect(r.detail).toContain(SELF_ID.slice(0, 12));
    expect(r.detail).toContain(OTHER_ID.slice(0, 12));
  });

  it('refuses when mountinfo names more than one container', async () => {
    const r = await resolveSelfContainer(probes({ readMountinfo: () => mountinfoWith(SELF_ID, OTHER_ID) }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('sources-disagree');
  });

  it('refuses with docker-unreachable when the socket is not usable', async () => {
    const r = await resolveSelfContainer(probes({ dockerAvailable: () => false }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('docker-unreachable');
    expect(r.detail).toContain('docker.sock');
  });

  it('refuses with not-in-container when running bare-metal on the host', async () => {
    const r = await resolveSelfContainer(
      probes({ readMountinfo: () => null, readHostname: () => 'workstation-1', dockerEnvFileExists: () => false }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('not-in-container');
  });

  it('refuses with self-unresolvable inside a container it cannot identify', async () => {
    const r = await resolveSelfContainer(
      probes({ readMountinfo: () => '600 590 0:56 / / rw - overlay overlay rw', readHostname: () => 'renamed-host' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self-unresolvable');
  });

  it('refuses with self-unresolvable when Docker has no such container', async () => {
    const r = await resolveSelfContainer(probes({ inspectName: async () => null }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self-unresolvable');
  });

  // THE load-bearing test: a resolved identity that is a container the sidecar
  // manages must never become a restart target.
  it.each([
    'ss-embedding',
    'ss-code-embedding',
    'ss-completion',
    'ss-ocr',
    'ss-reranker',
    'ss-rlm',
    'ss-cuda',
    'vllm-reranker', // the CONTAINER_NAME default
  ])('refuses when the resolved container is the managed sibling %s', async (sibling) => {
    const r = await resolveSelfContainer(probes({ inspectName: async () => sibling }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('resolved-is-managed');
    expect(r.detail).toContain(sibling);
    expect(r.detail).toContain(SELF_ID.slice(0, 12));
  });

  it('does not refuse merely because the name starts with the ss- prefix', async () => {
    // ss-sidecar shares the prefix with every model container; a prefix rule
    // would refuse every legitimate restart.
    const r = await resolveSelfContainer(probes({ inspectName: async () => 'ss-sidecar' }));
    expect(r.ok).toBe(true);
    expect(managedContainerNames()).not.toContain('ss-sidecar');
  });

  it('lists every registry container name plus CONTAINER_NAME as managed', () => {
    const managed = managedContainerNames();
    expect(managed).toEqual(expect.arrayContaining(['ss-reranker', 'ss-ocr', 'ss-embedding']));
  });
});

describe('restartContainer', () => {
  let restartContainer: typeof import('@/lib/docker').restartContainer;

  beforeEach(() => {
    jest.resetModules();
    httpCalls.length = 0;
    httpStatus = 204;
    httpBody = '';
    restartContainer = require('@/lib/docker').restartContainer;
  });

  it('targets the resolved ID via the restart endpoint, not stop-then-start', async () => {
    await expect(restartContainer(SELF_ID)).resolves.toBe('restarted');
    expect(httpCalls).toEqual([{ method: 'POST', path: `/containers/${SELF_ID}/restart?t=10` }]);
    // Explicitly: no stop and no start call was made.
    expect(httpCalls.some((c) => /\/(stop|start)$/.test(c.path || ''))).toBe(false);
  });

  it('passes the stop grace period through', async () => {
    await restartContainer(SELF_ID, 30);
    expect(httpCalls[0].path).toBe(`/containers/${SELF_ID}/restart?t=30`);
  });

  it('throws a named error when the container does not exist', async () => {
    httpStatus = 404;
    httpBody = '{"message":"No such container"}';
    await expect(restartContainer(SELF_ID)).rejects.toThrow('no such container');
  });
});
