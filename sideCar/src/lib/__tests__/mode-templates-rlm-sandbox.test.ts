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
import { state, dockerSupportsGpu, defaultRegistry } from '../state';

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

  it('refuses docker-ollama/docker-vllm because of the mode, not the GPU gate', () => {
    // The assertion above passes for two different reasons and cannot tell
    // them apart: both branches open with `if (!dockerSupportsGpu()) return
    // null`, which is false in this environment, so they return before ever
    // reaching the ss-rlm-sandbox case. Deleting those cases would not fail
    // that test. Force the gate open and the refusal has to come from the
    // mode switch itself.
    const prevCache = state.gpuCache;
    // dockerSupportsGpu()'s strongest signal: a non-empty gpuCache means
    // passthrough is proven working, regardless of hostOs.
    (state as { gpuCache: unknown }).gpuCache = [{ index: 0, name: 'test', memoryTotal: 49140, memoryUsed: 0 }];
    try {
      expect(dockerSupportsGpu()).toBe(true);
      for (const hostOs of ALL_OS) {
        expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-ollama')).toBeNull();
        expect(resolveMode('ss-rlm-sandbox', hostOs, 'docker-vllm')).toBeNull();
      }
      // …and docker-cpu still resolves with the gate open, i.e. the new branch
      // is not accidentally depending on the gate either way.
      expect(resolveMode('ss-rlm-sandbox', 'linux', 'docker-cpu')).not.toBeNull();
    } finally {
      (state as { gpuCache: unknown }).gpuCache = prevCache;
    }
  });

  it('does not hand docker-cpu to GPU inference roles', () => {
    for (const mode of ['ss-embedding', 'ss-code-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker', 'ss-rlm'] as const) {
      expect(resolveMode(mode, 'linux', 'docker-cpu')).toBeNull();
    }
  });
});

/**
 * The image string lives in two files, and the master's /config push replaces
 * state.registry[role] wholesale — so a host can end up running whichever copy
 * won, depending on whether a master had pushed yet. Editing only
 * defaultRegistry is silently dropped at runtime; that is the documented
 * registry-overwrite trap.
 */
describe('the sandbox image string cannot drift between its two definitions', () => {
  it('mode-templates and state.ts agree', () => {
    const fromTemplates = resolveMode('ss-rlm-sandbox', 'linux', 'docker-cpu')!.image;
    expect(fromTemplates).toBe(defaultRegistry['rlm-sandbox'].image);
  });

  it('is version-pinned, not :latest', () => {
    // pullImage skips when the image is already present locally, so :latest
    // freezes each host on whatever it first pulled with no way to tell which.
    const image = defaultRegistry['rlm-sandbox'].image;
    expect(image).not.toMatch(/:latest$/);
    expect(image).toMatch(/:\d+\.\d+\.\d+$/);
  });

  it('points at the published registry', () => {
    expect(defaultRegistry['rlm-sandbox'].image).toMatch(
      /^ghcr\.io\/project-sandstar\/rlm-sandbox:/,
    );
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
