/**
 * @jest-environment node
 *
 * `/admin/openrouter` could silently clear the stored ss-rlm-sandbox model.
 *
 * The page submits every field on every save, and `rlmSandboxModel` initialises
 * to `''` when the server payload has not arrived. The route's guard was
 * `typeof body.rlmSandboxModel === 'string'` — and `''` IS a string, so a blank
 * field was written through as a real value. Changing an unrelated routing
 * dropdown and saving therefore wiped the sandbox model.
 *
 * That is not cosmetic: resolveRlmEndpoint() skips the ss-rlm-sandbox fallback
 * entirely when no sandbox model is configured, so the role goes dark with only
 * a console warning. Observed live on 2026-09-15 — the stored value was `""`.
 *
 * See docs/TASK-openrouter-save-rlm-model-2026-09-15.md.
 */

const updateConfig = jest.fn();

jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({}),
  updateConfig: (...a: unknown[]) => updateConfig(...a),
}));
jest.mock('@/lib/api/route-guard', () => ({
  requireAdminApiAccess: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/gpu/fleet-router', () => ({
  pushOpenRouterConfigToAll: jest.fn().mockResolvedValue({ pushed: 0 }),
  pushFullConfig: jest.fn().mockResolvedValue(undefined),
}));

import { POST, CLEAR_SENTINEL } from '../route';

function req(body: Record<string, unknown>) {
  return {
    json: async () => body,
    nextUrl: { searchParams: new URLSearchParams() },
    headers: new Headers(),
  } as never;
}

/** The value updateConfig was called with for this field. */
async function savedValue(body: Record<string, unknown>) {
  updateConfig.mockClear();
  await POST(req(body));
  expect(updateConfig).toHaveBeenCalled();
  return (updateConfig.mock.calls[0][0] as Record<string, unknown>).rlmSandboxModel;
}

describe('rlmSandboxModel is never cleared as a side effect', () => {
  it('leaves the stored value alone when the field is absent', async () => {
    // The fixed client omits the key entirely when it never loaded.
    expect(await savedValue({ enabled: true })).toBeUndefined();
  });

  it('leaves the stored value alone when the field is an empty string', async () => {
    // The regression itself. An older client — or a stale browser tab — still
    // posts `''`, so the server must refuse it independently of the UI fix.
    expect(await savedValue({ rlmSandboxModel: '' })).toBeUndefined();
  });

  it('leaves it alone for a whitespace-only value', async () => {
    expect(await savedValue({ rlmSandboxModel: '   ' })).toBeUndefined();
  });

  it('writes a real model id, trimmed', async () => {
    expect(await savedValue({ rlmSandboxModel: '  deepseek/deepseek-v4-flash  ' }))
      .toBe('deepseek/deepseek-v4-flash');
  });

  it('clears only on the explicit sentinel', async () => {
    expect(await savedValue({ rlmSandboxModel: CLEAR_SENTINEL })).toBe('');
  });

  it('ignores a non-string', async () => {
    expect(await savedValue({ rlmSandboxModel: 42 })).toBeUndefined();
    expect(await savedValue({ rlmSandboxModel: null })).toBeUndefined();
  });
});
