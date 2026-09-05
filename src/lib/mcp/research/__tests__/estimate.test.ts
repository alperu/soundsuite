/** @jest-environment node */

import { estimateResearchSeconds, resolveEstimateTier, LOCAL_TIER_SECONDS } from '../estimate';
import { estimateSeconds, PROMOTE_THRESHOLD_SECONDS } from '../../routed/routing';

describe('estimateResearchSeconds', () => {
  it('keeps the cloud numbers identical to routed/routing so routing_explain is unchanged', () => {
    for (const tier of ['fast', 'deep', 'deep-report', 'deep-rlm'] as const) {
      const out = estimateResearchSeconds(tier, { provider: 'anthropic' });
      expect(out.estimatedSeconds).toBe(estimateSeconds(tier, { provider: 'anthropic' }));
    }
  });

  it('promotes local deep to a job — the v4 N-8 fix', () => {
    const cloud = estimateResearchSeconds('deep', { provider: 'anthropic' });
    expect(cloud.wouldPromoteToJob).toBe(false);

    const local = estimateResearchSeconds('deep', { provider: 'ollama' });
    expect(local.estimatedSeconds).toBe(LOCAL_TIER_SECONDS.deep);
    expect(local.estimatedSeconds).toBeGreaterThan(PROMOTE_THRESHOLD_SECONDS);
    expect(local.wouldPromoteToJob).toBe(true);
  });

  it('treats localOnly as local regardless of the provider field', () => {
    expect(estimateResearchSeconds('deep', { localOnly: true })).toEqual({
      estimatedSeconds: LOCAL_TIER_SECONDS.deep,
      wouldPromoteToJob: true,
    });
  });

  it('leaves local fast inline', () => {
    expect(estimateResearchSeconds('fast', { localOnly: true })).toEqual({
      estimatedSeconds: LOCAL_TIER_SECONDS.fast,
      wouldPromoteToJob: false,
    });
  });

  it('promotes a flagged tier to the slower row it implies', () => {
    expect(
      estimateResearchSeconds('deep', { localOnly: true, multiPass: true }).estimatedSeconds,
    ).toBe(LOCAL_TIER_SECONDS['deep-report']);
    expect(
      estimateResearchSeconds('fast', { localOnly: true, useRlm: true }).estimatedSeconds,
    ).toBe(LOCAL_TIER_SECONDS['deep-rlm']);
  });

  it('accepts the flags flat or nested under settings', () => {
    expect(estimateResearchSeconds('deep', { localOnly: true, settings: { multiPass: true } }).estimatedSeconds)
      .toBe(LOCAL_TIER_SECONDS['deep-report']);
  });

  it('defaults to the local table when no provider is given', () => {
    expect(estimateResearchSeconds('deep', {}).wouldPromoteToJob).toBe(true);
  });

  it('costs an unrouted auto request as deep', () => {
    expect(resolveEstimateTier('auto')).toBe('deep');
    expect(resolveEstimateTier(undefined)).toBe('deep');
    expect(estimateResearchSeconds('auto', { localOnly: true }).estimatedSeconds).toBe(LOCAL_TIER_SECONDS.deep);
  });
});
