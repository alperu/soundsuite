/**
 * Virtual-embed dispatch — the master-side half of the sidecar's `virtual-embed`
 * WS command (`sideCar/src/lib/handlers.ts#handleVirtualEmbed`,
 * `virtual-inference.ts#serveEmbedding`). Before this file existed the sidecar
 * side was fully built and completely unreachable: nothing on the master ever
 * sent `virtual-embed`, so the sidecar's per-role "Virtual Containers" counters
 * stayed at 0/never forever.
 *
 * What this does: given a batch of texts destined for OpenRouter, spread the
 * batch round-robin across every CONNECTED sidecar whose pushed config
 * allow-lists the requested role (`virtualInference.rolesWithModel`, reported
 * fresh on each sidecar's own `/status`) — so N sidecars spend their own
 * OpenRouter key in parallel instead of one master process doing it serially.
 * "Each file to a separate sidecar" per the operator's framing.
 *
 * Safety invariants this file must never weaken (see
 * `AllSourcesEmbeddingProvider`, the only caller): the result must come back
 * fully populated, in the original text order, and at the one dimension the
 * caller verified up front — otherwise a caller writing straight into
 * `VectorStore.addChunks()` can trigger its drop-and-recreate path and destroy
 * an existing table. A share that fails on every eligible sidecar falls back
 * to the caller-supplied `directFallback` (the master calling OpenRouter
 * itself) rather than ever returning a partial or under-width result.
 *
 * Spend/activity attribution: every share dispatched to a sidecar here is
 * recorded against the master's own OpenRouter counters
 * (`src/lib/openrouter/client.ts` — `beginCall`/`endCall`/
 * `chargeEmbeddingTokens`), tagged `servedBy: 'sidecar:<url>'`. See
 * `sendShare()` below for why this is necessary at all: the sidecar spends
 * its own key, so the master's `embed()` never runs for these tokens.
 */

import { sendToSidecar, getFleetStatus } from './fleet-router';
import { getCanonicalMasterUrl } from './master-identity';
import { beginCall, endCall, chargeEmbeddingTokens } from '@/lib/openrouter/client';
import { getConfig } from '@/lib/db/config';
import { createLogger } from '../logger';

const logger = createLogger('VirtualEmbedDispatch');

// Embedding batches can be large (many chunks); give the sidecar's own
// OpenRouter round trip more room than sendToSidecar's generic 15s POST
// default before we give up on it and try the next sidecar / fall back.
/**
 * Fewest texts worth giving a share of its own.
 *
 * Below this the batch goes as ONE request: /embeddings accepts an array, so
 * splitting small work only multiplies round trips. Above it, each additional
 * share is a genuine parallel request rather than an extra handshake.
 */
const MIN_SHARE_TEXTS = 8;

const VIRTUAL_EMBED_TIMEOUT_MS = 45_000;

export interface DispatchVirtualEmbedOptions {
  /** Role key as pushed in `virtualInference.mode.<role>` / allowedModels,
   *  e.g. 'embedding' or 'code-embedding'. */
  role: string;
  /** OpenRouter model id, e.g. 'qwen/qwen3-embedding-4b'. Must match what the
   *  master pushed for this role — a mismatch is refused by the sidecar. */
  model: string;
  texts: string[];
  /** The dimension the caller already verified for this model. Any vector
   *  that comes back a different width is treated as a failure for that
   *  share (never returned) — see module header. */
  expectedDims: number;
  /** Called for a share (or the whole batch) when no sidecar is eligible, or
   *  every eligible sidecar failed. Same contract as `embed()` on any other
   *  EmbeddingProvider: order-preserving, throws on real failure. */
  directFallback: (texts: string[]) => Promise<number[][]>;
}

interface EligibleSidecar {
  url: string;
}

/**
 * Which connected sidecars have this master's config with `role` allow-listed
 * right now. Reads each sidecar's live `/status` (cheap — sendToSidecar
 * caches GET /status for 15s) rather than the master's own heartbeat cache,
 * which does not carry `virtualInference` at all.
 */
async function getEligibleSidecars(role: string): Promise<EligibleSidecar[]> {
  const fleet = await getFleetStatus();
  const connected = fleet.sidecars.filter(sc => sc.status === 'connected');
  if (connected.length === 0) return [];

  const selfUrl = await getCanonicalMasterUrl();
  const eligible: EligibleSidecar[] = [];

  await Promise.all(connected.map(async (sc) => {
    try {
      const status = await sendToSidecar(sc.url, '/status');
      const masters: Array<{ serverUrl?: string; virtualInference?: { rolesWithModel?: string[] } }> =
        status?.masters ?? [];
      const mine = selfUrl
        ? masters.find(m => m.serverUrl === selfUrl)
        : masters[0];
      const roles = mine?.virtualInference?.rolesWithModel ?? [];
      if (roles.includes(role)) {
        eligible.push({ url: sc.url });
      }
    } catch (err) {
      logger.warn('virtual-embed: could not read sidecar status, treating as ineligible', {
        url: sc.url,
        error: (err as Error).message,
      });
    }
  }));

  return eligible;
}

/**
 * Send one share to one sidecar's `virtual-embed` command. `localAvailable:
 * false` is load-bearing: the sidecar's own routing mode for an `all-sources`
 * role is pushed as `local-first` (it has no `all-sources` concept of its
 * own — see fleet-router's `buildOpenRouterPush`), and local-first with an
 * unspecified `localAvailable` defaults to serving locally. Passing `false`
 * here is what turns this into a real cloud dispatch instead of the sidecar
 * quietly answering "use local" for a request the master already decided is
 * this share's cloud half.
 */
/**
 * Send one share to one sidecar and, on success, attribute its spend/activity
 * to the master's own OpenRouter counters (`src/lib/openrouter/client.ts`).
 *
 * This is the fix for the attribution gap: the sidecar makes the actual HTTPS
 * call to OpenRouter with its own key (see `openrouter-client.ts` there), so
 * nothing in the master's `embed()` ever runs for a sidecar-served share —
 * without this, `getSpendToday('embedding')` stayed at 0 while the account
 * was genuinely being billed. `handleVirtualEmbed` (sideCar/src/lib/handlers.ts)
 * already returns `totalTokens` on its `ServeEmbeddingResult`, so this needed
 * no sidecar-side change — only reading the field here and charging it.
 */
async function sendShare(
  sidecarUrl: string,
  role: string,
  model: string,
  texts: string[],
  expectedDims: number,
): Promise<number[][]> {
  const startedAt = Date.now();
  const servedBy = `sidecar:${sidecarUrl}` as const;
  beginCall(role);
  try {
    const result = await sendToSidecar(
      sidecarUrl,
      '/virtual-embed',
      { role, model, texts, localAvailable: false },
      'POST',
      VIRTUAL_EMBED_TIMEOUT_MS,
    );

    if (result?.error) {
      throw new Error(`sidecar ${sidecarUrl} refused virtual-embed: ${result.error}`);
    }
    if (result?.source === 'local') {
      // Should not happen given localAvailable:false, but never trust a
      // mislabeled/absent field over the actual payload shape.
      throw new Error(`sidecar ${sidecarUrl} routed virtual-embed to local instead of OpenRouter`);
    }

    const vectors = result?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(
        `sidecar ${sidecarUrl} returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ` +
          `${texts.length} texts`,
      );
    }
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== expectedDims) {
        throw new Error(
          `sidecar ${sidecarUrl} returned a ${Array.isArray(v) ? v.length : 'invalid'}-dim vector, expected ` +
            `${expectedDims} — refusing rather than return a mixed-width batch`,
        );
      }
    }

    const totalTokens = typeof result?.totalTokens === 'number' ? result.totalTokens : undefined;
    chargeEmbeddingTokens(role, model, totalTokens);
    endCall(role, { durationMs: Date.now() - startedAt, success: true, servedBy, tokens: totalTokens });
    return vectors;
  } catch (err) {
    endCall(role, { durationMs: Date.now() - startedAt, success: false, servedBy });
    throw err;
  }
}

/** Try `primary`, then every other eligible sidecar in order, then fall back
 *  to `directFallback`. Never throws — always resolves to a full, order-
 *  matching, correct-width result for `texts`. */
async function dispatchShareWithFallback(
  primary: EligibleSidecar,
  eligible: EligibleSidecar[],
  role: string,
  model: string,
  texts: string[],
  expectedDims: number,
  directFallback: (texts: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const candidates = [primary, ...eligible.filter(sc => sc.url !== primary.url)];
  let lastErr: Error | undefined;

  for (const sc of candidates) {
    try {
      return await sendShare(sc.url, role, model, texts, expectedDims);
    } catch (err) {
      lastErr = err as Error;
      logger.warn('virtual-embed share failed, trying next eligible sidecar', {
        url: sc.url,
        role,
        error: lastErr.message,
      });
    }
  }

  logger.warn('virtual-embed: all eligible sidecars failed for this share, falling back to direct OpenRouter', {
    role,
    triedSidecars: candidates.map(c => c.url),
    lastError: lastErr?.message,
  });
  return directFallback(texts);
}

/**
 * Spread `texts` round-robin across every eligible, connected sidecar and
 * embed each share via its own OpenRouter key. Falls back to
 * `directFallback` for the whole batch when no sidecar is eligible, and for
 * any individual share whose sidecars all failed. Result order always
 * matches `texts` order.
 */
export async function dispatchVirtualEmbed(opts: DispatchVirtualEmbedOptions): Promise<number[][]> {
  const { role, model, texts, expectedDims, directFallback } = opts;
  if (texts.length === 0) return [];

  const eligible = await getEligibleSidecars(role);

  // How many requests run at once is a property of the CLOUD, not of the fleet.
  //
  // This used to create exactly one share per eligible sidecar, so three hosts
  // meant three concurrent calls and zero hosts meant the entire batch went as
  // a single serial request. That bound throughput to however many hosts
  // happened to have the role enabled — which is backwards for cloud work: a
  // sidecar in this path is a proxy holding an API key, not a GPU doing the
  // embedding, and one host can carry many in-flight HTTPS calls at once.
  //
  // Shares are now sized by the configured concurrency and capped by the batch
  // (never more shares than texts, so no empty request). Targets are cycled
  // independently, so several shares may land on one sidecar, and with no
  // sidecar at all the batch still parallelises master-direct instead of
  // collapsing to one call.
  //
  // The real ceiling is OpenRouter's per-key rate limit, shared by every
  // sidecar and the master since they all present the same key — hence a
  // configured limit rather than "as many as possible".
  // Concurrency is also bounded from BELOW by a minimum share size. Splitting a
  // 3-text batch into 3 single-text calls would be three round trips to do work
  // one request already batches — /embeddings takes an array, so a small batch
  // is cheaper whole. Parallelism only pays once there is enough to divide.
  const cfg = await getConfig();
  const maxConcurrency = Math.max(1, cfg.openRouterMaxConcurrency ?? 8);
  const shareCount = Math.max(1, Math.min(maxConcurrency, Math.ceil(texts.length / MIN_SHARE_TEXTS)));

  const shareTextIdx: number[][] = Array.from({ length: shareCount }, () => []);
  texts.forEach((_, i) => shareTextIdx[i % shareCount].push(i));
  const limit = shareCount;

  if (eligible.length === 0) {
    logger.info('virtual-embed: no eligible sidecars — calling OpenRouter directly from master', {
      role,
      texts: texts.length,
      concurrency: limit,
    });
  } else {
    logger.info('virtual-embed: dispatching across sidecars', {
      role,
      texts: texts.length,
      sidecars: eligible.length,
      concurrency: limit,
    });
  }

  const results: number[][] = new Array(texts.length);

  await Promise.all(shareTextIdx.map(async (idxs, shareIdx) => {
    if (idxs.length === 0) return;
    const shareTexts = idxs.map(i => texts[i]);
    // Cycle targets independently of share count: with 2 sidecars and 8 shares
    // each host takes 4, rather than the batch being limited to 2 in flight.
    const vectors = eligible.length === 0
      ? await directFallback(shareTexts)
      : await dispatchShareWithFallback(
          eligible[shareIdx % eligible.length],
          eligible, role, model, shareTexts, expectedDims, directFallback,
        );
    idxs.forEach((origIdx, j) => { results[origIdx] = vectors[j]; });
  }));

  return results;
}
