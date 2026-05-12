/**
 * Detect the host OS that the sidecar's Docker daemon is running on.
 *
 * From inside a Linux container we can't read the host's /etc/os-release.
 * The Docker Engine API gives us partial signals via GET /info — combined
 * with an optional HOST_OS env hint, we can identify the platform.
 *
 * Precedence (highest first):
 *   1. HOST_OS env variable (darwin | win32 | linux) — explicit operator hint
 *   2. Docker /info: OperatingSystem == "Docker Desktop" + Architecture
 *      → "aarch64"/"arm64"  → darwin (Apple Silicon; almost never Win-on-ARM
 *                              in practice for Docker Desktop)
 *      → "x86_64"           → darwin/win32 ambiguous; mark as unknown-desktop
 *   3. Otherwise → linux (native Docker on Linux)
 *
 * Surfaces in /api/status.host so the admin UI can render OS-correct
 * install instructions for native Ollama.
 */

import { state } from './state';
import { dockerRequest } from './docker';
import { createLogger } from './logger';

const log = createLogger('host-os');

type HostOs = 'darwin' | 'win32' | 'linux' | 'unknown';

function fromEnvHint(): { os: HostOs; confidence: 'env' } | null {
  const hint = (process.env.HOST_OS || '').toLowerCase();
  if (hint === 'darwin' || hint === 'mac' || hint === 'macos') return { os: 'darwin', confidence: 'env' };
  if (hint === 'win32' || hint === 'windows') return { os: 'win32', confidence: 'env' };
  if (hint === 'linux') return { os: 'linux', confidence: 'env' };
  return null;
}

async function fromDockerInfo(): Promise<{ os: HostOs; confidence: 'docker-info' | 'low'; dockerDesktop: boolean }> {
  try {
    const { status, body } = await dockerRequest('GET', '/info');
    if (status !== 200) {
      log.warn(`Docker /info returned HTTP ${status} — cannot detect host OS`);
      return { os: 'unknown', confidence: 'low', dockerDesktop: false };
    }
    const info = JSON.parse(body) as {
      OperatingSystem?: string;
      Architecture?: string;
      KernelVersion?: string;
      Name?: string;
      OSType?: string;
    };
    const operatingSystem = info.OperatingSystem || '';
    const architecture = info.Architecture || '';
    const kernelVersion = info.KernelVersion || '';
    const name = info.Name || '';
    const osType = (info.OSType || '').toLowerCase();
    // Detect Docker Desktop via any reliable signal. Different Docker
    // Desktop versions report `OperatingSystem` differently: "Docker
    // Desktop", "Docker Desktop 4.X", or sometimes just the Linux distro
    // running inside the VM. Cover all known signals.
    const isDesktop =
      /^docker\s*desktop/i.test(operatingSystem) ||
      /linuxkit/i.test(kernelVersion) ||
      name === 'docker-desktop' ||
      /docker\s*desktop/i.test(name);
    log.info(
      `Docker /info: OperatingSystem="${operatingSystem.slice(0, 60)}" ` +
      `Architecture="${architecture}" KernelVersion="${kernelVersion.slice(0, 60)}" ` +
      `Name="${name}" OSType="${osType}" isDesktop=${isDesktop}`,
    );
    if (!isDesktop) return { os: 'linux', confidence: 'docker-info', dockerDesktop: false };
    // Desktop variant on linux host (some rare configs report linux OSType
    // under "Docker Desktop"). Treat as linux when OSType is linux and no
    // linuxkit marker is present.
    if (osType === 'linux' && !/linuxkit/i.test(kernelVersion)) {
      return { os: 'linux', confidence: 'docker-info', dockerDesktop: false };
    }
    if (architecture === 'aarch64' || architecture === 'arm64') {
      return { os: 'darwin', confidence: 'docker-info', dockerDesktop: true };
    }
    // x86_64 Desktop: could be Intel Mac or Windows. Can't tell from the
    // Engine API alone — surface as unknown so the UI prompts for HOST_OS.
    return { os: 'unknown', confidence: 'low', dockerDesktop: true };
  } catch (err) {
    log.warn(`Docker /info probe failed: ${(err as Error).message}`);
    return { os: 'unknown', confidence: 'low', dockerDesktop: false };
  }
}

/**
 * Detect host OS and write the result to state. Idempotent; cached after
 * first call. Call once at sidecar boot. Cheap — at most one Docker /info
 * call when no env hint is set.
 */
export async function detectHostOs(): Promise<void> {
  const env = fromEnvHint();
  if (env) {
    state.hostOs = env.os;
    state.hostOsConfidence = 'env';
    // Even with env hint we still want to know whether it's Docker Desktop
    // (for UI affordances) — non-blocking probe.
    const probed = await fromDockerInfo();
    state.hostOsDockerDesktop = probed.dockerDesktop;
    log.info(`host OS = ${env.os} (env hint; dockerDesktop=${probed.dockerDesktop})`);
    return;
  }
  const probed = await fromDockerInfo();
  state.hostOs = probed.os;
  state.hostOsConfidence = probed.confidence;
  state.hostOsDockerDesktop = probed.dockerDesktop;
  log.info(`host OS = ${probed.os} (confidence=${probed.confidence}, dockerDesktop=${probed.dockerDesktop})`);
}
