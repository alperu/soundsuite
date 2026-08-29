/**
 * Settings round-trip (secret masking) and config.yml generation for the
 * Cloudflare admin module. Prisma is mocked with an in-memory Config store;
 * only synthetic placeholder values are used.
 */

let STORE: Record<string, string> = {};

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    config: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          Object.entries(STORE)
            .filter(([key]) => where.key.in.includes(key))
            .map(([key, value]) => ({ key, value })),
        ),
      ),
      upsert: jest.fn(({ where, update, create }: any) => {
        STORE[where.key] = where.key in STORE ? update.value : create.value;
        return Promise.resolve({ key: where.key, value: STORE[where.key] });
      }),
    },
  },
}));

import {
  maskSecret,
  isMaskedPlaceholder,
  getCloudflareSettings,
  updateCloudflareSettings,
  generateCloudflaredConfig,
} from '../cloudflare';

beforeEach(() => {
  STORE = {};
});

describe('maskSecret', () => {
  it('shows only the last 4 characters', () => {
    expect(maskSecret('cf-test-token-0000abcd')).toMatch(/^•+abcd$/);
    expect(maskSecret('cf-test-token-0000abcd')).not.toContain('cf-test');
  });

  it('fully masks short values', () => {
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('ab')).toBe('••');
  });

  it('returns empty for empty', () => {
    expect(maskSecret('')).toBe('');
  });
});

describe('isMaskedPlaceholder', () => {
  it('recognizes masked output as a placeholder', () => {
    expect(isMaskedPlaceholder(maskSecret('cf-test-token-0000abcd'))).toBe(true);
    expect(isMaskedPlaceholder('••••')).toBe(true);
  });

  it('does not flag real values', () => {
    expect(isMaskedPlaceholder('cf-new-token-1234')).toBe(false);
    expect(isMaskedPlaceholder('')).toBe(false);
  });
});

describe('settings round-trip', () => {
  it('masks secrets on read, stores them raw', async () => {
    await updateCloudflareSettings({
      domain: 'mcp.example.test',
      apiKey: 'cf-api-key-0000wxyz',
      tunnelToken: 'cf-tunnel-token-0000mnop',
    });

    expect(STORE['cloudflare.apiKey']).toBe('cf-api-key-0000wxyz');
    expect(STORE['cloudflare.tunnelToken']).toBe('cf-tunnel-token-0000mnop');

    const view = await getCloudflareSettings();
    expect(view.domain).toBe('mcp.example.test');
    expect(view.apiKey).toMatch(/^•+wxyz$/);
    expect(view.tunnelToken).toMatch(/^•+mnop$/);
  });

  it('ignores masked placeholders on save (GET→PUT keeps secrets)', async () => {
    await updateCloudflareSettings({ apiKey: 'cf-api-key-0000wxyz' });
    const view = await getCloudflareSettings();

    // Echo the masked form back, as the UI form does on an untouched save.
    await updateCloudflareSettings({ apiKey: view.apiKey, domain: 'new.example.test' });

    expect(STORE['cloudflare.apiKey']).toBe('cf-api-key-0000wxyz');
    expect(STORE['cloudflare.domain']).toBe('new.example.test');
  });

  it('allows clearing a secret with an empty string', async () => {
    await updateCloudflareSettings({ apiKey: 'cf-api-key-0000wxyz' });
    await updateCloudflareSettings({ apiKey: '' });
    expect(STORE['cloudflare.apiKey']).toBe('');
  });

  it('ignores unknown keys and non-string values', async () => {
    await updateCloudflareSettings({ evil: 'x', domain: 42 as unknown as string });
    expect(STORE['cloudflare.evil']).toBeUndefined();
    expect(STORE['cloudflare.domain']).toBeUndefined();
  });
});

describe('generateCloudflaredConfig', () => {
  it('renders tunnel id, credentials file, restricted ingress, and 404 catch-all', async () => {
    await updateCloudflareSettings({
      domain: 'mcp.example.test',
      tunnelId: '11111111-2222-3333-4444-555555555555',
    });

    const { yaml, ready, missing } = await generateCloudflaredConfig();

    expect(ready).toBe(true);
    expect(missing).toEqual([]);
    expect(yaml).toContain('tunnel: 11111111-2222-3333-4444-555555555555');
    expect(yaml).toContain('credentials-file: ~/.cloudflared/11111111-2222-3333-4444-555555555555.json');
    expect(yaml).toContain('hostname: mcp.example.test');
    expect(yaml).toContain('path: ^/api/mcp');
    expect(yaml).toContain('path: ^/\\.well-known/oauth-protected-resource');
    expect(yaml).toContain('httpHostHeader: 127.0.0.1:3000');
    expect(yaml).toContain('service: http_status:404');
    // The catch-all must come last.
    expect(yaml.indexOf('http_status:404')).toBeGreaterThan(yaml.lastIndexOf('hostname:'));
  });

  it('never leaks secrets into the YAML', async () => {
    await updateCloudflareSettings({
      domain: 'mcp.example.test',
      tunnelId: 'tid',
      apiKey: 'cf-api-key-0000wxyz',
      tunnelToken: 'cf-tunnel-token-0000mnop',
    });
    const { yaml } = await generateCloudflaredConfig();
    expect(yaml).not.toContain('cf-api-key');
    expect(yaml).not.toContain('cf-tunnel-token');
  });

  it('reports missing fields with placeholders when unconfigured', async () => {
    const { yaml, ready, missing } = await generateCloudflaredConfig();
    expect(ready).toBe(false);
    expect(missing).toEqual(expect.arrayContaining(['domain', 'tunnelId']));
    expect(yaml).toContain('<your-domain>');
    expect(yaml).toContain('<tunnel-id>');
  });

  it('honors custom ingressPaths', async () => {
    await updateCloudflareSettings({
      domain: 'mcp.example.test',
      tunnelId: 'tid',
      ingressPaths: '/api/mcp, /custom',
    });
    const { yaml } = await generateCloudflaredConfig();
    expect(yaml).toContain('path: ^/api/mcp');
    expect(yaml).toContain('path: ^/custom');
    expect(yaml).not.toContain('oauth');
  });
});
