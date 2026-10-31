/**
 * Sidecar sync login: receiver admin client + user link/update logic.
 * Fake receiver; synthetic passwords only.
 *
 * @jest-environment node
 */
const rows: any[] = [];
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    adminUser: {
      findUnique: jest.fn(async ({ where }: any) => rows.find(r => (where.id ? r.id === where.id : r.username === where.username)) ?? null),
      findMany: jest.fn(async () => rows.map(r => ({ id: r.id, username: r.username }))),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `u${rows.length + 1}`, enabled: true, createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, dashboardLogin: true, syncEnabled: false, syncRoots: '[]', syncLastLoginAt: null, ...data };
        rows.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.find(x => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
  },
}));

import { ReceiverAdmin, parseAccount, normFingerprint, RECEIVER_PATHS, type Requester } from '../receiver-admin';
import { linkAccounts, setSyncLogin, syncView, removeSyncLoginFor, cleanRoots, SyncLoginError } from '../sync-login';
import { toPublic } from '../user-store';

const PW = 'synthetic-pass-123';

function fakeReceiver(initial: any[] = []) {
  const accounts = [...initial];
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const req: Requester = async (method, path, b) => {
    const body = b as any;
    calls.push({ method, path, body });
    if (method === 'GET' && path === RECEIVER_PATHS.accounts) return { status: 200, json: { accounts, roots: ['Mapped', 'Seen'] } };
    if (method === 'POST' && path === RECEIVER_PATHS.accounts) {
      if (accounts.some(a => a.username === body.username)) return { status: 409, json: { error: 'exists' } };
      accounts.push({ id: body.username, username: body.username, roots: ['Mapped'], allowed_roots: body.roots ?? [], connected: false, last_login_ms: null });
      return { status: 201, json: { accounts } };
    }
    const m = path.match(/^\/v1\/accounts\/([^/]+)(\/password|\/roots)?$/);
    const a = m && accounts.find(x => x.username === decodeURIComponent(m[1]));
    if (!a) return { status: 404, json: { error: 'no account' } };
    if (method === 'DELETE') {
      if (accounts.length === 1) return { status: 409, json: { error: 'cannot remove the last account' } };
      accounts.splice(accounts.indexOf(a), 1);
      return { status: 200, json: { accounts } };
    }
    if (method === 'PUT' && m![2] === '/roots') {
      a.allowed_roots = body.roots;
      return { status: 200, json: { accounts } };
    }
    if (method === 'PUT' && m![2]) return { status: 200, json: { accounts } };
    return { status: 400, json: {} };
  };
  return { rx: new ReceiverAdmin(req), accounts, calls };
}

const user = (over: any = {}) => {
  const r = { id: `u${rows.length + 1}`, username: 'alice', passwordHash: 'x', role: 'admin', enabled: true, createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, dashboardLogin: true, syncEnabled: false, syncRoots: '[]', syncLastLoginAt: null, ...over };
  rows.push(r);
  return r;
};

beforeEach(() => { rows.length = 0; });

describe('receiver-admin', () => {
  it('parses accounts leniently and drops hash fields', () => {
    const a = parseAccount({ id: 'mac', username: 'mac', password_hash: '$argon2id$x', roots: ['A', { name: 'B' }], last_login_ms: 5 });
    expect(a).toEqual({ id: 'mac', username: 'mac', roots: ['A', 'B'], allowedRoots: [], lastLoginMs: 5, connected: false });
    expect(JSON.stringify(a)).not.toContain('argon');
    expect(parseAccount(null)).toBeNull();
  });
  it('normalises fingerprints', () => {
    expect(normFingerprint('SHA256:AB:cd:01')).toBe('abcd01');
  });
  it('list reads { accounts } from GET /v1/accounts', async () => {
    const { rx, calls } = fakeReceiver([{ id: 'live', username: 'live', roots: ['A'], connected: true, last_login_ms: 7 }, { id: 'idle', username: 'idle', roots: [], connected: false }]);
    const l = await rx.list();
    expect(l.map(a => [a.username, a.connected, a.lastLoginMs])).toEqual([['live', true, 7], ['idle', false, null]]);
    expect(calls.map(c => c.path)).toEqual(['/v1/accounts']);
  });
});

describe('cleanRoots', () => {
  it('trims, dedupes and rejects paths', () => {
    expect(cleanRoots([' A ', 'A', 'B'])).toEqual(['A', 'B']);
    expect(cleanRoots('A, B')).toEqual(['A', 'B']);
    expect(() => cleanRoots(['a/b'])).toThrow(SyncLoginError);
    expect(() => cleanRoots(['..'])).toThrow(SyncLoginError);
  });
});

describe('linkAccounts', () => {
  it('creates a viewer with dashboard login off when no user matches', async () => {
    const linked = await linkAccounts([{ id: 'mac-alper-soundsuite', username: 'mac-alper-soundsuite', roots: ['AlpersWar'], allowedRoots: ['AlpersWar'], lastLoginMs: 1000, connected: true }]);
    expect(linked).toEqual(['mac-alper-soundsuite']);
    expect(rows[0]).toMatchObject({ username: 'mac-alper-soundsuite', role: 'viewer', dashboardLogin: false, syncEnabled: true, syncRoots: '["AlpersWar"]' });
    // second run: nothing new, no password touched
    const hash = rows[0].passwordHash;
    expect(await linkAccounts([{ id: 'mac-alper-soundsuite', username: 'mac-alper-soundsuite', roots: ['AlpersWar'], allowedRoots: ['AlpersWar'], lastLoginMs: 1000, connected: true }])).toEqual([]);
    expect(rows[0].passwordHash).toBe(hash);
  });
  it('links an existing user without changing its role or password', async () => {
    const u = user({ username: 'bob', role: 'admin', passwordHash: 'keep' });
    await linkAccounts([{ id: 'bob', username: 'bob', roots: [], allowedRoots: [], lastLoginMs: null, connected: false }]);
    expect(u).toMatchObject({ role: 'admin', passwordHash: 'keep', syncEnabled: true, dashboardLogin: true });
  });
});

describe('setSyncLogin', () => {
  it('turn on needs a password, adds the account, never stores it', async () => {
    const u = user();
    const { rx, accounts, calls } = fakeReceiver([{ id: 'other', username: 'other', roots: [] }]);
    await expect(setSyncLogin(u.id, { enabled: true }, { receiver: rx })).rejects.toThrow(/sync password/);
    await expect(setSyncLogin(u.id, { enabled: true, password: 'short' }, { receiver: rx })).rejects.toThrow(/at least 8/);
    const pub = await setSyncLogin(u.id, { enabled: true, password: PW, roots: ['Mapped'] }, { receiver: rx });
    expect(accounts.map(a => a.username)).toEqual(['other', 'alice']);
    expect(pub).toMatchObject({ syncEnabled: true, syncRoots: ['Mapped'] });
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ username: 'alice', password: PW, roots: ['Mapped'] });
    expect(JSON.stringify(rows)).not.toContain(PW);
    expect(JSON.stringify(pub)).not.toContain(PW);
    expect(calls.find(c => c.method === 'POST')!.body.password).toBe(PW);
  });
  it('changes the password of an existing account, then turns off', async () => {
    const u = user({ syncEnabled: true, syncRoots: '[]' });
    const { rx, accounts, calls } = fakeReceiver([{ id: 'alice', username: 'alice', roots: ['A'], allowed_roots: ['A'] }, { id: 'keep', username: 'keep', roots: [] }]);
    await setSyncLogin(u.id, { password: PW }, { receiver: rx });
    expect(calls.some(c => c.method === 'PUT' && c.path === RECEIVER_PATHS.password('alice'))).toBe(true);
    expect(calls.some(c => c.path === RECEIVER_PATHS.roots('alice'))).toBe(false);
    expect(u.syncRoots).toBe('["A"]');
    await setSyncLogin(u.id, { enabled: false }, { receiver: rx });
    expect(accounts.map(a => a.username)).toEqual(['keep']);
    expect(u.syncEnabled).toBe(false);
  });
  it('sends allowed roots only when they differ; never touches the password or other accounts', async () => {
    const u = user({ syncEnabled: true, syncRoots: '["A","B"]' });
    const { rx, accounts, calls } = fakeReceiver([{ id: 'alice', username: 'alice', roots: ['A', 'B'], allowed_roots: ['A', 'B'] }, { id: 'keep', username: 'keep', roots: [], allowed_roots: ['K'] }]);
    // same set, other order: no roots call
    await setSyncLogin(u.id, { enabled: true, roots: ['B', 'A'] }, { receiver: rx });
    expect(calls.filter(c => c.method !== 'GET')).toEqual([]);
    // changed: one PUT /roots, no password call
    const pub = await setSyncLogin(u.id, { enabled: true, roots: ['B'] }, { receiver: rx });
    const writes = calls.filter(c => c.method !== 'GET');
    expect(writes).toEqual([{ method: 'PUT', path: RECEIVER_PATHS.roots('alice'), body: { roots: ['B'] } }]);
    expect(pub.syncRoots).toEqual(['B']);
    expect(accounts.find(a => a.username === 'keep')!.allowed_roots).toEqual(['K']);
    // [] = all roots
    await setSyncLogin(u.id, { enabled: true, roots: [] }, { receiver: rx });
    expect(calls.filter(c => c.method !== 'GET').pop()).toEqual({ method: 'PUT', path: RECEIVER_PATHS.roots('alice'), body: { roots: [] } });
    // new account with no roots: POST without a roots field
    const v = user({ username: 'vic' });
    await setSyncLogin(v.id, { enabled: true, password: PW, roots: [] }, { receiver: rx });
    expect(calls.filter(c => c.method === 'POST').pop()!.body).toEqual({ username: 'vic', password: PW });
  });
  it('syncView lists every receiver root name', async () => {
    const { rx } = fakeReceiver([{ id: 'a', username: 'a', roots: ['X'], allowed_roots: ['Y'] }]);
    const view = await syncView({ receiver: rx, env: {} as any });
    expect(view.roots).toEqual(['Mapped', 'Seen', 'X', 'Y']);
    expect(view.accounts[0]).toMatchObject({ roots: ['X'], allowedRoots: ['Y'] });
  });
  it('the last receiver account cannot be removed: 409, database unchanged', async () => {
    const u = user({ syncEnabled: true });
    const { rx } = fakeReceiver([{ id: 'alice', username: 'alice', roots: [] }]);
    await expect(setSyncLogin(u.id, { enabled: false }, { receiver: rx })).rejects.toMatchObject({ status: 409 });
    expect(u.syncEnabled).toBe(true);
  });
  it('a receiver failure leaves the database unchanged', async () => {
    const u = user();
    const rx = new ReceiverAdmin(async () => ({ status: 500, json: { error: 'boom' } }));
    await expect(setSyncLogin(u.id, { enabled: true, password: PW }, { receiver: rx })).rejects.toMatchObject({ status: 502 });
    expect(u.syncEnabled).toBe(false);
  });
  it('409 when the receiver is not set up', async () => {
    const u = user();
    await expect(setSyncLogin(u.id, { enabled: true, password: PW }, { receiver: null })).rejects.toMatchObject({ status: 409 });
  });
  it('removeSyncLoginFor drops the receiver account', async () => {
    const u = user({ syncEnabled: true });
    const { rx, accounts } = fakeReceiver([{ id: 'alice', username: 'alice', roots: [] }, { id: 'b', username: 'b', roots: [] }]);
    await removeSyncLoginFor(u.id, { receiver: rx });
    expect(accounts.map(a => a.username)).toEqual(['b']);
  });
});

describe('syncView', () => {
  it('says not set up without env, shows set / not set only', async () => {
    const v = await syncView({ receiver: null, env: { SIDECAR_RECEIVER_TOKEN: 'secret-token' } as any });
    expect(v).toMatchObject({ configured: false, settings: { receiverUrl: 'not set', receiverToken: 'set' } });
    expect(JSON.stringify(v)).not.toContain('secret-token');
  });
  it('shows the error and no accounts when the receiver fails', async () => {
    const rx = new ReceiverAdmin(async () => { throw new Error('down'); });
    const v = await syncView({ receiver: rx, env: {} as any });
    expect(v).toMatchObject({ configured: true, error: 'down', accounts: [] });
  });
});

describe('toPublic', () => {
  it('never carries the password hash', () => {
    const p = toPublic(user({ passwordHash: 'HASHVALUE' }));
    expect(JSON.stringify(p)).not.toContain('HASHVALUE');
  });
});
