import fs from 'fs';
import os from 'os';
import path from 'path';
import { KEY_FILE, SecretKeyError, _clearKeyCache, dataKey, decryptSecret, encryptSecret } from '../secret-box';
import {
  _resetLoginFails, checkPassword, createSession, loginBlocked, noteLoginFail, seedAdminFromEnv, sessionUser, setAdmin,
} from '../auth';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')); _clearKeyCache(); _resetLoginFails(); });
afterEach(() => { delete process.env.SIDECAR_SECRET; });

describe('secret-box', () => {
  test('round trip; ciphertext differs each time and hides the value', () => {
    const a = encryptSecret('cf_token_123', dir);
    const b = encryptSecret('cf_token_123', dir);
    expect(a).not.toBe(b);
    expect(a).not.toContain('cf_token_123');
    expect(decryptSecret(a, dir)).toBe('cf_token_123');
  });
  test('secret.key is wrapped, mode 600, and survives a restart', () => {
    const v = encryptSecret('x', dir);
    const f = path.join(dir, KEY_FILE);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).not.toContain(dataKey(dir).toString('base64'));
    _clearKeyCache();
    expect(decryptSecret(v, dir)).toBe('x');
  });
  test('plain text passes through (old config files)', () => {
    expect(decryptSecret('legacy-token', dir)).toBe('legacy-token');
  });
  test('a changed SIDECAR_SECRET cannot unlock the key', () => {
    process.env.SIDECAR_SECRET = 'one';
    const v = encryptSecret('x', dir);
    process.env.SIDECAR_SECRET = 'two';
    _clearKeyCache();
    expect(() => decryptSecret(v, dir)).toThrow(SecretKeyError);
  });
  test('a changed value fails', () => {
    const v = encryptSecret('x', dir);
    const bad = v.slice(0, -4) + (v.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(bad, dir)).toThrow(SecretKeyError);
  });
});

describe('auth', () => {
  test('password is hashed, never saved in plain text', () => {
    setAdmin('admin', 'correct horse battery', dir);
    expect(fs.readFileSync(path.join(dir, 'admin.json'), 'utf8')).not.toContain('correct horse');
    expect(checkPassword('admin', 'correct horse battery', dir)).toBe(true);
    expect(checkPassword('admin', 'wrong password!', dir)).toBe(false);
    expect(checkPassword('other', 'correct horse battery', dir)).toBe(false);
  });
  test('short passwords are refused', () => {
    expect(() => setAdmin('admin', 'short', dir)).toThrow(/10 characters/);
  });
  test('session: valid, expires, ends on password change, refuses a forged one', () => {
    setAdmin('admin', 'correct horse battery', dir);
    const s = createSession('admin', dir);
    expect(sessionUser(s, dir)).toBe('admin');
    expect(sessionUser(s, dir, Date.now() + 13 * 3600_000)).toBeNull();
    const [p] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'admin', g: 1, exp: Date.now() + 9e9 })).toString('base64url');
    expect(sessionUser(`${forged}.${s.split('.')[1]}`, dir)).toBeNull();
    expect(sessionUser(`${p}.AAAA`, dir)).toBeNull();
    setAdmin('admin', 'another long password', dir);
    expect(sessionUser(s, dir)).toBeNull();
  });
  test('env seeds the first admin only once', () => {
    seedAdminFromEnv(dir, { SIDECAR_ADMIN_PASSWORD: 'from env password' } as unknown as NodeJS.ProcessEnv);
    expect(checkPassword('admin', 'from env password', dir)).toBe(true);
    seedAdminFromEnv(dir, { SIDECAR_ADMIN_PASSWORD: 'second env password' } as unknown as NodeJS.ProcessEnv);
    expect(checkPassword('admin', 'from env password', dir)).toBe(true);
  });
  test('5 failed logins block the IP', () => {
    for (let i = 0; i < 5; i++) noteLoginFail('1.2.3.4');
    expect(loginBlocked('1.2.3.4')).toBe(true);
    expect(loginBlocked('5.6.7.8')).toBe(false);
  });
});
