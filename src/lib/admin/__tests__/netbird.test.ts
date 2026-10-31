/**
 * NetBird settings module: config.json in NETBIRD_CTL_DIR, status from
 * status.json / caddy-status.json, secrets only as last-4 hints.
 * Temp folders and synthetic keys only; no live NetBird.
 *
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getNetbirdView,
  updateNetbirdSettings,
  removeNetbirdKey,
  removeHttpsToken,
  parseNetbirdStatus,
  parseCaddyStatus,
  validHostname,
  validManagementUrl,
  validWireguardPort,
  validExternalIpMap,
  NetbirdError,
} from '../netbird';

const KEY = 'A1B2C3D4-SYNTHETIC-KEY-WXYZ';
const TOKEN = 'synthetic_cloudflare_token_0000_ABCD';

describe('netbird helpers', () => {
  it('validates hostnames, URLs and ports', () => {
    expect(validHostname('soundsuite')).toBe(true);
    expect(validHostname('a'.repeat(64))).toBe(false);
    expect(validHostname('-x')).toBe(false);
    expect(validHostname('Sound')).toBe(false);
    expect(validManagementUrl('https://vpn.bas.co:443')).toBe(true);
    expect(validManagementUrl('http://vpn.bas.co')).toBe(false);
    expect(validWireguardPort(0)).toBe(true);
    expect(validWireguardPort(51820)).toBe(true);
    expect(validWireguardPort(70000)).toBe(false);
    expect(validWireguardPort(1.5)).toBe(false);
    expect(validExternalIpMap('')).toBe(true);
    expect(validExternalIpMap('99.92.186.153')).toBe(true);
    expect(validExternalIpMap('1.2.3.4/10.0.0.1,5.6.7.8/eth1')).toBe(true);
    expect(validExternalIpMap('999.1.1.1')).toBe(false);
    expect(validExternalIpMap('1.2.3.4;rm')).toBe(false);
  });

  it('parses netbird status --json and marks old files as not connected', () => {
    const raw = { netbirdIp: '100.92.1.5/16', fqdn: 'soundsuite.vpn.bas.co', management: { connected: true }, peers: { total: 4, connected: 2 } };
    expect(parseNetbirdStatus(raw, 1000, 2000)).toEqual({
      connected: true, fqdn: 'soundsuite.vpn.bas.co', ip: '100.92.1.5', peersConnected: 2, peersTotal: 4,
      updatedAt: new Date(1000).toISOString(),
    });
    expect(parseNetbirdStatus(raw, 1000, 1000 + 120_000)?.connected).toBe(false);
    expect(parseNetbirdStatus(null, 1000, 1000)).toBeNull();
  });

  it('parses caddy-status.json', () => {
    const raw = { running: true, certificate: { names: ['soundsuite.vpn.bas.co'], notAfter: '2027-01-01T00:00:00Z' }, error: '' };
    const s = parseCaddyStatus(raw, 1000, 2000);
    expect(s?.running).toBe(true);
    expect(s?.certificate?.names).toEqual(['soundsuite.vpn.bas.co']);
    expect(s?.error).toBeNull();
    expect(parseCaddyStatus(raw, 1000, 1000 + 120_000)?.running).toBe(false);
  });
});

describe('netbird settings', () => {
  let work: string;
  let ctl: string;
  let opts: { env: Record<string, string | undefined>; fallbackDir: string; now: number };

  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-netbird-')));
    ctl = path.join(work, 'ctl');
    fs.mkdirSync(ctl);
    opts = { env: { NETBIRD_CTL_DIR: ctl }, fallbackDir: path.join(work, 'fallback'), now: Date.now() };
  });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  it('defaults to hostname soundsuite, port 0, not connected', () => {
    const v = getNetbirdView(opts);
    expect(v.configured).toBe(true);
    expect(v.hostname).toBe('soundsuite');
    expect(v.wireguardPort).toBe(0);
    expect(v.enabled).toBe(false);
    expect(v.status).toBeNull();
    expect(v.https.address).toBe('https://soundsuite.vpn.bas.co');
  });

  it('saves settings with mode 600 and never returns the secrets', () => {
    const v = updateNetbirdSettings({
      setupKey: KEY, enabled: true, wireguardPort: 51820,
      https: { enabled: true, cloudflareToken: TOKEN },
    }, opts);
    expect(v.hasKey).toBe(true);
    expect(v.keyHint).toBe('WXYZ');
    expect(v.https.tokenHint).toBe('ABCD');
    expect(v.wireguardPort).toBe(51820);
    const out = JSON.stringify(v);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(TOKEN);
    const file = path.join(ctl, 'config.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(cfg)).toEqual(['setupKey', 'hostname', 'managementUrl', 'wireguardPort', 'externalIpMap', 'enabled', 'https', 'updatedAt']);
    expect(cfg.setupKey).toBe(KEY);
  });

  it('saves the advertised public IP right after wireguardPort (sed reads it)', () => {
    const v = updateNetbirdSettings({ wireguardPort: 52003, externalIpMap: ' 99.92.186.153 ' }, opts);
    expect(v).toMatchObject({ wireguardPort: 52003, externalIpMap: '99.92.186.153' });
    const raw = fs.readFileSync(path.join(ctl, 'config.json'), 'utf8');
    expect(raw).toMatch(/^  "wireguardPort": 52003,\n  "externalIpMap": "99.92.186.153",$/m);
    expect(() => updateNetbirdSettings({ externalIpMap: 'not an ip' }, opts)).toThrow(/public IP/);
    expect(updateNetbirdSettings({ externalIpMap: '' }, opts).externalIpMap).toBe('');
  });

  it('keeps the saved key when a later save leaves it out', () => {
    updateNetbirdSettings({ setupKey: KEY }, opts);
    const v = updateNetbirdSettings({ hostname: 'soundsuite-2' }, opts);
    expect(v.hasKey).toBe(true);
    expect(v.hostname).toBe('soundsuite-2');
  });

  it('rejects bad input and writes nothing', () => {
    expect(() => updateNetbirdSettings({ enabled: true }, opts)).toThrow(NetbirdError);
    expect(() => updateNetbirdSettings({ hostname: 'Bad_Name' }, opts)).toThrow(/Hostname/);
    expect(() => updateNetbirdSettings({ wireguardPort: -1 }, opts)).toThrow(/WireGuard/);
    expect(() => updateNetbirdSettings({ https: { cloudflareToken: 'short' } }, opts)).toThrow(/Cloudflare/);
    expect(fs.existsSync(path.join(ctl, 'config.json'))).toBe(false);
  });

  it('removes the key (and turns off) and the token', () => {
    updateNetbirdSettings({ setupKey: KEY, enabled: true, https: { cloudflareToken: TOKEN } }, opts);
    let v = removeNetbirdKey(opts);
    expect(v.hasKey).toBe(false);
    expect(v.enabled).toBe(false);
    v = removeHttpsToken(opts);
    expect(v.https.hasToken).toBe(false);
  });

  it('reads status files from the container', () => {
    fs.writeFileSync(path.join(ctl, 'status.json'), JSON.stringify({ netbirdIp: '100.1.2.3/16', management: { connected: true } }));
    expect(getNetbirdView({ ...opts, now: Date.now() }).status?.connected).toBe(true);
  });

  it('uses the fallback folder when NETBIRD_CTL_DIR is missing', () => {
    const o = { ...opts, env: { NETBIRD_CTL_DIR: path.join(work, 'nope') } };
    expect(getNetbirdView(o).configured).toBe(false);
    updateNetbirdSettings({ hostname: 'local' }, o);
    expect(fs.existsSync(path.join(work, 'fallback', 'config.json'))).toBe(true);
  });
});
