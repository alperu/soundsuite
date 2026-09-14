/** @jest-environment node */
/**
 * Next.js bundles `instrumentation.ts` and route handlers in separate webpack
 * layers, so every shared module is instantiated twice per process. The gossip
 * client (started from instrumentation) and `/api/masters` (a route) must still
 * see ONE `state`, or the UI reports "disconnected / never" for a master the
 * relay is heartbeating to — and a dial from the routes' copy opens a rival
 * socket under the same agentUrl. `jest.isolateModules` is the closest stand-in
 * for a second layer: a fresh module registry, same `globalThis`.
 */
import { processGlobal } from '@/lib/process-global';

describe('processGlobal', () => {
  it('returns the same value for the same key across module instances', () => {
    const a = processGlobal('test-key', () => ({ n: 1 }));
    a.n = 42;
    let b: { n: number } | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('@/lib/process-global') as typeof import('@/lib/process-global');
      b = fresh.processGlobal('test-key', () => ({ n: 1 }));
    });
    expect(b).toBe(a);
    expect(b?.n).toBe(42);
  });

  it('shares sidecar `state` between two module instances', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const first = require('@/lib/state') as typeof import('@/lib/state');
    first.ensureMaster('http://master.example:3000', { wsPort: 3002 });
    let second: typeof import('@/lib/state') | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      second = require('@/lib/state') as typeof import('@/lib/state');
    });
    expect(second).toBeDefined();
    expect(second!.state).toBe(first.state);
    expect(second!.state.masters.get('http://master.example:3000')).toBe(
      first.state.masters.get('http://master.example:3000'),
    );
  });

  it('shares the boot-event ring buffer between two module instances', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const first = require('@/lib/boot-events') as typeof import('@/lib/boot-events');
    first.emitBootEvent('seen from the first instance');
    let events: ReturnType<typeof first.getBootEvents> = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const second = require('@/lib/boot-events') as typeof import('@/lib/boot-events');
      events = second.getBootEvents();
    });
    expect(events.map((e) => e.message)).toContain('seen from the first instance');
  });
});
