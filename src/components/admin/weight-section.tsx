'use client';

import { useEffect, useState } from 'react';

/**
 * Reusable "GPU Weight" section for a vLLM-served model's admin page.
 *
 * The weight IS the vLLM `--gpu-memory-utilization` fraction (0–1): how much of
 * the GPU's VRAM the model reserves at startup. Lower frees headroom for other
 * work; too low can OOM at startup. The value is operator-tunable here instead
 * of hardcoded, persisted as a global config key (gpu.memUtil.<role>) and
 * pushed to the sidecar's vllmArgs.
 *
 * Shows a live calculation (reserved ≈ util × deviceTotal, free buffer) sourced
 * from the GPU fleet's reported device VRAM so the operator sees the impact
 * before saving. Self-fetches device total; pass `deviceTotalMb` to override.
 */

const PRESETS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

function fmtGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

interface Props {
  /** Short role name, e.g. "reranker" — used to size against the right host. */
  role: string;
  /** Current gpu-memory-utilization fraction (0–1). */
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Optional override; when omitted the component fetches device total VRAM. */
  deviceTotalMb?: number | null;
  /** Preset to tag "Recommended" (role-dependent: reranker 0.85, rlm 0.9). */
  recommended?: number;
}

export default function WeightSection({ role, value, onChange, disabled, deviceTotalMb, recommended = 0.85 }: Props) {
  const [fetchedTotalMb, setFetchedTotalMb] = useState<number | null>(null);

  useEffect(() => {
    if (typeof deviceTotalMb === 'number') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/gpu-fleet');
        if (!res.ok) return;
        const data = await res.json();
        const sidecars: any[] = Array.isArray(data?.sidecars) ? data.sidecars : [];
        // Pick the largest reported device total across connected sidecars —
        // vram.totalMb (nvidia-smi/host-declared) first, gpus[0].memoryTotal as
        // fallback for older sidecars.
        let best = 0;
        for (const s of sidecars) {
          const st = s?.sidecarStatus;
          const total = st?.vram?.totalMb ?? st?.gpus?.[0]?.memoryTotal ?? 0;
          if (typeof total === 'number' && total > best) best = total;
        }
        if (!cancelled && best > 0) setFetchedTotalMb(best);
      } catch {
        /* best-effort — calc just hides if total is unknown */
      }
    })();
    return () => { cancelled = true; };
  }, [deviceTotalMb, role]);

  const totalMb = typeof deviceTotalMb === 'number' ? deviceTotalMb : fetchedTotalMb;
  const options = PRESETS.includes(value) ? PRESETS : [...PRESETS, value].sort((a, b) => a - b);

  const reservedMb = totalMb != null ? totalMb * value : null;
  const freeMb = totalMb != null && reservedMb != null ? Math.max(0, totalMb - reservedMb) : null;

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <h2 className="text-xl font-semibold text-gray-900 mb-4">GPU Weight (Memory Allocation)</h2>
      <p className="text-sm text-gray-600 mb-4">
        How much of the GPU&apos;s VRAM this model reserves at startup
        (<code className="px-1 py-0.5 bg-gray-100 rounded">--gpu-memory-utilization</code>).
        Lower frees headroom for other work; too low can fail to start. Takes effect when the
        container is next recreated (the sidecar detects the changed start command on its next
        reconcile — typically the next search, or within the keep-warm tick for a resident role).
      </p>

      <label className="block text-sm font-medium text-gray-700 mb-1">Memory utilization</label>
      <select
        value={String(value)}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((p) => (
          <option key={p} value={String(p)}>
            {Math.round(p * 100)}%{p === recommended ? ' — Recommended' : ''}
          </option>
        ))}
      </select>

      <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
        {totalMb != null ? (
          <p className="text-xs text-blue-800">
            <strong>On a {fmtGb(totalMb)} GPU:</strong> reserves ~{fmtGb(reservedMb!)} for this model,
            leaving ~{fmtGb(freeMb!)} free buffer for the OS and other roles.
          </p>
        ) : (
          <p className="text-xs text-blue-800">
            Reserves ~{Math.round(value * 100)}% of the GPU&apos;s VRAM. Connect a GPU sidecar to see
            the exact GB calculation.
          </p>
        )}
      </div>
    </div>
  );
}
