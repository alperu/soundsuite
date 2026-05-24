import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getConfig, setConfigValue, getAllSidecarIdleTimeouts, setSidecarIdleTimeouts, clearSidecarIdleTimeouts } from '@/lib/db/config';
import {
  getFleetStatus,
  addSidecar,
  removeSidecar,
  updateSidecarNote,
  testSidecar,
  controlContainer,
  pushIdleTimeouts,
  pushModelRegistry,
  getSidecarGpus,
  switchSidecarMode,
  provisionSidecar,
  getSidecarContainers,
  sendToSidecar,
} from '@/lib/gpu/fleet-router';
import { getAggregatedPeakDemand } from '@/lib/gpu/status-cache';
import { getGpuLogs } from '@/lib/logger';

function getLatestBuildVersion(): string | null {
  try {
    const manifestPath = path.join(process.cwd(), 'public', 'sideCar', 'builds', 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || null;
  } catch { return null; }
}

/**
 * GET /api/admin/gpu-fleet
 * Returns fleet status + idle timeouts from config.
 * Uses cached sidecar status — no outbound push to sidecars.
 */
export async function GET() {
  try {
    const [fleet, config] = await Promise.all([getFleetStatus(), getConfig()]);

    // Read peak demand from status cache (no push needed)
    const peakDemand = getAggregatedPeakDemand();

    const sidecarTimeoutOverrides = await getAllSidecarIdleTimeouts(fleet.sidecars.map((s: any) => s.url));

    return NextResponse.json({
      ...fleet,
      idleTimeouts: {
        embedding: config.gpuIdleEmbeddingMin,
        completion: config.gpuIdleCompletionMin,
        ocr: config.gpuIdleOcrMin,
        reranker: config.gpuIdleRerankerMin,
        rlm: config.gpuIdleRlmMin,
      },
      sidecarTimeoutOverrides,
      minOnline: {
        embedding: config.gpuMinEmbedding,
        completion: config.gpuMinCompletion,
        ocr: config.gpuMinOcr,
        reranker: config.gpuMinReranker,
        rlm: config.gpuMinRlm,
      },
      peakDemand,
      gpuMode: config.gpuMode,
      gpuAutoManage: config.gpuAutoManage,
      masterUrl: config.masterUrl,
      latestBuildVersion: getLatestBuildVersion(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message?.slice(0, 300) }, { status: 500 });
  }
}

/**
 * POST /api/admin/gpu-fleet
 * Fleet management actions.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'add': {
        const { url, hostname } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const entry = await addSidecar(url, hostname);
        return NextResponse.json(entry);
      }

      case 'remove': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const removed = await removeSidecar(url);
        return NextResponse.json({ removed });
      }

      case 'updateNote': {
        const { url, note } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const updated = await updateSidecarNote(url, note ?? '');
        return NextResponse.json({ updated });
      }

      case 'test': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const result = await testSidecar(url);
        return NextResponse.json(result);
      }

      case 'start':
      case 'stop': {
        const { url, role } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        // Wrap the sidecar call so transport errors (downstream 502, fetch
        // ECONNRESET, sidecar process throw) come back to the dashboard as
        // HTTP 200 with a structured { ok: false, error } body. The UI can
        // then render the sidecar's own error message instead of a generic
        // gateway error. Operators reported a bare 502 on BASWS34 when
        // their sidecar's handleStart threw — this restores visibility.
        try {
          const result = await controlContainer(url, action, role);
          // Sidecar may itself return { error: ... } at HTTP 200 — surface
          // it with ok=false so the dashboard treats both shapes the same.
          if (result && typeof result === 'object' && 'error' in result && (result as any).error) {
            return NextResponse.json(
              { ok: false, action, role, error: String((result as any).error).slice(0, 600), result },
              { status: 200 },
            );
          }
          return NextResponse.json({ ok: true, action, role, result });
        } catch (err: any) {
          const msg = err?.message ? String(err.message).slice(0, 600) : 'Unknown sidecar transport error';
          return NextResponse.json({ ok: false, action, role, error: msg }, { status: 200 });
        }
      }

      case 'config': {
        const { url, idleTimeouts, syncModels: alsoSyncModels } = body;
        if (!url || !idleTimeouts) {
          return NextResponse.json({ error: 'URL and idleTimeouts are required' }, { status: 400 });
        }
        const result = await pushIdleTimeouts(url, idleTimeouts);
        if (alsoSyncModels) {
          try { await pushModelRegistry(url); } catch { /* best-effort */ }
        }
        return NextResponse.json(result);
      }

      case 'syncModels': {
        const { url } = body;
        if (url) {
          // Push to a single sidecar
          const result = await pushModelRegistry(url);
          return NextResponse.json(result);
        }
        // Push to ALL connected sidecars
        const fleet = await getFleetStatus();
        const results: Record<string, { ok: boolean; error?: string }> = {};
        for (const sidecar of fleet.sidecars) {
          try {
            await pushModelRegistry(sidecar.url);
            results[sidecar.url] = { ok: true };
          } catch (e: any) {
            results[sidecar.url] = { ok: false, error: e.message?.slice(0, 200) };
          }
        }
        return NextResponse.json({ pushed: results });
      }

      case 'saveTimeouts': {
        const {
          gpuIdleEmbeddingMin,
          gpuIdleCompletionMin,
          gpuIdleOcrMin,
          gpuIdleRerankerMin,
          gpuIdleRlmMin,
        } = body;
        await Promise.all([
          setConfigValue('gpu.idle.embedding', String(gpuIdleEmbeddingMin ?? 0)),
          setConfigValue('gpu.idle.completion', String(gpuIdleCompletionMin ?? 10)),
          setConfigValue('gpu.idle.ocr', String(gpuIdleOcrMin ?? 5)),
          setConfigValue('gpu.idle.reranker', String(gpuIdleRerankerMin ?? 5)),
          setConfigValue('gpu.idle.rlm', String(gpuIdleRlmMin ?? 10)),
        ]);
        return NextResponse.json({ saved: true });
      }

      case 'mode': {
        const { url, mode } = body;
        if (!url || !mode) return NextResponse.json({ error: 'URL and mode are required' }, { status: 400 });
        const result = await switchSidecarMode(url, mode);
        return NextResponse.json(result);
      }

      case 'provision': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const result = await provisionSidecar(url);
        return NextResponse.json(result);
      }

      case 'gpu': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const gpus = await getSidecarGpus(url);
        return NextResponse.json({ gpus });
      }

      case 'containers': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const result = await getSidecarContainers(url);
        return NextResponse.json(result);
      }

      case 'saveMinOnline': {
        await Promise.all([
          setConfigValue('gpu.min.embedding', String(body.gpuMinEmbedding ?? 0)),
          setConfigValue('gpu.min.completion', String(body.gpuMinCompletion ?? 0)),
          setConfigValue('gpu.min.ocr', String(body.gpuMinOcr ?? 0)),
          setConfigValue('gpu.min.reranker', String(body.gpuMinReranker ?? 0)),
          setConfigValue('gpu.min.rlm', String(body.gpuMinRlm ?? 0)),
        ]);
        // Push the new policy to every reachable sidecar immediately so they
        // start respecting min=0 on the next mode switch / orchestrator tick
        // without waiting for a stale-config re-push.
        try {
          const fleet = await getFleetStatus();
          const reachable = fleet.sidecars.filter(s => s.status === 'connected');
          await Promise.all(reachable.map(s => sendToSidecar(s.url, '/config', {
            minOnline: {
              embedding: body.gpuMinEmbedding ?? 0,
              completion: body.gpuMinCompletion ?? 0,
              ocr: body.gpuMinOcr ?? 0,
              reranker: body.gpuMinReranker ?? 0,
              rlm: body.gpuMinRlm ?? 0,
            },
          }, 'POST').catch(() => null)));
        } catch { /* best-effort — orchestrator will re-push on next tick */ }
        return NextResponse.json({ saved: true });
      }

      case 'saveMasterUrl': {
        const value = String(body.masterUrl ?? '').trim();
        await setConfigValue('master.url', value);
        // Re-push to all reachable sidecars so they pick up the new URL
        // immediately and persist it to disk for warm-boot next time.
        if (value) {
          try {
            const fleet = await getFleetStatus();
            const reachable = fleet.sidecars.filter(s => s.status === 'connected');
            await Promise.all(reachable.map(s => sendToSidecar(s.url, '/config', { serverUrl: value }, 'POST').catch(() => null)));
          } catch { /* best-effort */ }
        }
        return NextResponse.json({ saved: true, value });
      }

      case 'pullModel': {
        const { url, role } = body;
        if (!url || !role) return NextResponse.json({ error: 'URL and role are required' }, { status: 400 });
        const result = await sendToSidecar(url, '/pullModel', { role }, 'POST', 300_000);
        return NextResponse.json(result);
      }

      case 'pullModelOnly': {
        // Pull without auto-load. Sidecar's pullModel handler honors
        // payload.andLoad=false. Used by the host-Ollama "Pull" button
        // when the operator wants to fetch weights without VRAM load.
        const { url, role } = body;
        if (!url || !role) return NextResponse.json({ error: 'URL and role are required' }, { status: 400 });
        const result = await sendToSidecar(url, '/pullModel', { role, andLoad: false }, 'POST', 300_000);
        return NextResponse.json(result);
      }

      case 'loadModel': {
        const { url, role } = body;
        if (!url || !role) return NextResponse.json({ error: 'URL and role are required' }, { status: 400 });
        const result = await sendToSidecar(url, '/loadModel', { role }, 'POST', 180_000);
        return NextResponse.json(result);
      }

      case 'update': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        const result = await sendToSidecar(url, '/update', {}, 'POST', 60_000);
        return NextResponse.json(result);
      }

      case 'logs': {
        const logs = getGpuLogs(body.limit || 100);
        return NextResponse.json({ logs });
      }

      case 'saveConfig': {
        const { gpuMode, gpuAutoManage, embeddingUseOrchestrator, completionUseOrchestrator, ocrUseOrchestrator, rerankUseOrchestrator } = body;
        if (gpuMode !== undefined) await setConfigValue('gpu.mode', gpuMode);
        if (gpuAutoManage !== undefined) await setConfigValue('gpu.autoManage', String(gpuAutoManage));
        if (embeddingUseOrchestrator !== undefined) await setConfigValue('embedding.useOrchestrator', String(embeddingUseOrchestrator));
        if (completionUseOrchestrator !== undefined) await setConfigValue('ai.completionUseOrchestrator', String(completionUseOrchestrator));
        if (ocrUseOrchestrator !== undefined) await setConfigValue('pipeline.ocrUseOrchestrator', String(ocrUseOrchestrator));
        if (rerankUseOrchestrator !== undefined) await setConfigValue('rerank.useOrchestrator', String(rerankUseOrchestrator));
        return NextResponse.json({ saved: true });
      }

      case 'saveSidecarTimeouts': {
        const { url, timeouts } = body;
        if (!url || !timeouts) return NextResponse.json({ error: 'URL and timeouts are required' }, { status: 400 });
        await setSidecarIdleTimeouts(url, timeouts);
        // Push to the specific sidecar (convert minutes → ms for the sidecar)
        try {
          await pushIdleTimeouts(url, timeouts);
        } catch { /* best-effort push */ }
        return NextResponse.json({ saved: true });
      }

      case 'clearSidecarTimeouts': {
        const { url } = body;
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        await clearSidecarIdleTimeouts(url);
        // Push global defaults to the sidecar
        const cfg = await getConfig();
        try {
          await pushIdleTimeouts(url, {
            embedding: cfg.gpuIdleEmbeddingMin,
            completion: cfg.gpuIdleCompletionMin,
            ocr: cfg.gpuIdleOcrMin,
            reranker: cfg.gpuIdleRerankerMin,
          });
        } catch { /* best-effort push */ }
        return NextResponse.json({ cleared: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message?.slice(0, 300) }, { status: 500 });
  }
}
