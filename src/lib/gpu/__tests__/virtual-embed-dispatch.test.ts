/**
 * @jest-environment node
 *
 * `dispatchVirtualEmbed` is the master-side half of the sidecar's
 * `virtual-embed` WS command — it spreads a text batch round-robin across
 * every connected, role-eligible sidecar and falls back to a direct
 * OpenRouter call (`directFallback`) when no sidecar is eligible or every
 * eligible sidecar fails for its share.
 *
 * `@/lib/gpu/fleet-router` and `@/lib/gpu/master-identity` are mocked — the
 * real fleet-router.ts pulls in role-registry → mode-catalog-server →
 * 'server-only', which Jest cannot resolve (same reason the existing
 * fleet-router-*.test.ts suites mock that chain instead of importing it for
 * real). No network, no DB — synthetic fixtures only (CLAUDE.md § Privacy).
 */

import { dispatchVirtualEmbed } from '../virtual-embed-dispatch';
import { sendToSidecar, getFleetStatus } from '@/lib/gpu/fleet-router';
import { getCanonicalMasterUrl } from '@/lib/gpu/master-identity';
import { beginCall as mockBeginCall, endCall as mockEndCall, chargeEmbeddingTokens as mockChargeEmbeddingTokens } from '@/lib/openrouter/client';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/lib/gpu/fleet-router', () => ({
  sendToSidecar: jest.fn(),
  getFleetStatus: jest.fn(),
}));

jest.mock('@/lib/gpu/master-identity', () => ({
  getCanonicalMasterUrl: jest.fn(),
}));

// `@/lib/openrouter/client` pulls in `@/lib/db/config` -> `@/lib/db/prisma`,
// which eagerly constructs a real PrismaClient at import time (see
// prisma.ts) — never something a unit test should drag in. Mock the three
// activity/spend functions this module actually calls instead.
jest.mock('@/lib/openrouter/client', () => ({
  beginCall: jest.fn(),
  endCall: jest.fn(),
  chargeEmbeddingTokens: jest.fn(),
}));

const mockSendToSidecar = sendToSidecar as jest.MockedFunction<typeof sendToSidecar>;
const mockGetFleetStatus = getFleetStatus as jest.MockedFunction<typeof getFleetStatus>;
const mockGetCanonicalMasterUrl = getCanonicalMasterUrl as jest.MockedFunction<typeof getCanonicalMasterUrl>;

const MODEL = 'qwen/qwen3-embedding-4b';
const DIMS = 2560;
const SELF_URL = 'http://master.local:3000';

function fleetOf(urls: string[]) {
  return {
    sidecars: urls.map((url) => ({
      url,
      hostname: url,
      mode: 'websocket' as const,
      lastSeen: new Date().toISOString(),
      status: 'connected' as const,
      containers: [],
    })),
    wsRelayPort: 3002,
    connectedViaWs: urls.length,
  };
}

function fakeVectors(n: number, dims = DIMS): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, j) => (i + j) / 1000));
}

/** Sidecar /status response making `role` eligible for SELF_URL. */
function statusEligible(role: string) {
  return { masters: [{ serverUrl: SELF_URL, virtualInference: { rolesWithModel: [role] } }] };
}

function statusIneligible() {
  return { masters: [{ serverUrl: SELF_URL, virtualInference: { rolesWithModel: [] } }] };
}

describe('dispatchVirtualEmbed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCanonicalMasterUrl.mockResolvedValue(SELF_URL);
  });

  it('returns [] for empty input without touching the fleet', async () => {
    const directFallback = jest.fn();
    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts: [], expectedDims: DIMS, directFallback });
    expect(result).toEqual([]);
    expect(mockGetFleetStatus).not.toHaveBeenCalled();
    expect(directFallback).not.toHaveBeenCalled();
  });

  it('falls back directly to OpenRouter when zero sidecars are connected', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf([]));
    const texts = ['a', 'b', 'c'];
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(3));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(3);
    expect(directFallback).toHaveBeenCalledWith(texts);
    expect(mockSendToSidecar).not.toHaveBeenCalled();
  });

  it('falls back directly to OpenRouter when sidecars are connected but none allow-list the role', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path) => {
      if (path === '/status') return statusIneligible();
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['a', 'b'];
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(2));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(2);
    expect(directFallback).toHaveBeenCalledWith(texts);
    // /status was checked, but /virtual-embed never sent to an ineligible sidecar.
    expect(mockSendToSidecar).not.toHaveBeenCalledWith(expect.anything(), '/virtual-embed', expect.anything(), expect.anything(), expect.anything());
  });

  it('single eligible sidecar gets the entire batch', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        const texts = (body as any).texts as string[];
        expect((body as any).localAvailable).toBe(false);
        return { source: 'openrouter', embeddings: fakeVectors(texts.length), model: MODEL, dims: DIMS };
      }
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['a', 'b', 'c', 'd'];
    const directFallback = jest.fn();

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(4);
    result.forEach((v) => expect(v).toHaveLength(DIMS));
    expect(directFallback).not.toHaveBeenCalled();
    const embedCalls = mockSendToSidecar.mock.calls.filter((c) => c[1] === '/virtual-embed');
    expect(embedCalls).toHaveLength(1);
    expect((embedCalls[0][2] as any).texts).toEqual(texts);
  });

  it('round-robins a batch across multiple eligible sidecars', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098', 'http://sc2:8098']));
    const seenBySidecar: Record<string, string[]> = {};
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        const texts = (body as any).texts as string[];
        seenBySidecar[url] = texts;
        return { source: 'openrouter', embeddings: fakeVectors(texts.length), model: MODEL, dims: DIMS };
      }
      throw new Error(`unexpected call ${path}`);
    });
    // Big enough to actually divide: shares are sized by concurrency and a
    // MIN_SHARE_TEXTS floor, NOT by sidecar count, so a batch below that floor
    // deliberately travels as one request (see the next test).
    const texts = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const directFallback = jest.fn();

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(16);
    expect(directFallback).not.toHaveBeenCalled();
    // Both sidecars were used, and between them they carried every text exactly
    // once. Which host got which share is an implementation detail; that the
    // work was divided and nothing was dropped is the contract.
    const carried = Object.values(seenBySidecar).flat().sort();
    expect(Object.keys(seenBySidecar).length).toBeGreaterThan(1);
    expect(carried).toEqual([...texts].sort());
  });

  it('keeps a small batch as ONE request rather than splitting it per sidecar', async () => {
    // /embeddings takes an array, so splitting 4 texts into 4 calls would be
    // three extra round trips to do work one request already batches.
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098', 'http://sc2:8098']));
    const calls: string[][] = [];
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        const texts = (body as any).texts as string[];
        calls.push(texts);
        return { source: 'openrouter', embeddings: fakeVectors(texts.length), model: MODEL, dims: DIMS };
      }
      throw new Error(`unexpected call ${path}`);
    });

    const result = await dispatchVirtualEmbed({
      role: 'embedding', model: MODEL,
      texts: ['t0', 't1', 't2', 't3'],
      expectedDims: DIMS, directFallback: jest.fn(),
    });

    expect(result).toHaveLength(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('re-dispatches a failing sidecar share to another eligible sidecar', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://bad:8098', 'http://good:8098']));
    const seenByGood: string[][] = [];
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        if (url === 'http://bad:8098') throw new Error('sidecar unreachable');
        const texts = (body as any).texts as string[];
        seenByGood.push(texts);
        return { source: 'openrouter', embeddings: fakeVectors(texts.length), model: MODEL, dims: DIMS };
      }
      throw new Error(`unexpected call ${path}`);
    });
    // 4 texts is below MIN_SHARE_TEXTS, so this is ONE share. It is offered to
    // the first eligible sidecar (bad), which fails — the share must then be
    // RE-dispatched to good rather than dropped or silently shortened.
    const texts = ['t0', 't1', 't2', 't3'];
    const directFallback = jest.fn();

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(4);
    result.forEach((v) => expect(v).toHaveLength(DIMS));
    expect(directFallback).not.toHaveBeenCalled();
    // good must have received the FULL share bad dropped — not a truncated one,
    // and not merely "a call of the right length".
    expect(seenByGood).toEqual([['t0', 't1', 't2', 't3']]);
  });

  it('attributes tokens and activity to the serving sidecar on success', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        const texts = (body as any).texts as string[];
        return { source: 'openrouter', embeddings: fakeVectors(texts.length), model: MODEL, dims: DIMS, totalTokens: 42 };
      }
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['a', 'b'];
    const directFallback = jest.fn();

    await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    // Attribution must happen for the sidecar-served share — this is the
    // fix for `getSpendToday('embedding')` staying at 0 while the sidecar
    // spends its own OpenRouter key.
    expect(mockChargeEmbeddingTokens).toHaveBeenCalledWith('embedding', MODEL, 42);
    expect(mockBeginCall).toHaveBeenCalledWith('embedding');
    expect(mockEndCall).toHaveBeenCalledWith(
      'embedding',
      expect.objectContaining({ success: true, servedBy: 'sidecar:http://sc1:8098', tokens: 42 }),
    );
  });

  it('attributes a failed call to the sidecar without charging tokens', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') throw new Error('boom');
      throw new Error(`unexpected call ${path}`);
    });
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(1));

    await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts: ['t0'], expectedDims: DIMS, directFallback });

    expect(mockEndCall).toHaveBeenCalledWith(
      'embedding',
      expect.objectContaining({ success: false, servedBy: 'sidecar:http://sc1:8098' }),
    );
    expect(mockChargeEmbeddingTokens).not.toHaveBeenCalled();
  });

  it('falls back to directFallback (not silently dropped) even when directFallback itself is the last resort after every sidecar fails', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098', 'http://sc2:8098']));
    mockSendToSidecar.mockImplementation(async (url, path) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') throw new Error('boom');
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['t0', 't1'];
    const directFallback = jest.fn().mockImplementation((t: string[]) => Promise.resolve(fakeVectors(t.length)));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(2);
    result.forEach((v) => expect(v).toHaveLength(DIMS));
    // Each of the two round-robin shares (one text each, over two sidecars)
    // fell back independently — every text must be accounted for, none dropped.
    const fallenBackTexts = directFallback.mock.calls.flatMap((c) => c[0] as string[]).sort();
    expect(fallenBackTexts).toEqual(['t0', 't1']);
  });

  it('falls back to directFallback for a share when every eligible sidecar fails', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') throw new Error('boom');
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['t0'];
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(1));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(result).toHaveLength(1);
    expect(directFallback).toHaveBeenCalledWith(['t0']);
  });

  it('treats a width mismatch from a sidecar as a failure and falls back rather than returning mixed widths', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path, body) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') {
        const texts = (body as any).texts as string[];
        // Drifted provider — wrong width.
        return { source: 'openrouter', embeddings: fakeVectors(texts.length, 1536), model: MODEL, dims: 1536 };
      }
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['t0', 't1'];
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(2, DIMS));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    // Refused the wrong-width sidecar result and fell back — never returned
    // the 1536-dim vectors from the sidecar.
    expect(directFallback).toHaveBeenCalledWith(texts);
    result.forEach((v) => expect(v).toHaveLength(DIMS));
  });

  it('treats a sidecar routing to local (localAvailable ignored) as a failure, not a silent local answer', async () => {
    mockGetFleetStatus.mockResolvedValue(fleetOf(['http://sc1:8098']));
    mockSendToSidecar.mockImplementation(async (url, path) => {
      if (path === '/status') return statusEligible('embedding');
      if (path === '/virtual-embed') return { source: 'local' };
      throw new Error(`unexpected call ${path}`);
    });
    const texts = ['t0'];
    const directFallback = jest.fn().mockResolvedValue(fakeVectors(1));

    const result = await dispatchVirtualEmbed({ role: 'embedding', model: MODEL, texts, expectedDims: DIMS, directFallback });

    expect(directFallback).toHaveBeenCalledWith(texts);
    expect(result).toHaveLength(1);
  });
});
