/**
 * `/api/admin/netbird` routes: admin only (401 signed out, 403 viewer),
 * secrets never in a reply. Temp folder; synthetic key.
 *
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';

let currentUser: { username: string; role: 'admin' | 'viewer' } | null = null;
jest.mock('@/lib/admin/auth', () => ({
  requireAdminAuth: jest.fn(async () => currentUser),
}));

import { GET, PUT } from '../route';
import { DELETE as DELETE_KEY } from '../key/route';

const KEY = 'A1B2C3D4-SYNTHETIC-KEY-WXYZ';
let work: string;
const savedEnv = process.env.NETBIRD_CTL_DIR;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-netbird-route-')));
  process.env.NETBIRD_CTL_DIR = work;
  currentUser = { username: 'admin', role: 'admin' };
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NETBIRD_CTL_DIR; else process.env.NETBIRD_CTL_DIR = savedEnv;
});

const req = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/admin/netbird', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });

describe('/api/admin/netbird', () => {
  it('401 when signed out, 403 for a viewer', async () => {
    currentUser = null;
    expect((await GET(req('GET'))).status).toBe(401);
    currentUser = { username: 'v', role: 'viewer' };
    expect((await GET(req('GET'))).status).toBe(403);
    expect((await PUT(req('PUT', { hostname: 'x' }))).status).toBe(403);
    expect(fs.existsSync(path.join(work, 'config.json'))).toBe(false);
  });

  it('GET shows Not connected defaults', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.hostname).toBe('soundsuite');
    expect(v.status).toBeNull();
  });

  it('PUT saves; the key never comes back', async () => {
    const res = await PUT(req('PUT', { setupKey: KEY, enabled: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).keyHint).toBe('WXYZ');
  });

  it('PUT answers 400 on bad input', async () => {
    const res = await PUT(req('PUT', { wireguardPort: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/WireGuard/);
  });

  it('DELETE key turns NetBird off', async () => {
    await PUT(req('PUT', { setupKey: KEY, enabled: true }));
    const v = await (await DELETE_KEY(req('DELETE'))).json();
    expect(v.hasKey).toBe(false);
    expect(v.enabled).toBe(false);
  });
});
