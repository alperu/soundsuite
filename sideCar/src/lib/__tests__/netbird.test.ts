import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CF_TOKEN_FILE, NetbirdInputError, testCloudflareToken, defaultDomain, defaultManagementUrl, SETUP_KEY_FILE, buildCaddyfile, defaultHostname, parseNetbirdStatus,
  readSecret, readSettings, removeSecret, updateSettings, writeHandoff,
} from '../netbird';
import {
  HANDOFF_TTL_MS, LABEL_HASH, lastLoggedError, LABEL_OWNER, clearHandoff, configBind, fqdnOf, ensureCompanion, netbirdSpec, reconcile, type CompanionDeps,
} from '../netbird-companion';
import { requireAdmin } from '../auth';

const KEY = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
const CF = 'cf_token_abcdefghijklmnopqrstuvwxyz';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')); delete process.env.SIDECAR_NETBIRD_DOMAIN; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('settings store', () => {
  test('defaults when nothing is saved', () => {
    const s = readSettings(dir);
    expect(s.enabled).toBe(false);
    expect(s.managementUrl).toBe('https://api.netbird.io:443');
    expect(s.https.domain).toBe('');
    expect(s.wireguardPort).toBe(0);
  });

  test('saves the key to a 600 file and never in settings.json', () => {
    updateSettings(dir, { setupKey: KEY, enabled: true, hostname: 'GPU-Box-Sidecar' });
    expect(readSecret(dir, SETUP_KEY_FILE)).toBe(KEY);
    expect(fs.statSync(path.join(dir, SETUP_KEY_FILE)).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    expect(raw).not.toContain(KEY);
    expect(readSettings(dir).hostname).toBe('gpu-box-sidecar');
  });

  test('refuses to enable without a key, and writes nothing on a bad field', () => {
    expect(() => updateSettings(dir, { enabled: true })).toThrow(NetbirdInputError);
    expect(() => updateSettings(dir, { setupKey: KEY, hostname: 'bad_name!' })).toThrow(NetbirdInputError);
    expect(readSecret(dir, SETUP_KEY_FILE)).toBeNull();
    expect(() => updateSettings(dir, { https: { enabled: true, domain: 'nb.example.com' } })).toThrow(/Cloudflare token/);
    expect(() => updateSettings(dir, { managementUrl: 'http://x' })).toThrow(/https/);
  });

  test('removing the key or token turns the feature off', () => {
    updateSettings(dir, { setupKey: KEY, enabled: true, https: { enabled: true, domain: 'nb.example.com', cloudflareToken: CF } });
    expect(readSecret(dir, CF_TOKEN_FILE)).toBe(CF);
    let s = removeSecret(dir, 'cloudflareToken');
    expect(s.https.enabled).toBe(false);
    expect(s.enabled).toBe(true);
    s = removeSecret(dir, 'setupKey');
    expect(s.enabled).toBe(false);
    expect(readSecret(dir, SETUP_KEY_FILE)).toBeNull();
  });

  test('env sets the server and domain; HTTPS needs a domain', () => {
    expect(defaultManagementUrl({ SIDECAR_NETBIRD_MANAGEMENT_URL: 'https://nb.example.com:443' } as unknown as NodeJS.ProcessEnv)).toBe('https://nb.example.com:443');
    expect(defaultManagementUrl({ SIDECAR_NETBIRD_MANAGEMENT_URL: 'http://bad' } as unknown as NodeJS.ProcessEnv)).toBe('https://api.netbird.io:443');
    expect(defaultDomain({ SIDECAR_NETBIRD_DOMAIN: 'NB.Example.com' } as unknown as NodeJS.ProcessEnv)).toBe('nb.example.com');
    expect(() => updateSettings(dir, { https: { enabled: true, cloudflareToken: CF } })).toThrow(/domain/);
    expect(fqdnOf('h', '')).toBe('h');
  });

  test('default hostname comes from the Docker host name', () => {
    expect(defaultHostname('GPU-Box')).toBe('gpu-box-sidecar');
    expect(defaultHostname('docker-desktop')).toBe('docker-desktop-sidecar');
    expect(defaultHostname('my_host.local')).toBe('my-host-local-sidecar');
    expect(defaultHostname(null)).toBe('host-sidecar');
  });

  test('parses netbird status --json', () => {
    const s = parseNetbirdStatus({ netbirdIp: '100.114.1.2/16', fqdn: 'x.nb.example.com', management: { connected: true }, peers: { connected: 3, total: 9 } });
    expect(s).toEqual({ connected: true, fqdn: 'x.nb.example.com', ip: '100.114.1.2', managementConnected: true, peersConnected: 3, peersTotal: 9, peers: [] });
    expect(parseNetbirdStatus('nope')).toBeNull();
    const d = parseNetbirdStatus({ peers: { details: [
      { fqdn: 'a.nb', netbirdIp: '100.1.1.1', status: 'Connected', connectionType: 'P2P', latency: 12000000 },
      { fqdn: 'b.nb', netbirdIp: '100.1.1.2', status: 'Idle', connectionType: '-', latency: 0 },
    ] } });
    expect(d?.peers).toEqual([
      { fqdn: 'a.nb', ip: '100.1.1.1', status: 'Connected', type: 'P2P', latencyMs: 12 },
      { fqdn: 'b.nb', ip: '100.1.1.2', status: 'Idle', type: null, latencyMs: null },
    ]);
  });

  test('Caddyfile proxies the fqdn to the sidecar port with Cloudflare DNS', () => {
    const c = buildCaddyfile('x.nb.example.com', 8098, 'ops@example.com');
    expect(c).toContain('x.nb.example.com {');
    expect(c).toContain('dns cloudflare {env.CF_API_TOKEN}');
    expect(c).toContain('resolvers 1.1.1.1 1.0.0.1');
    expect(c).toContain('propagation_timeout -1');
    expect(c).toContain('reverse_proxy 127.0.0.1:8098');
    expect(c).toContain('email ops@example.com');
  });
});

describe('companion specs', () => {
  const self = { Mounts: [{ Type: 'volume', Name: 'ss-sidecar-config', Destination: '/app/config' }] };

  test('configBind finds the volume holding the folder', () => {
    expect(configBind(self, '/app/config/netbird')).toBe('ss-sidecar-config:/app/config');
    expect(configBind({ Mounts: [{ Type: 'bind', Source: '/srv/cfg', Destination: '/app/config/' }] }, '/app/config/netbird')).toBe('/srv/cfg:/app/config/');
    expect(configBind({ Mounts: [] }, '/app/config/netbird')).toBeNull();
  });

  test('NetBird joins the sidecar network and publishes nothing', () => {
    const s = readSettings(dir);
    const { body } = netbirdSpec('abc', 'ss-sidecar', 'v:/app/config', '/app/config/netbird', s, 'h-sidecar', 'fp');
    const host = body.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe('container:abc');
    expect(host.PortBindings).toBeUndefined();
    expect(body.Env).toEqual(expect.arrayContaining([
      'NB_SETUP_KEY_FILE=/app/config/netbird/run/setup-key', 'NB_HOSTNAME=h-sidecar',
    ]));
    expect((body.Env as string[]).some((e) => e.startsWith('NB_WIREGUARD_PORT'))).toBe(false);
  });

  test('spec hash changes with the key and not with the sidecar id', () => {
    const s = readSettings(dir);
    const a = netbirdSpec('id1', 'n', 'v:/c', '/c/nb', s, 'h', 'k1').hash;
    expect(netbirdSpec('id2', 'n', 'v:/c', '/c/nb', s, 'h', 'k1').hash).toBe(a);
    expect(netbirdSpec('id1', 'n', 'v:/c', '/c/nb', s, 'h', 'k2').hash).not.toBe(a);
  });
});

function fakeDeps(over: Partial<CompanionDeps> = {}): CompanionDeps & { calls: string[]; containers: Map<string, any> } {
  const containers = new Map<string, any>();
  const calls: string[] = [];
  containers.set('selfid', {
    Id: 'selfid', State: { Running: true, StartedAt: '2026-11-16T10:00:00Z' },
    Mounts: [{ Type: 'volume', Name: 'cfg', Destination: path.dirname(dir) }],
  });
  const d = {
    calls, containers,
    async inspect(n: string) { return containers.get(n) ?? null; },
    async create(n: string, body: any) { calls.push(`create ${n}`); containers.set(n, { Config: { Labels: body.Labels }, State: { Running: false } }); },
    async start(n: string) { calls.push(`start ${n}`); const c = containers.get(n); c.State = { Running: true, StartedAt: '2026-11-16T11:00:00Z' }; },
    async restart(n: string) { calls.push(`restart ${n}`); },
    async remove(n: string) { calls.push(`remove ${n}`); containers.delete(n); },
    async pull() { return true; },
    async exec() { return { exitCode: 1, output: '' }; },
    async buildImage() { return 'ready' as const; },
    async lastError() { return null; },
    async self() { return { ok: true as const, id: 'selfid', name: 'ss-sidecar' }; },
    dockerHostName: () => 'GPU-Box',
    ...over,
  };
  return d;
}

describe('reconcile', () => {
  test('off: nothing is created', async () => {
    process.env.SIDECAR_NETBIRD_DOMAIN = 'nb.example.com';
    const d = fakeDeps();
    const r = await reconcile(d, dir, 8098);
    expect(r.supported).toBe(true);
    expect(r.netbird?.state).toBe('off');
    expect(r.fqdn).toBe('gpu-box-sidecar.nb.example.com');
    expect(d.calls).toEqual([]);
  });

  test('on: creates NetBird, then leaves it alone; HTTPS adds Caddy', async () => {
    process.env.SIDECAR_NETBIRD_DOMAIN = 'nb.example.com';
    const d = fakeDeps();
    updateSettings(dir, { setupKey: KEY, enabled: true });
    expect((await reconcile(d, dir, 8098)).netbird?.state).toBe('created');
    expect((await reconcile(d, dir, 8098)).netbird?.state).toBe('running');
    updateSettings(dir, { https: { enabled: true, cloudflareToken: CF } });
    const r = await reconcile(d, dir, 8098);
    expect(r.caddy?.state).toBe('created');
    expect(fs.readFileSync(path.join(dir, 'Caddyfile'), 'utf8')).toContain('gpu-box-sidecar.nb.example.com');
    expect(d.calls).toEqual(['create ss-sidecar-netbird', 'start ss-sidecar-netbird', 'create ss-sidecar-caddy', 'start ss-sidecar-caddy']);
  });

  test('Caddy waits for its image build and reports build and log errors', async () => {
    process.env.SIDECAR_NETBIRD_DOMAIN = 'nb.example.com';
    let img: string = 'building';
    const d = fakeDeps({ async buildImage() { return img; }, async lastError() { return 'Invalid token'; } });
    updateSettings(dir, { setupKey: KEY, enabled: true, https: { enabled: true, cloudflareToken: CF } });
    expect((await reconcile(d, dir, 8098)).caddy?.state).toBe('building');
    expect(d.calls).not.toContain('create ss-sidecar-caddy');
    img = 'no network';
    expect((await reconcile(d, dir, 8098)).caddy?.error).toContain('no network');
    img = 'ready';
    const r = await reconcile(d, dir, 8098);
    expect(r.caddy?.state).toBe('created');
    expect(r.caddy?.error).toBe('Invalid token');
  });

  test('a new key or a new sidecar container recreates; turning off removes', async () => {
    const d = fakeDeps();
    updateSettings(dir, { setupKey: KEY, enabled: true });
    await reconcile(d, dir, 8098);
    updateSettings(dir, { setupKey: KEY.replace('A', 'B') });
    expect((await reconcile(d, dir, 8098)).netbird?.state).toBe('created');
    d.containers.get('ss-sidecar-netbird').Config.Labels[LABEL_OWNER] = 'oldid';
    expect((await reconcile(d, dir, 8098)).netbird?.state).toBe('created');
    updateSettings(dir, { enabled: false });
    expect((await reconcile(d, dir, 8098)).netbird?.state).toBe('removed');
  });

  test('restarts a companion that started before the sidecar', async () => {
    const d = fakeDeps();
    const want = { body: { Image: 'x', Labels: {} }, hash: 'h' };
    d.containers.set('c', { Config: { Labels: { [LABEL_HASH]: 'h', [LABEL_OWNER]: 'selfid' } }, State: { Running: true, StartedAt: '2026-11-16T09:00:00Z' } });
    const r = await ensureCompanion(d, 'c', want, 'selfid', Date.parse('2026-11-16T10:00:00Z'));
    expect(r.state).toBe('restarted');
  });

  test('not in Docker or no volume: not supported, nothing created', async () => {
    const d = fakeDeps({ async self() { return { ok: false as const, detail: 'bare metal' }; } });
    updateSettings(dir, { setupKey: KEY, enabled: true });
    expect((await reconcile(d, dir, 8098)).supported).toBe(false);
    const d2 = fakeDeps();
    d2.containers.get('selfid').Mounts = [];
    const r = await reconcile(d2, dir, 8098);
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/volume/);
    expect(d2.calls).toEqual([]);
  });

  test('a create error is reported with a plain reason', async () => {
    const d = fakeDeps({ async create() { throw new Error('error gathering device information while adding custom device "/dev/net/tun": no such file'); } });
    updateSettings(dir, { setupKey: KEY, enabled: true });
    const r = await reconcile(d, dir, 8098);
    expect(r.netbird?.state).toBe('error');
    expect(r.netbird?.error).toMatch(/no \/dev\/net\/tun/);
  });
});

describe('admin gate', () => {
  const req = (auth?: string) => new Request('http://x/api/netbird', { headers: auth ? { authorization: auth } : {} });
  test('closed when no token and no session', () => { expect(requireAdmin(req(), {} as NodeJS.ProcessEnv)?.status).toBe(401); });
  test('the bearer token opens it', () => {
    const env = { SIDECAR_ADMIN_TOKEN: 'secret-token' } as unknown as NodeJS.ProcessEnv;
    expect(requireAdmin(req(), env)?.status).toBe(401);
    expect(requireAdmin(req('Bearer wrong'), env)?.status).toBe(401);
    expect(requireAdmin(req('Bearer secret-token'), env)).toBeNull();
  });
});

describe('secrets at rest', () => {
  test('setup key and Cloudflare token are encrypted on disk', () => {
    updateSettings(dir, { setupKey: KEY, enabled: true, https: { enabled: true, domain: 'nb.example.com', email: 'ops@example.com', cloudflareToken: CF } });
    for (const [f, v] of [[SETUP_KEY_FILE, KEY], [CF_TOKEN_FILE, CF]]) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(raw.startsWith('enc:v1:')).toBe(true);
      expect(raw).not.toContain(v);
      expect(readSecret(dir, f)).toBe(v);
    }
  });
  test('an old plain-text file is encrypted on first read', () => {
    fs.writeFileSync(path.join(dir, SETUP_KEY_FILE), KEY + '\n');
    expect(readSecret(dir, SETUP_KEY_FILE)).toBe(KEY);
    expect(fs.readFileSync(path.join(dir, SETUP_KEY_FILE), 'utf8').startsWith('enc:v1:')).toBe(true);
  });
  test('hand-off copy is written before start and deleted after 2 minutes', () => {
    updateSettings(dir, { setupKey: KEY, enabled: true });
    expect(writeHandoff(dir, SETUP_KEY_FILE)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'run', SETUP_KEY_FILE), 'utf8').trim()).toBe(KEY);
    clearHandoff(dir, SETUP_KEY_FILE, 'running', Date.now() + 1000);
    expect(fs.existsSync(path.join(dir, 'run', SETUP_KEY_FILE))).toBe(true);
    clearHandoff(dir, SETUP_KEY_FILE, 'running', Date.now() + HANDOFF_TTL_MS + 1000);
    expect(fs.existsSync(path.join(dir, 'run', SETUP_KEY_FILE))).toBe(false);
  });
});

describe('caddy image and errors', () => {
  test('lastLoggedError picks the last Caddy error and hides tokens', () => {
    const log = [
      '{"level":"info","msg":"requesting build"}',
      '{"level":"error","msg":"download failed: server gave HTTP response to HTTPS client"}',
      '{"level":"error","msg":"obtaining certificate","error":"Invalid token abcdefghijklmnopqrstuvwxyz0123456789ABCD"}',
      '{"level":"info","msg":"done"}',
    ].join('\n');
    expect(lastLoggedError(log)).toBe('obtaining certificate: Invalid token <hidden>');
    expect(lastLoggedError('{"level":"info","msg":"ok"}')).toBeNull();
    expect(lastLoggedError('no Cloudflare token hand-off; the sidecar starts me again')).toContain('no Cloudflare token');
  });
});

describe('testCloudflareToken', () => {
  const reply = (status: number, j: unknown) => ({ status, json: async () => j });
  test('good token: verify, zone found by walking up, add and remove a TXT record', async () => {
    const calls: string[] = [];
    const f = async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method || 'GET'} ${url.replace('https://api.cloudflare.com/client/v4', '')}`);
      if (url.endsWith('/user/tokens/verify')) return reply(200, { success: true, result: { status: 'active' } });
      if (url.includes('zones?name=vpn.bas.co')) return reply(200, { success: true, result: [] });
      if (url.includes('zones?name=bas.co')) return reply(200, { success: true, result: [{ id: 'z1', name: 'bas.co' }] });
      if (init?.method === 'POST') return reply(200, { success: true, result: { id: 'r1' } });
      return reply(200, { success: true, result: { id: 'r1' } });
    };
    const r = await testCloudflareToken('t', 'vpn.bas.co', f);
    expect(r.ok).toBe(true);
    expect(r.zone).toBe('bas.co');
    expect(calls).toContain('DELETE /zones/z1/dns_records/r1');
  });
  test('bad token stops at the first step with Cloudflare message', async () => {
    const f = async () => reply(401, { success: false, errors: [{ message: 'Invalid API Token' }] });
    const r = await testCloudflareToken('t', 'vpn.bas.co', f);
    expect(r.ok).toBe(false);
    expect(r.steps).toEqual([{ step: 'Token is valid', ok: false, detail: 'Invalid API Token' }]);
  });
  test('no DNS edit right fails on adding the record', async () => {
    const f = async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/verify')) return reply(200, { success: true, result: { status: 'active' } });
      if (url.includes('zones?name=')) return reply(200, { success: true, result: [{ id: 'z1', name: 'bas.co' }] });
      return reply(403, { success: false, errors: [{ message: 'Authentication error' }] });
    };
    const r = await testCloudflareToken('t', 'vpn.bas.co', f);
    expect(r.ok).toBe(false);
    expect(r.steps[2]).toEqual({ step: 'Token can add a DNS record', ok: false, detail: 'Authentication error' });
  });
});

describe('lastLoggedError for NetBird logs', () => {
  test('takes the last ERRO line and skips INFO/WARN', () => {
    const log = [
      '2026-11-17T13:12:17.115Z INFO client/internal/routemanager/systemops/systemops_linux.go:101: Using legacy routing setup',
      '2026-11-17T13:12:17.117Z ERRO client/internal/engine.go:657: failed creating tunnel interface wt0: wgctl: socket: protocol not supported',
      '2026-11-17T13:12:17.177Z WARN [relay: rels://vpn.bas.co:443] shared/relay/client/client.go:840: relay connection was closed by error',
    ].join('\n');
    expect(lastLoggedError(log)).toBe('failed creating tunnel interface wt0: wgctl: socket: protocol not supported');
  });
  test('ignores UPnP noise with raw bytes', () => {
    const log = '\u00072026/11/17 14:27:00 httpu: error while parsing response: malformed HTTP response "\u0000\u0001!"';
    expect(lastLoggedError(log)).toBeNull();
  });
});
