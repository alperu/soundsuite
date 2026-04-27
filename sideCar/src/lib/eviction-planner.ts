/**
 * Eviction planner — given a VRAM need and a requesting role, produce the
 * smallest set of evictions that frees enough.
 *
 * Rules (in order):
 *  1. Never evict the requesting role itself.
 *  2. Never evict a role with priority='critical' or gpuOnly=true.
 *  3. Roles whose modes include the active mode are protected — UNLESS the
 *     requesting role is critical and the candidate is not. (This is the
 *     "override modes when necessary" rule from the spec: a critical role
 *     like OCR can pre-empt search-mode roles to make GPU room.)
 *  4. Sort candidates ascending by (priority rank, -actualMb): evict 'normal'
 *     before 'high', and within a tier prefer the bigger candidates so we free
 *     more per eviction.
 *  5. Greedy accumulate until we cover the need.
 *  6. Choose unloadModel for Ollama (keeps container running, fast warmup);
 *     stopContainer for vLLM (only way to free its VRAM allocation).
 *
 * Returns null if even evicting every legal candidate is insufficient — the
 * caller should report that state to the operator instead of partial-evicting
 * for nothing.
 */

import { state } from './state';
import type { VramSnapshot, RoleVramSnapshot } from './vram-accountant';

const PRIORITY_RANK = { normal: 0, high: 1, critical: 2 } as const;

export type EvictAction = 'unloadModel' | 'stopContainer';

export interface EvictionStep {
  role: string;
  action: EvictAction;
  expectedFreeMb: number;
  reason: string;
}

export interface EvictionPlan {
  needMb: number;
  freeBeforeMb: number;
  steps: EvictionStep[];
  totalFreedMb: number;
  // True iff the plan covers the need. False if we ran out of candidates and
  // still couldn't free enough — the caller should refuse to load.
  sufficient: boolean;
}

/**
 * Plan evictions to make room for `requestingRole`. Reads the snapshot the
 * caller already produced (cheap to share across plan + execute).
 *
 * `headroomMb` is added to the role's budget so the load doesn't immediately
 * spill again after a small fluctuation. Defaults to 1024 MB.
 */
export function planEviction(
  snapshot: VramSnapshot,
  requestingRole: string,
  opts?: { headroomMb?: number },
): EvictionPlan {
  const headroom = opts?.headroomMb ?? 1024;
  const def = state.registry[requestingRole];
  if (!def) {
    return { needMb: 0, freeBeforeMb: snapshot.freeMb, steps: [], totalFreedMb: 0, sufficient: true };
  }

  const want = def.vram + headroom;
  const need = Math.max(0, want - snapshot.freeMb);
  if (need === 0) {
    return { needMb: 0, freeBeforeMb: snapshot.freeMb, steps: [], totalFreedMb: 0, sufficient: true };
  }

  const requesterIsCritical = (def.priority ?? 'normal') === 'critical' || def.gpuOnly === true;
  const activeMode = state.currentMode;

  const candidates: RoleVramSnapshot[] = Object.values(snapshot.perRole).filter((r) => {
    if (r.role === requestingRole) return false;
    if (!r.loaded) return false;
    if (r.actualMb <= 0) return false;
    // Hard guards
    if (r.priority === 'critical') return false;
    if (r.gpuOnly) return false;
    // Mode protection — bypassed when requester is critical
    const inActiveMode = r.modes.includes(activeMode);
    if (inActiveMode && !requesterIsCritical) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority];
    const pb = PRIORITY_RANK[b.priority];
    if (pa !== pb) return pa - pb;            // normal before high
    return b.actualMb - a.actualMb;           // bigger first within tier
  });

  const steps: EvictionStep[] = [];
  let freed = 0;
  for (const c of candidates) {
    const action: EvictAction = c.runtime === 'vllm' ? 'stopContainer' : 'unloadModel';
    const reason = c.modes.includes(activeMode)
      ? `mode-override: ${requestingRole} is critical, ${c.role} (${c.priority}) is in active mode but evictable`
      : `${c.role} (${c.priority}) not needed in mode=${activeMode}`;
    steps.push({ role: c.role, action, expectedFreeMb: c.actualMb, reason });
    freed += c.actualMb;
    if (freed >= need) break;
  }

  return {
    needMb: need,
    freeBeforeMb: snapshot.freeMb,
    steps,
    totalFreedMb: freed,
    sufficient: freed >= need,
  };
}
