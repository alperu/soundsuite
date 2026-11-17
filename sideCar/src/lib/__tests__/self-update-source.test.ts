import { findUpdateSource, orderForUpdates } from '../self-update';

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

describe('orderForUpdates', () => {
  const urls = ['http://a', 'http://b', 'http://c'];
  test('pinned master goes first, the rest keep their order', () => {
    expect(orderForUpdates(urls, 'http://c')).toEqual(['http://c', 'http://a', 'http://b']);
  });
  test('no pin, or a pin that is not in the list, keeps the list order', () => {
    expect(orderForUpdates(urls, null)).toEqual(urls);
    expect(orderForUpdates(urls, 'http://gone')).toEqual(urls);
  });
  test('the pinned master is asked first', async () => {
    const asked: string[] = [];
    const src = await findUpdateSource(orderForUpdates(urls, 'http://b'), async (u) => { asked.push(u); return { available: true, version: '9.9.9', served: true }; });
    expect(src?.serverUrl).toBe('http://b');
    expect(asked).toEqual(['http://b']);
  });
});
