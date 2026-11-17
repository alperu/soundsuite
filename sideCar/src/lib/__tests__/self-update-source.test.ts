import { findUpdateSource } from '../self-update';

describe('findUpdateSource', () => {
  const fake = (map: Record<string, { available: boolean; version?: string; served?: boolean }>) =>
    async (url: string) => map[url] ?? { available: false };

  test('skips a first master that serves no builds and uses the next one', async () => {
    const r = await findUpdateSource(['http://app', 'http://sm'], fake({
      'http://app': { available: false },
      'http://sm': { available: true, version: '2.5.2', served: true },
    }));
    expect(r).toEqual({ serverUrl: 'http://sm', available: true, version: '2.5.2' });
  });

  test('stops at the first master that serves builds, even when up to date', async () => {
    const r = await findUpdateSource(['http://sm', 'http://other'], fake({
      'http://sm': { available: false, version: '2.5.2', served: true },
      'http://other': { available: true, version: '9.9.9', served: true },
    }));
    expect(r).toEqual({ serverUrl: 'http://sm', available: false, version: '2.5.2' });
  });

  test('returns null when no master serves builds', async () => {
    expect(await findUpdateSource(['http://a', 'http://b'], fake({}))).toBeNull();
    expect(await findUpdateSource([], fake({}))).toBeNull();
  });
});
