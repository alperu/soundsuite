/**
 * ss-rlm-sandbox coverage for the sidecar's mode-templates.resolveMode().
 *
 * This is the sidecar's OWN copy of ModeName/ALL_MODES (mode-templates.ts
 * does not import from the master's src/lib/gpu/mode-catalog.ts — they are
 * separate packages, see that file's header comment) — so it needs its own
 * assertion that ss-rlm-sandbox was added here too, not just on the master
 * side.
 */

import { resolveMode, roleToMode, modeToRole, isModeName, ALL_MODES } from '../mode-templates';

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
