/** @jest-environment node */

/**
 * Round-trip for the two MCP local-profile model keys (`ai.ollamaDecomposeModel`,
 * `ai.ollamaOutlineModel`) through `updateConfig()` / `getConfig()`.
 *
 * Prisma is mocked with a plain in-memory key/value map — this suite must not
 * touch the real database.
 */

const rows = new Map<string, string>();

jest.mock('../prisma', () => ({
  prisma: {
    config: {
      findMany: jest.fn(async () => [...rows].map(([key, value]) => ({ key, value }))),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
        rows.set(where.key, create.value);
        return { key: where.key, value: create.value };
      }),
    },
  },
}));

import { getConfig, updateConfig } from '../config';

beforeEach(() => rows.clear());

describe('MCP local model config keys', () => {
  it('are undefined on a stock install (Auto)', async () => {
    const config = await getConfig();
    expect(config.ollamaDecomposeModel).toBeUndefined();
    expect(config.ollamaOutlineModel).toBeUndefined();
  });

  it('round-trip under their ai.* keys', async () => {
    await updateConfig({ ollamaDecomposeModel: 'small-instruct:4b', ollamaOutlineModel: 'tiny-instruct:1b' });

    expect(rows.get('ai.ollamaDecomposeModel')).toBe('small-instruct:4b');
    expect(rows.get('ai.ollamaOutlineModel')).toBe('tiny-instruct:1b');

    const config = await getConfig();
    expect(config.ollamaDecomposeModel).toBe('small-instruct:4b');
    expect(config.ollamaOutlineModel).toBe('tiny-instruct:1b');
  });

  it('are independent of each other and of the completion model', async () => {
    await updateConfig({ ollamaCompletionModel: 'local-9b', ollamaOutlineModel: 'tiny-instruct:1b' });
    const config = await getConfig();
    expect(config.ollamaCompletionModel).toBe('local-9b');
    expect(config.ollamaOutlineModel).toBe('tiny-instruct:1b');
    expect(config.ollamaDecomposeModel).toBeUndefined();
  });

  it('selecting "Auto" clears the pin back to an empty string', async () => {
    await updateConfig({ ollamaOutlineModel: 'tiny-instruct:1b' });
    await updateConfig({ ollamaOutlineModel: '' });
    const config = await getConfig();
    // Empty is what the UI's "Auto (resolve from host)" option persists; the
    // resolvers treat it as absent because `''.trim()` is falsy.
    expect(config.ollamaOutlineModel).toBe('');
  });

  it('an unrelated update leaves the pins alone', async () => {
    await updateConfig({ ollamaDecomposeModel: 'small-instruct:4b' });
    await updateConfig({ ollamaCompletionHost: 'http://localhost:11434' });
    const config = await getConfig();
    expect(config.ollamaDecomposeModel).toBe('small-instruct:4b');
  });
});
