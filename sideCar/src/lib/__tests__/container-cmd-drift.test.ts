/**
 * Drift detection must notice a Cmd that should NOT be there.
 *
 * The check was gated on `expected.Cmd` being truthy, so "I expect no Cmd" and
 * "I have no expectation about Cmd" were indistinguishable and the comparison
 * was skipped. Containers created by sidecar 2.4.8/2.4.9 for ss-rlm-sandbox had
 * a vLLM command line baked in at creation:
 *
 *   ["deepseek/deepseek-v4-flash", "--host", "0.0.0.0", "--port", "8101"]
 *
 * A container keeps its Cmd for life — pulling a corrected image does not
 * change it — so with RestartPolicy `unless-stopped` they restart-looped
 * forever while drift reported nothing. Three of five hosts sat in that loop.
 *
 * ensureContainerForRole already removes and recreates on drift
 * (containers.ts:191), and checks whenever the container EXISTS regardless of
 * status — so a restart-looping container is reached. The only thing missing
 * was for the drift to be detected at all. That is what this guards.
 */

import { state } from '../state';
import { buildExpectedConfig, detectConfigDrift, type ContainerState } from '../docker';

const STALE_VLLM_CMD = ['deepseek/deepseek-v4-flash', '--host', '0.0.0.0', '--port', '8101'];

function containerState(role: string, over: Partial<ContainerState> = {}): ContainerState {
  return {
    exists: true,
    name: state.registry[role].containerName,
    status: 'running',
    image: state.registry[role].image,
    cmd: undefined,
    env: [],
    hasGpuDeviceRequest: false,
    hasInit: true,
    ...over,
  } as ContainerState;
}

describe('ss-rlm-sandbox expects NO Cmd', () => {
  it('buildExpectedConfig sets no Cmd, and says so explicitly', () => {
    const cfg = buildExpectedConfig('rlm-sandbox');
    expect(cfg.Cmd).toBeUndefined();
    // The flag is the point: absence must be an assertion, not a gap.
    expect(cfg.ExpectsNoCmd).toBe(true);
  });

  it('flags a container still carrying the stale vLLM command line', () => {
    const { hasDrift, drifts } = detectConfigDrift(
      containerState('rlm-sandbox', { cmd: STALE_VLLM_CMD, status: 'restarting' }),
      buildExpectedConfig('rlm-sandbox'),
    );
    expect(hasDrift).toBe(true);
    expect(drifts.join(' ')).toMatch(/cmd:/);
    expect(drifts.join(' ')).toMatch(/deepseek/);
  });

  it('is clean when the container has no Cmd', () => {
    const { hasDrift } = detectConfigDrift(
      containerState('rlm-sandbox', { cmd: undefined }),
      buildExpectedConfig('rlm-sandbox'),
    );
    expect(hasDrift).toBe(false);
  });

  it('treats an empty Cmd array as absence, not a leftover', () => {
    const { hasDrift } = detectConfigDrift(
      containerState('rlm-sandbox', { cmd: [] }),
      buildExpectedConfig('rlm-sandbox'),
    );
    expect(hasDrift).toBe(false);
  });
});

describe('roles that DO need a command line are unaffected', () => {
  it('reranker still expects its vLLM Cmd', () => {
    const cfg = buildExpectedConfig('reranker');
    expect(cfg.ExpectsNoCmd).toBeUndefined();
    expect(Array.isArray(cfg.Cmd)).toBe(true);
    expect(cfg.Cmd![0]).toBe(state.registry['reranker'].model);
  });

  it('reranker drifts when its Cmd went missing', () => {
    const { hasDrift } = detectConfigDrift(
      containerState('reranker', { cmd: undefined, hasGpuDeviceRequest: true }),
      buildExpectedConfig('reranker'),
    );
    expect(hasDrift).toBe(true);
  });
});
