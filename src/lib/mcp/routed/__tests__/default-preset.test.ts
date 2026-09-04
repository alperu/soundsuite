/** @jest-environment node */

jest.mock('../../../logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../../routing-defaults', () => ({ getDefaultRoutingInfo: jest.fn() }));
jest.mock('../../presets/preset-store', () => ({ getPreset: jest.fn(), savePreset: jest.fn() }));

import { getDefaultRoutingInfo } from '../../routing-defaults';
import { getPreset, savePreset } from '../../presets/preset-store';
import { ensureDefaultPreset, ensureDefaultPresetInBackground, _resetDefaultPresetForTests, DEFAULT_PRESET_ID } from '../default-preset';

const mockedInfo = getDefaultRoutingInfo as jest.MockedFunction<typeof getDefaultRoutingInfo>;
const mockedGet = getPreset as jest.MockedFunction<typeof getPreset>;
const mockedSave = savePreset as jest.MockedFunction<typeof savePreset>;

const cloudRouting = {
  fast: { provider: 'ollama', model: 'local-9b' },
  deep: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium' as const, thinking: true },
  'deep-report': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium' as const, thinking: true, multiPass: true },
  'deep-rlm': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium' as const, thinking: true, useRlm: true, rlmMaxRounds: 4 },
};

function stored(id = DEFAULT_PRESET_ID) {
  return { id, name: 'default', preset: { version: 2 as const, name: 'default', routing: cloudRouting }, storedVersion: 2, updatedAt: 'now' };
}

beforeEach(() => {
  _resetDefaultPresetForTests();
  jest.clearAllMocks();
});

describe('ensureDefaultPreset', () => {
  it('creates the preset once and is a no-op on the second call', async () => {
    mockedGet.mockResolvedValue(null);
    mockedInfo.mockResolvedValue({ routing: cloudRouting, source: 'code:cloud', notes: [] });
    mockedSave.mockResolvedValue(stored());

    const first = await ensureDefaultPreset();
    expect(first?.name).toBe('default');
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith({ version: 2, name: 'default', routing: cloudRouting }, DEFAULT_PRESET_ID);

    const second = await ensureDefaultPreset();
    expect(second).toBe(first);
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('is skipped when no cloud provider is configured', async () => {
    mockedGet.mockResolvedValue(null);
    mockedInfo.mockResolvedValue({ routing: cloudRouting, source: 'code:ollama-only', notes: ['n'] });
    expect(await ensureDefaultPreset()).toBeNull();
    expect(mockedSave).not.toHaveBeenCalled();
    // Not memoised: a later call re-checks (operator may have added a key).
    await ensureDefaultPreset();
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('never overwrites an operator-saved default', async () => {
    mockedGet.mockResolvedValue(stored('operator-row'));
    const got = await ensureDefaultPreset();
    expect(got?.id).toBe('operator-row');
    expect(mockedInfo).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('collapses concurrent callers into one create', async () => {
    mockedGet.mockResolvedValue(null);
    mockedInfo.mockResolvedValue({ routing: cloudRouting, source: 'code:cloud', notes: [] });
    mockedSave.mockResolvedValue(stored());
    const [a, b] = await Promise.all([ensureDefaultPreset(), ensureDefaultPreset()]);
    expect(a).toBe(b);
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });

  it('recovers when another process wins the create race', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(stored('other-process'));
    mockedInfo.mockResolvedValue({ routing: cloudRouting, source: 'code:cloud', notes: [] });
    mockedSave.mockRejectedValue(new Error('Unique constraint failed'));
    const got = await ensureDefaultPreset();
    expect(got?.id).toBe('other-process');
  });

  it('background variant swallows errors', async () => {
    mockedGet.mockRejectedValue(new Error('db down'));
    expect(() => ensureDefaultPresetInBackground()).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
