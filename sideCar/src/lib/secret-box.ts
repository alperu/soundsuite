/**
 * Encryption for every API token the sidecar saves to disk
 * (master auth tokens, the NetBird setup key, the Cloudflare token, OpenRouter keys).
 *
 * Two keys:
 *   data key   32 random bytes, made once per install. AES-256-GCM encrypts each
 *              saved token with it. Stored in <config dir>/secret.key, wrapped.
 *   wrap key   scrypt hash of CODE_KEY (below, in the code) + SIDECAR_SECRET (env,
 *              optional) + a random salt from secret.key. It encrypts the data key.
 *
 * Saved values look like `enc:v1:<base64 iv|tag|ciphertext>`.
 *
 * LIMIT: this code is public, so CODE_KEY alone only stops casual reads (backups,
 * support bundles, `cat config.json`). Set SIDECAR_SECRET on the container and the
 * files are useless without it. Changing SIDECAR_SECRET later makes secret.key
 * unreadable: the tokens must then be entered again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CODE_KEY = Buffer.from('2ff31d37e79d0a201998991afad7aed246e7802cd38564393f79279eb166ee32', 'hex');
const PREFIX = 'enc:v1:';
export const KEY_FILE = 'secret.key';

export class SecretKeyError extends Error {}

/** Folder for secret.key and admin.json: SIDECAR_SECRET_DIR, else next to config.json. */
export function secretDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIDECAR_SECRET_DIR) return env.SIDECAR_SECRET_DIR;
  const cfg = env.CONFIG_PATH || path.join(path.dirname(process.argv[1] || __filename), 'config', 'config.json');
  return path.dirname(cfg);
}

function wrapKey(salt: Buffer, env: NodeJS.ProcessEnv): Buffer {
  const pass = Buffer.concat([CODE_KEY, Buffer.from(env.SIDECAR_SECRET?.trim() || '', 'utf8')]);
  return crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
}

function seal(key: Buffer, plain: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unseal(key: Buffer, b64: string): Buffer {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 29) throw new SecretKeyError('Encrypted value is too short.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export function writeFileAtomic(file: string, data: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

const cache = new Map<string, Buffer>();

/** The install's data key. Made on first use. Throws SecretKeyError if secret.key cannot be unlocked. */
export function dataKey(dir: string = secretDir(), env: NodeJS.ProcessEnv = process.env): Buffer {
  const file = path.join(dir, KEY_FILE);
  const ck = `${file}\0${env.SIDECAR_SECRET?.trim() || ''}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  let key: Buffer;
  if (fs.existsSync(file)) {
    let j: { v?: number; salt?: string; key?: string };
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new SecretKeyError(`${file} is not valid JSON.`); }
    if (j.v !== 1 || !j.salt || !j.key) throw new SecretKeyError(`${file} has an unknown format.`);
    try {
      key = unseal(wrapKey(Buffer.from(j.salt, 'base64'), env), j.key);
    } catch {
      throw new SecretKeyError(`Cannot unlock ${file}. Did SIDECAR_SECRET change?`);
    }
  } else {
    key = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const body = JSON.stringify({ v: 1, salt: salt.toString('base64'), key: seal(wrapKey(salt, env), key) }) + '\n';
    writeFileAtomic(file, body, 0o600);
  }
  cache.set(ck, key);
  return key;
}

export const isEncrypted = (v: string): boolean => v.startsWith(PREFIX);

export function encryptSecret(plain: string, dir?: string): string {
  return PREFIX + seal(dataKey(dir), Buffer.from(plain, 'utf8'));
}

/** Decrypts `enc:v1:` values. A value without the prefix is old plain text and is returned as is. */
export function decryptSecret(value: string, dir?: string): string {
  if (!isEncrypted(value)) return value;
  try {
    return unseal(dataKey(dir), value.slice(PREFIX.length)).toString('utf8');
  } catch (err) {
    if (err instanceof SecretKeyError) throw err;
    throw new SecretKeyError('Cannot decrypt a saved secret (wrong key or damaged value).');
  }
}

/** A separate key for one purpose (e.g. signing session cookies), derived from the data key. */
export function purposeKey(purpose: string, dir?: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', dataKey(dir), Buffer.alloc(0), `sidecar:${purpose}`, 32));
}

/** For tests. */
export function _clearKeyCache(): void { cache.clear(); }
