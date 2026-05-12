import { NextRequest, NextResponse } from 'next/server';
import { state, type HostStats, type GpuInfo, type HostMacExtras } from '@/lib/state';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/host-stats');
const cors = { 'Access-Control-Allow-Origin': '*' };

/**
 * Optional host-side helper endpoint. The sidecar runs in a Linux container
 * (Docker Desktop VM on Mac, WSL2 on Windows) and cannot read true host
 * memory/GPU stats. A native script on the host POSTs samples here every
 * ~10s. Two known clients today:
 *
 *   - macOS launchd helper (public/sideCar/scripts/report-host-stats.sh):
 *     populates memory.{total,used,free}Bytes from sysctl + vm_stat plus
 *     mac.memoryPressurePct from `memory_pressure`.
 *
 *   - Windows scheduled task (report-host-stats.ps1, Agent B's territory):
 *     populates cpu, memory, gpus[] from nvidia-smi + perf counters.
 *
 * The endpoint is intentionally unauthenticated and bound to the local
 * sidecar port; the helper runs on the SAME machine over 127.0.0.1. Treat
 * all input as untrusted — clamp + coerce every numeric field.
 */

function num(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v;
}

function clampPct(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(100, n));
}

function sanitizeGpu(g: unknown): GpuInfo | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  const memoryTotal = num(o.memoryTotal) ?? 0;
  const memoryUsed = num(o.memoryUsed) ?? 0;
  const memoryFree = num(o.memoryFree) ?? Math.max(0, memoryTotal - memoryUsed);
  return {
    index: num(o.index) ?? 0,
    name: typeof o.name === 'string' ? o.name.slice(0, 128) : 'unknown',
    memoryTotal,
    memoryUsed,
    memoryFree,
    temperature: num(o.temperature) ?? 0,
    // processes pass-through is optional; reject when malformed
    processes: Array.isArray(o.processes)
      ? (o.processes as unknown[])
          .map((p) => {
            if (!p || typeof p !== 'object') return null;
            const pp = p as Record<string, unknown>;
            return {
              pid: num(pp.pid) ?? 0,
              name: typeof pp.name === 'string' ? pp.name.slice(0, 256) : '',
              usedMemory: num(pp.usedMemory) ?? 0,
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
      : undefined,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<HostStats> & {
      mac?: Partial<HostMacExtras>;
    };

    const cpu = body.cpu && typeof body.cpu === 'object'
      ? {
          percent: clampPct(body.cpu.percent),
          cores: num(body.cpu.cores),
          model: typeof body.cpu.model === 'string' ? body.cpu.model.slice(0, 256) : undefined,
        }
      : undefined;

    const memory = body.memory && typeof body.memory === 'object'
      ? {
          totalBytes: num(body.memory.totalBytes),
          usedBytes: num(body.memory.usedBytes),
          freeBytes: num(body.memory.freeBytes),
        }
      : undefined;

    const gpus = Array.isArray(body.gpus)
      ? (body.gpus.map(sanitizeGpu).filter((g): g is GpuInfo => g !== null))
      : undefined;

    const mac: HostMacExtras | undefined = body.mac && typeof body.mac === 'object'
      ? {
          memoryPressurePct: clampPct(body.mac.memoryPressurePct),
          gpuName: typeof body.mac.gpuName === 'string' ? body.mac.gpuName.slice(0, 128) : undefined,
          gpuUtilPct: clampPct(body.mac.gpuUtilPct),
        }
      : undefined;

    // ── Back-compat: accept Mac-v1 flat fields (totalMb/freeMb/pressurePct/
    //    gpuName/gpuUtilPct) and map them into the structured blocks above
    //    if the new fields weren't sent. The original Mac launchd helper
    //    only knows the flat shape.
    const flat = body as Record<string, unknown>;
    const flatTotalMb = num(flat.totalMb);
    const flatFreeMb = num(flat.freeMb);
    const flatPressurePct = clampPct(flat.pressurePct);
    const flatGpuName = typeof flat.gpuName === 'string' ? flat.gpuName.slice(0, 128) : undefined;
    const flatGpuUtilPct = clampPct(flat.gpuUtilPct);

    const mergedMemory = memory ?? (flatTotalMb !== undefined
      ? {
          totalBytes: flatTotalMb * 1024 * 1024,
          freeBytes: flatFreeMb !== undefined ? flatFreeMb * 1024 * 1024 : undefined,
          usedBytes: flatFreeMb !== undefined && flatTotalMb !== undefined
            ? Math.max(0, (flatTotalMb - flatFreeMb) * 1024 * 1024)
            : undefined,
        }
      : undefined);

    const mergedMac: HostMacExtras | undefined = mac
      ?? (flatPressurePct !== undefined || flatGpuName || flatGpuUtilPct !== undefined
        ? {
            memoryPressurePct: flatPressurePct,
            gpuName: flatGpuName,
            gpuUtilPct: flatGpuUtilPct,
          }
        : undefined);

    const stats: HostStats = {
      at: num(body.at) ?? Date.now(),
      source: typeof body.source === 'string' && body.source.length < 64
        ? body.source
        : 'unknown-helper',
      agent: typeof body.agent === 'string' ? body.agent.slice(0, 64) : undefined,
      os: typeof body.os === 'string' ? (body.os.slice(0, 16) as HostStats['os']) : undefined,
      cpu,
      memory: mergedMemory,
      gpus,
      hasNvidia: typeof body.hasNvidia === 'boolean'
        ? body.hasNvidia
        : (gpus && gpus.length > 0 ? true : undefined),
      mac: mergedMac,
      // Echo the legacy flat fields too, so callers that still read the
      // old shape (older master UI builds) keep working.
      totalMb: flatTotalMb,
      freeMb: flatFreeMb,
      pressurePct: flatPressurePct,
      gpuName: flatGpuName ?? mergedMac?.gpuName,
      gpuUtilPct: flatGpuUtilPct,
    };

    state.hostStats = stats;
    if (stats.hasNvidia === true) state.hasNvidiaSmi = true;

    // Mirror reported NVIDIA GPUs into gpuCache so /api/gpu and the VRAM
    // accountant see real numbers on Windows hosts where container-side
    // nvidia-smi can't reach the GPU.
    if (gpus && gpus.length > 0) {
      state.gpuCache = gpus;
      state.gpuCacheTime = Date.now();
    }

    return NextResponse.json({ ok: true, at: stats.at }, { headers: cors });
  } catch (err) {
    log.warn(`host-stats POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400, headers: cors },
    );
  }
}

export async function GET() {
  return NextResponse.json({ stats: state.hostStats }, { headers: cors });
}
