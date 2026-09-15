/**
 * The role-assign Port column used to be a static table keyed on role name
 * alone, so it showed 11435/11436/11437 for roles that on a Mac all bind
 * 11434. The port is a function of (role, runtime), not of role.
 *
 * Fixtures are the shapes observed on the live fleet: a Mac reporting three
 * host-Ollama roles collapsed onto one port, and a Windows host reporting
 * genuinely distinct per-role Docker ports.
 */
import { defaultRuntimeForRow, portForRuntime, reportedPortFor } from '@/components/admin-role-assignments';

const OLLAMA_ROLES = ['ss-embedding', 'ss-code-embedding', 'ss-completion', 'ss-ocr'];

// Mac: one native Ollama, every role on 11434, told apart by model.
const macSidecar: any = {
  url: 'http://192.0.2.20:8098',
  hostname: 'mac-1',
  status: 'connected',
  os: 'mac-docker-ollama',
  containers: {
    embedding: { image: 'host-ollama', config: { port: 11434 } },
    'code-embedding': { image: 'host-ollama', config: { port: 11434 } },
    completion: { image: 'host-ollama', config: { port: 11434 } },
    cuda: { image: null, config: { port: 0 } },
  },
};

// Windows: Docker-managed Ollama containers, one port each.
const winSidecar: any = {
  url: 'http://192.0.2.21:8098',
  hostname: 'win-1',
  status: 'connected',
  os: 'windows-docker-wsl2',
  containers: {
    embedding: { image: 'ollama/ollama', config: { port: 11434 } },
    'code-embedding': { image: 'ollama/ollama', config: { port: 11437 } },
    ocr: { image: 'ollama/ollama', config: { port: 11436 } },
  },
};

describe('portForRuntime', () => {
  it('collapses every host-runtime Ollama role onto the single native port', () => {
    for (const role of OLLAMA_ROLES) {
      expect(portForRuntime(role, 'host')).toBe(11434);
    }
  });

  it('collapses every DMR role onto the single DMR endpoint', () => {
    expect(portForRuntime('ss-reranker', 'docker-model-runner')).toBe(12434);
    expect(portForRuntime('ss-rlm', 'docker-model-runner')).toBe(12434);
    expect(portForRuntime('ss-embedding', 'docker-model-runner')).toBe(12434);
  });

  it('keeps distinct per-role ports for the Docker-managed runtimes', () => {
    expect(portForRuntime('ss-code-embedding', 'docker-ollama')).toBe(11437);
    expect(portForRuntime('ss-ocr', 'docker-ollama')).toBe(11436);
    expect(portForRuntime('ss-reranker', 'docker-vllm')).toBe(8099);
  });

  it('is undefined for a role it has no port for', () => {
    expect(portForRuntime('ss-unknown', 'docker-ollama')).toBeUndefined();
  });
});

describe('reportedPortFor', () => {
  it('prefers the port the sidecar resolved, keyed by role without the ss- prefix', () => {
    expect(reportedPortFor(macSidecar, 'ss-code-embedding', 'host')).toBe(11434);
    expect(reportedPortFor(winSidecar, 'ss-code-embedding', 'docker-ollama')).toBe(11437);
  });

  it('ignores a reported port from a different runtime than the one selected', () => {
    // The radios describe a future state; a live host-Ollama port says nothing
    // about what Docker Ollama would bind.
    expect(reportedPortFor(macSidecar, 'ss-embedding', 'docker-ollama')).toBeUndefined();
    expect(reportedPortFor(winSidecar, 'ss-embedding', 'host')).toBeUndefined();
  });

  it('never reports the port: 0 placeholder as an endpoint', () => {
    expect(reportedPortFor(macSidecar, 'ss-cuda', 'docker-ollama')).toBeUndefined();
  });

  it('is undefined when the host reports no container for the role', () => {
    expect(reportedPortFor(macSidecar, 'ss-reranker', 'host')).toBeUndefined();
    expect(reportedPortFor({ ...macSidecar, containers: undefined }, 'ss-embedding', 'host')).toBeUndefined();
  });
});

/**
 * A disabled row has no assignment, so resolveRuntime() returns null. It still
 * has a port to show — the one it would bind if enabled — and this is the case
 * an operator reads while deciding what to turn on. Falling through to
 * MODE_PORTS here reprints the original bug on exactly those rows.
 */
describe('disabled rows fall back to the runtime they would use', () => {
  it('shows the shared native port for Mac Ollama roles that are not enabled yet', () => {
    for (const role of OLLAMA_ROLES) {
      const wouldBe = defaultRuntimeForRow(role, 'mac-docker-ollama', false);
      expect(portForRuntime(role, wouldBe)).toBe(11434);
    }
  });

  it('shows the DMR endpoint for ss-rlm on an unconfigured Mac, not 8100', () => {
    const wouldBe = defaultRuntimeForRow('ss-rlm', 'mac-docker-ollama', false);
    expect(portForRuntime('ss-rlm', wouldBe)).toBe(12434);
  });

  it('still shows per-role Docker ports on an unconfigured Windows host', () => {
    const wouldBe = defaultRuntimeForRow('ss-code-embedding', 'windows-docker-wsl2', true);
    expect(portForRuntime('ss-code-embedding', wouldBe)).toBe(11437);
  });
});

/**
 * ss-rlm-sandbox was assignable-looking and unassignable-in-fact: no MODE_PORTS
 * entry (so the Port column read "—"), and a default runtime that varied by OS
 * even though the sidecar only ever resolves it under docker-cpu. On a Mac the
 * OS default was 'host', which would have printed native Ollama's 11434 for a
 * Python container that binds 8101.
 */
describe('ss-rlm-sandbox — docker-cpu, 8101, on every host', () => {
  const ALL_OS = ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'] as const;

  it('binds 8101 under docker-cpu', () => {
    expect(portForRuntime('ss-rlm-sandbox', 'docker-cpu')).toBe(8101);
  });

  it('defaults to docker-cpu regardless of OS or GPU', () => {
    for (const os of ALL_OS) {
      expect(defaultRuntimeForRow('ss-rlm-sandbox', os, false)).toBe('docker-cpu');
      expect(defaultRuntimeForRow('ss-rlm-sandbox', os, true)).toBe('docker-cpu');
    }
  });

  it('shows 8101 on a disabled row on every host — not 11434 or 12434', () => {
    for (const os of ALL_OS) {
      const wouldBe = defaultRuntimeForRow('ss-rlm-sandbox', os, false);
      expect(portForRuntime('ss-rlm-sandbox', wouldBe)).toBe(8101);
    }
  });

  it('is not collapsed onto the shared host/DMR endpoints', () => {
    // portForRuntime short-circuits on runtime before consulting MODE_PORTS,
    // so this asserts the row can never be rendered under those runtimes —
    // runtimesForMode is what keeps it off them.
    expect(portForRuntime('ss-rlm-sandbox', 'host')).toBe(11434);
    expect(portForRuntime('ss-rlm-sandbox', 'docker-model-runner')).toBe(12434);
    // …which is exactly why the default must be docker-cpu.
    expect(defaultRuntimeForRow('ss-rlm-sandbox', 'mac-docker-ollama', false)).not.toBe('host');
  });
});
