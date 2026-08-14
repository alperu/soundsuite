import { commitLinkBatch, type LinkPlan } from '../link-rules';

/**
 * The batch layer's job is to make N writes behave like one action: one
 * refetch, one banner, one undo. These tests pin the parts that are easy to get
 * subtly wrong — a failure stopping the run, an undo replaying in the order the
 * writes happened, or a refetch firing per item.
 *
 * `commitOne` is injected, so no network is involved: what is under test is the
 * runner, not the write.
 */

function refPlan(id: string, targetId: string, replaces?: string): LinkPlan {
  return {
    type: 'ref',
    slot: 'respondingTo',
    kind: 'motion',
    id,
    targetId,
    description: 'responds to',
    ...(replaces ? { replaces } : {}),
  };
}

describe('commitLinkBatch', () => {
  it('runs every item even after one fails, and counts both', async () => {
    const seen: string[] = [];
    const result = await commitLinkBatch(
      [refPlan('a', 'm1'), refPlan('b', 'm2'), refPlan('c', 'm3')],
      async plan => {
        seen.push(plan.type === 'ref' ? plan.id : '?');
        return plan.type === 'ref' && plan.id === 'b'
          ? { ok: false, message: 'nope' }
          : { ok: true, message: 'linked' };
      },
    );
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.linked).toBe(2);
    expect(result.failed).toBe(1);
    // Failures are kept with their message, so the banner can name them.
    expect(result.items.find(i => !i.ok)?.message).toBe('nope');
  });

  it('commits sequentially, not in parallel', async () => {
    const order: string[] = [];
    await commitLinkBatch([refPlan('a', 'm1'), refPlan('b', 'm2')], async plan => {
      const id = plan.type === 'ref' ? plan.id : '?';
      order.push(`start ${id}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push(`end ${id}`);
      return { ok: true, message: 'linked' };
    });
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('announces exactly one refetch for the whole run', async () => {
    const events: string[] = [];
    const listener = () => events.push('entity-updated');
    window.addEventListener('entity-updated', listener);
    await commitLinkBatch([refPlan('a', 'm1'), refPlan('b', 'm2'), refPlan('c', 'm3')], async () => ({
      ok: true,
      message: 'linked',
    }));
    window.removeEventListener('entity-updated', listener);
    expect(events).toHaveLength(1);
  });

  it('stays quiet when nothing landed', async () => {
    const events: string[] = [];
    const listener = () => events.push('entity-updated');
    window.addEventListener('entity-updated', listener);
    const result = await commitLinkBatch([refPlan('a', 'm1')], async () => ({
      ok: false,
      message: 'nope',
    }));
    window.removeEventListener('entity-updated', listener);
    expect(events).toHaveLength(0);
    expect(result.linked).toBe(0);
  });

  it('undoes only what landed, newest first', async () => {
    const undone: string[] = [];
    // The undo path calls the real unlink/relink helpers, so stub the network
    // underneath them and watch the order and shape of the calls.
    const originalFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id: string;
        patch: Record<string, unknown>;
      };
      undone.push(`${body.id}=${JSON.stringify(body.patch.respondingTo)}`);
      return {
        ok: true,
        json: async () => ({ rows: [{ id: body.id }] }),
      };
    }) as unknown as typeof fetch;

    const result = await commitLinkBatch(
      [refPlan('a', 'm1'), refPlan('b', 'm2'), refPlan('c', 'm3', 'older')],
      async plan =>
        plan.type === 'ref' && plan.id === 'b'
          ? { ok: false, message: 'nope' }
          : { ok: true, message: 'linked' },
    );
    const reversal = await result.undo();
    global.fetch = originalFetch;

    // c first (newest), then a. b never landed, so it is never undone.
    expect(undone).toEqual(['c="older"', 'a=null']);
    // A write that REPLACED an earlier ref is undone by restoring it, not by
    // clearing the slot — clearing would destroy data the batch never owned.
    expect(reversal.linked).toBe(2);
  });
});
