/** @jest-environment node */
/**
 * Per-master ss-rlm-sandbox slot (docs/tasks/58, 59) and the hand-off route
 * the sandbox reads it from. Synthetic keys and documentation addresses only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-slot-'));
process.env.OPENROUTER_STORE_PATH = path.join(STORE_DIR, 'openrouter.enc.json');

// Imports are hoisted above the env line, and the store reads its path at
// load, so the modules under test are required after it.
/* eslint-disable @typescript-eslint/no-require-imports */
import { NextRequest } from 'next/server';
const {
  applyOpenRouterPush, clearSandboxSlot, restoreSandboxSlots, getSlotStatus,
  resolveSandboxSlot, sandboxToken, __resetSandboxSlotsForTest,
} = require('../sandbox-slot') as typeof import('../sandbox-slot');
const { loadOpenRouterStore } = require('../openrouter-store') as typeof import('../openrouter-store');
const { GET } = require('../../app/api/rlm-sandbox/master-config/route') as typeof import('../../app/api/rlm-sandbox/master-config/route');

const SS = 'http://192.0.2.10:3000';
const FANTOM = 'http://192.0.2.10:3848';
const KEY_A = 'sk-or-v1-synthetic-a';
const KEY_B = 'sk-or-v1-synthetic-b';

function slot(apiKey: string | undefined, model?: string, domain?: string) {
  return {
    ...(apiKey ? { apiKey } : {}),
    allowedModels: model ? { 'rlm-sandbox': { model } } : {},
    ...(domain ? { domain } : {}),
  };
}

beforeEach(() => {
  __resetSandboxSlotsForTest();
  try { fs.unlinkSync(process.env.OPENROUTER_STORE_PATH!); } catch { /* none */ }
});

describe('applyOpenRouterPush', () => {
  it('stores a slot and reports configured (key + model)', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/sandbox', 'legal'));
    expect(getSlotStatus(SS)).toEqual({ openrouter: 'configured', domain: 'legal' });
  });

  it('reports unset without a model, and without a key', () => {
    applyOpenRouterPush(SS, slot(KEY_A));
    expect(getSlotStatus(SS).openrouter).toBe('unset');
    applyOpenRouterPush(FANTOM, slot(undefined, 'm/x'));
    expect(getSlotStatus(FANTOM).openrouter).toBe('unset');
    expect(getSlotStatus('http://192.0.2.99:1').openrouter).toBe('unset');
  });

  it('null clears this master only, in memory and in the store', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a', 'legal'));
    applyOpenRouterPush(FANTOM, slot(KEY_B, 'm/b', 'code'));
    applyOpenRouterPush(SS, null);
    expect(getSlotStatus(SS).openrouter).toBe('unset');
    expect(getSlotStatus(FANTOM).openrouter).toBe('configured');
    const stored = loadOpenRouterStore();
    expect(stored.has(SS)).toBe(false);
    expect(stored.get(FANTOM)?.apiKey).toBe(KEY_B);
  });

  it('a later object push configures the slot again', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    applyOpenRouterPush(SS, null);
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    expect(getSlotStatus(SS).openrouter).toBe('configured');
  });

  it('absent (undefined) changes nothing', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    applyOpenRouterPush(SS, undefined);
    expect(getSlotStatus(SS).openrouter).toBe('configured');
  });

  it('a push without apiKey keeps the stored key', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    applyOpenRouterPush(SS, slot(undefined, 'm/b'));
    const r = resolveSandboxSlot(SS);
    expect(r).toMatchObject({ ok: true, apiKey: KEY_A, model: 'm/b' });
  });

  it('accepts an old full block and keeps only the sandbox fields', () => {
    applyOpenRouterPush(SS, {
      apiKey: KEY_A,
      allowedModels: {
        embedding: { model: 'qwen/qwen3-embedding-4b', provider: 'Nebius', dims: 2560 },
        reranker: { model: 'cohere/rerank-v3.5' },
        'rlm-sandbox': { model: 'm/sandbox' },
      },
      modeByRole: { embedding: 'cloud-only', 'rlm-sandbox': 'local-first' },
      domain: 'legal',
    });
    expect(resolveSandboxSlot(SS)).toEqual({
      ok: true, serverUrl: SS, apiKey: KEY_A, model: 'm/sandbox', domain: 'legal',
    });
    const stored = loadOpenRouterStore().get(SS)!;
    expect(Object.keys(stored.allowedModels)).toEqual(['rlm-sandbox']);
    expect(stored.modeByRole).toEqual({});
  });

  it('ignores an unknown domain', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a', 'medical'));
    expect(getSlotStatus(SS).domain).toBeUndefined();
  });

  it('retiring a master clears its slot', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    clearSandboxSlot(SS);
    expect(getSlotStatus(SS).openrouter).toBe('unset');
  });
});

describe('restoreSandboxSlots', () => {
  it('restores slots after a restart', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a', 'legal'));
    __resetSandboxSlotsForTest();
    expect(getSlotStatus(SS).openrouter).toBe('unset');
    expect(restoreSandboxSlots()).toBe(1);
    expect(getSlotStatus(SS)).toEqual({ openrouter: 'configured', domain: 'legal' });
  });
});

describe('resolveSandboxSlot', () => {
  it('503 when no master has a key', () => {
    expect(resolveSandboxSlot()).toMatchObject({ ok: false, status: 503 });
  });

  it('resolves the single configured master without a header', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    expect(resolveSandboxSlot()).toMatchObject({ ok: true, serverUrl: SS });
  });

  it('409 with two keyed masters and no header — never picks one', () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    applyOpenRouterPush(FANTOM, slot(KEY_B, 'm/b'));
    expect(resolveSandboxSlot()).toMatchObject({ ok: false, status: 409 });
    expect(resolveSandboxSlot(FANTOM)).toMatchObject({ ok: true, apiKey: KEY_B });
  });

  it('404 for an explicit master with no slot; 503 with no model', () => {
    expect(resolveSandboxSlot(SS)).toMatchObject({ ok: false, status: 404 });
    applyOpenRouterPush(SS, slot(KEY_A));
    expect(resolveSandboxSlot(SS)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('GET /api/rlm-sandbox/master-config', () => {
  const req = (master?: string, token?: string) =>
    new NextRequest(
      `http://localhost:8098/api/rlm-sandbox/master-config${master ? `?master=${encodeURIComponent(master)}` : ''}`,
      { headers: token ? { 'x-sandbox-token': token } : {} },
    );

  it('401 without or with a wrong token', async () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    expect((await GET(req(SS))).status).toBe(401);
    expect((await GET(req(SS, 'nope'))).status).toBe(401);
  });

  it('200 with key, model and domain for the named master', async () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a', 'legal'));
    const res = await GET(req(SS, sandboxToken()));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sandbox-handoff')).toBe('1');
    expect(await res.json()).toEqual({ master: SS, apiKey: KEY_A, model: 'm/a', domain: 'legal' });
  });

  it('a 404 for an unknown master carries the hand-off marker', async () => {
    const res = await GET(req(FANTOM, sandboxToken()));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-sandbox-handoff')).toBe('1');
    expect((await res.json()).handoff).toBe(true);
  });

  it('409 when two masters are keyed and none is named', async () => {
    applyOpenRouterPush(SS, slot(KEY_A, 'm/a'));
    applyOpenRouterPush(FANTOM, slot(KEY_B, 'm/b'));
    expect((await GET(req(undefined, sandboxToken()))).status).toBe(409);
  });
});

describe('sandbox container contract (server.py)', () => {
  const read = () => fs.readFileSync(path.join(__dirname, '../../../../docker/rlm-sandbox/server.py'), 'utf8');

  it('sends and reads both header spellings', () => {
    const src = read();
    for (const h of ['X-SoundSuite-Master', 'X-FantomMCP-Master', 'X-SoundSuite-Domain', 'X-FantomMCP-Domain']) {
      expect(src).toContain(h);
    }
  });

  it('uses the hand-off route, its token header and its marker', () => {
    const src = read();
    expect(src).toContain('/rlm-sandbox/master-config');
    expect(src).toContain('X-Sandbox-Token');
    expect(src).toContain('X-Sandbox-Handoff');
    expect(src).toContain('SS_SANDBOX_TOKEN');
  });

  it('refuses to guess a domain it does not recognise', () => {
    const src = read();
    expect(src).toContain('VALID_DOMAINS = ("legal", "code")');
    expect(src).toMatch(/def tools_for_domain/);
  });
});
