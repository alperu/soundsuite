/**
 * ss-rlm-sandbox coverage for the sidecar's mode-templates.resolveMode().
 *
 * This is the sidecar's OWN copy of ModeName/ALL_MODES (mode-templates.ts
 * does not import from the master's src/lib/gpu/mode-catalog.ts — they are
 * separate packages, see that file's header comment) — so it needs its own
 * assertion that ss-rlm-sandbox was added here too, not just on the master
 * side.
 */

import {
  resolveMode, roleToMode, modeToRole, isModeName, isRuntimeChoice,
  ALL_MODES, ALL_RUNTIME_CHOICES,
} from '../mode-templates';

describe('ss-rlm-sandbox — sidecar mode-templates', () => {
  it('is a recognized ModeName', () => {
    expect(ALL_MODES).toContain('ss-rlm-sandbox');
    expect(isModeName('ss-rlm-sandbox')).toBe(true);
  });

  it('round-trips through modeToRole/roleToMode', () => {
    expect(modeToRole('ss-rlm-sandbox')).toBe('rlm-sandbox');
    expect(roleToMode('rlm-sandbox')).toBe('ss-rlm-sandbox');
  });

  it('resolves to a docker ContainerDef with no VRAM requirement, on every host OS', () => {
    for (const hostOs of ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'] as const) {
      const def = resolveMode('ss-rlm-sandbox', hostOs);
      expect(def).not.toBeNull();
      expect(def!.vram).toBe(0);
      expect(def!.model).toBeNull();
      expect(def!.runtime).toBe('docker');
      expect(def!.containerName).toBe('ss-rlm-sandbox');
    }
  });

  it('does not disturb ss-rlm resolution (Mac still unsupported for the real vLLM role)', () => {
    expect(resolveMode('ss-rlm', 'mac-docker-ollama')).toBeNull();
    expect(resolveMode('ss-rlm', 'linux')).not.toBeNull();
  });
});

/**
 * The tests above only exercise `resolveMode(mode, hostOs)` — the no-runtime
 * arm. That is the arm the master NEVER takes: getRuntimesForHost() fills a
 * runtime for every enabled row, so resolveMode always short-circuits into
 * resolveModeForRuntime(). That function had no ss-rlm-sandbox case in any of
 * its branches, so the mode returned null and ws-client skipped it with
 * "not satisfiable" — on Mac, Windows AND Linux. The suite passed throughout.
 *
 * Every assertion here therefore passes an explicit runtime.
 */
describe('ss-rlm-sandbox — explicit runtime (the path the master actually uses)', () => {
  const ALL_OS = ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'] as const;

  it('resolves under docker-cpu on every host OS, GPU or not', () => {
    for (const hostOs of ALL_OS) {
      const def = resolveMode('ss-rlm-sandbox', hostOs, 'docker-cpu');
      expect(def).not.toBeNull();
      expect(def!.port).toBe(8101);
      expect(def!.vram).toBe(0);
      expect(def!.requiresGpu).toBe(false);
      expect(def!.runtime).toBe('docker');
      expect(def!.containerName).toBe('ss-rlm-sandbox');
    }
  });

  it('is byte-identical to what the OS-default arm returns', () => {
    // One definition, two entry points — see rlmSandboxDef(). If these ever
    // diverge, the mode behaves differently depending on whether a master
    // pushed a runtime, which is the failure this whole task was about.
    for (const hostOs of ALL_OS) {
      expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-cpu'))
        .toEqual(resolveMode('ss-rlm-sandbox', hostOs));
    }
  });

  it('refuses the runtimes that cannot serve it, on every OS', () => {
    for (const hostOs of ALL_OS) {
      // 'host' is native Ollama; the sandbox is not an Ollama model.
      expect(resolveMode('ss-rlm-sandbox', hostOs, 'host')).toBeNull();
      // DMR serves weights; the sandbox has none.
      expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-model-runner')).toBeNull();
      // The GPU-gated container runtimes.
      expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-ollama')).toBeNull();
      expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-vllm')).toBeNull();
    }
  });

  it('does not hand docker-cpu to GPU inference roles', () => {
    for (const mode of ['ss-embedding', 'ss-code-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker', 'ss-rlm'] as const) {
      expect(resolveMode(mode, 'linux', 'docker-cpu')).toBeNull();
    }
  });
});

describe('isRuntimeChoice', () => {
  it('accepts every member of the union', () => {
    for (const v of ALL_RUNTIME_CHOICES) expect(isRuntimeChoice(v)).toBe(true);
  });

  it('includes docker-cpu — ws-client downgrades an unlisted value to undefined, silently', () => {
    expect(ALL_RUNTIME_CHOICES).toContain('docker-cpu');
    expect(isRuntimeChoice('docker-cpu')).toBe(true);
  });

  it('rejects the RoleRuntime value "docker", which is a different axis', () => {
    expect(isRuntimeChoice('docker')).toBe(false);
    expect(isRuntimeChoice(null)).toBe(false);
    expect(isRuntimeChoice(7)).toBe(false);
  });
});
