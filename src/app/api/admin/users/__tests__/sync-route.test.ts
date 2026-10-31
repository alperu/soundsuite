/**
 * `/api/admin/users/sync` and `/api/admin/users/[id]/sync`: auth gates,
 * no secrets in replies.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

let currentUser: { username: string; role: 'admin' | 'viewer' } | null = null;
jest.mock('@/lib/admin/auth', () => ({ requireAdminAuth: jest.fn(async () => currentUser) }));
const syncView = jest.fn(async (_d: unknown, _o: unknown) => ({ configured: false, settings: { receiverUrl: 'not set', receiverToken: 'set' }, accounts: [], linked: [], error: null }));
const setSyncLogin = jest.fn(async (_id: string, _b: unknown) => ({ id: 'u1', username: 'alice', syncEnabled: true }));
jest.mock('@/lib/admin/sync-login', () => {
  class SyncLoginError extends Error { constructor(m: string, public status = 400) { super(m); } }
  return { syncView: (d: unknown, o: unknown) => syncView(d, o), setSyncLogin: (i: string, b: unknown) => setSyncLogin(i, b), SyncLoginError };
});

import { GET } from '../sync/route';
import { PUT } from '../[id]/sync/route';

const req = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/admin/users/sync', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
const params = { params: Promise.resolve({ id: 'u1' }) };

beforeEach(() => { syncView.mockClear(); setSyncLogin.mockClear(); });

describe('sync routes', () => {
  it('401 signed out', async () => {
    currentUser = null;
    expect((await GET(req('GET'))).status).toBe(401);
    expect((await PUT(req('PUT', {}), params)).status).toBe(401);
  });
  it('viewer can read but not link or change', async () => {
    currentUser = { username: 'v', role: 'viewer' };
    expect((await GET(req('GET'))).status).toBe(200);
    expect(syncView).toHaveBeenCalledWith({}, { link: false });
    expect((await PUT(req('PUT', { enabled: true, password: 'synthetic-pass' }), params)).status).toBe(403);
    expect(setSyncLogin).not.toHaveBeenCalled();
  });
  it('admin links on read and can change; password never echoed', async () => {
    currentUser = { username: 'a', role: 'admin' };
    await GET(req('GET'));
    expect(syncView).toHaveBeenCalledWith({}, { link: true });
    const r = await PUT(req('PUT', { enabled: true, password: 'synthetic-pass' }), params);
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain('synthetic-pass');
  });
});
