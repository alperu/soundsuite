/**
 * Asking a sidecar for a role it does not run must say so.
 *
 * `handleAcquire` gates on `role && state.registry[role]`. Everything else fell
 * into a branch commented "Legacy: no role specified" — true for `!role`, but
 * the condition also catches a role that is simply not in this host's registry.
 * That branch operates on `state.CONTAINER_NAME`, whose default is the
 * historical `'vllm-reranker'`, so the reply was:
 *
 *   Container "vllm-reranker" not found
 *
 * naming a container nobody configured, on a host that was never meant to have
 * it. Observed 2026-09-16 when something asked an ocr+rlm-sandbox host to
 * acquire `reranker` — harmless, since the caller failed over, but it sends the
 * reader hunting a container that should not exist.
 *
 * The genuinely-no-role legacy path still has to work, for a pre-role-registry
 * master. Both halves are asserted.
 */

import { state } from '../state';
import { handleAcquire } from '../handlers';

const savedRegistry = { ...state.registry };

beforeEach(() => {
  // A host that runs ocr and the sandbox — and NOT the reranker. This is the
  // shape of one real host on the live fleet.
  for (const k of Object.keys(state.registry)) delete state.registry[k];
  state.registry['ocr'] = { ...savedRegistry['ocr'] };
  state.registry['rlm-sandbox'] = { ...savedRegistry['rlm-sandbox'] };
  state.activeRequests = 0;
});

afterAll(() => {
  for (const k of Object.keys(state.registry)) delete state.registry[k];
  Object.assign(state.registry, savedRegistry);
});

describe('acquire for a role this host does not run', () => {
  it('names the role and what IS assigned — never a legacy container', async () => {
    const out = await handleAcquire('reranker');
    const err = String(out.error ?? '');

    expect(err).toContain('reranker');
    expect(err).toMatch(/not assigned on this sidecar/i);
    // The whole point: the old message named a container, not the condition.
    expect(err).not.toContain('vllm-reranker');
    expect(err).not.toMatch(/not found/i);
  });

  it('lists the roles the host actually has, so the caller can re-route', async () => {
    const out = await handleAcquire('reranker');
    expect(out.assignedRoles).toEqual(['ocr', 'rlm-sandbox']);
    expect(String(out.error)).toContain('ocr');
  });

  it('does not touch the legacy global counter', async () => {
    // The old path incremented state.activeRequests for a role it could not
    // serve, so a rejected acquire inflated the host's load signal and biased
    // routing away from a host that was in fact idle.
    await handleAcquire('reranker');
    expect(state.activeRequests).toBe(0);
  });

  it('opens no lease for a role it refused', async () => {
    const out = await handleAcquire('reranker');
    expect(out.leaseId).toBeUndefined();
  });
});

describe('the genuinely-legacy path still works', () => {
  it('a call with NO role still enters the legacy branch, not the new rejection', async () => {
    const out = await handleAcquire();

    // The legacy branch bumps the global counter — that is how an old master
    // calling /acquire with an empty body signals load. Reaching it is the
    // property under test.
    expect(state.activeRequests).toBe(1);

    // It may then fail to find state.CONTAINER_NAME (no docker in this
    // environment, and the default name is the historical 'vllm-reranker').
    // That is PRE-EXISTING legacy behaviour and not what this change touches.
    // What matters is that a no-role call is NOT diverted into the new
    // "not assigned on this sidecar" rejection, which would break that master.
    expect(String(out.error ?? '')).not.toMatch(/not assigned on this sidecar/i);
  });
});
