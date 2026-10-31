import * as http from 'http';
import * as https from 'https';
import { X509Certificate } from 'crypto';

/**
 * Client for the sidecar-receiver admin API (fileSystemSideCar,
 * crates/sidecar-receiver/src/admin.rs). Auth is the receiver's status token
 * (Bearer). The receiver keeps the Argon2 hash of each sync password;
 * SoundSuite never stores or logs one. Accounts are keyed by username. Each
 * account may carry allowed roots (empty = all); root names come from the receiver.
 *
 * Env:
 *   SIDECAR_RECEIVER_URL          e.g. http://soundsuite-receiver:8797 (admin_listen)
 *   SIDECAR_RECEIVER_TOKEN        the receiver's status token
 *   SIDECAR_RECEIVER_FINGERPRINT  optional SHA256 pin of the receiver's
 *                                 self-signed TLS cert ("SHA256:AB:CD:.." or hex)
 */

export const RECEIVER_URL_ENV = 'SIDECAR_RECEIVER_URL';
export const RECEIVER_TOKEN_ENV = 'SIDECAR_RECEIVER_TOKEN';
export const RECEIVER_FINGERPRINT_ENV = 'SIDECAR_RECEIVER_FINGERPRINT';
export const RECEIVER_TIMEOUT_MS = 5000;

/** Every receiver path in one place. */
export const RECEIVER_PATHS = {
  status: '/v1/status',
  accounts: '/v1/accounts',
  account: (username: string) => `/v1/accounts/${encodeURIComponent(username)}`,
  password: (username: string) => `/v1/accounts/${encodeURIComponent(username)}/password`,
  roots: (username: string) => `/v1/accounts/${encodeURIComponent(username)}/roots`,
};

export interface ReceiverAccount {
  id: string;
  username: string;
  /** Roots mapped or seen for this account. */
  roots: string[];
  /** Roots this account may use; empty = all roots. */
  allowedRoots: string[];
  lastLoginMs: number | null;
  connected: boolean;
}

export interface ReceiverListing {
  accounts: ReceiverAccount[];
  /** Every root name the receiver knows (map + seen). */
  roots: string[];
}

export class ReceiverError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export interface ReceiverSettings {
  url: string;
  token: string;
  fingerprint: string | null;
}

export function receiverSettings(env: NodeJS.ProcessEnv = process.env): ReceiverSettings | null {
  const url = env[RECEIVER_URL_ENV]?.trim();
  const token = env[RECEIVER_TOKEN_ENV]?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token, fingerprint: env[RECEIVER_FINGERPRINT_ENV]?.trim() || null };
}

/** "SHA256:AB:CD:..", "AB:CD:.." or plain hex → lower-case hex. */
export function normFingerprint(s: string): string {
  return s.trim().replace(/^sha256:/i, '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

export type Requester = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

/** HTTP(S) request with a 5 s limit; self-signed certs only with a matching pin. */
export function nodeRequester(s: ReceiverSettings, timeoutMs = RECEIVER_TIMEOUT_MS): Requester {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const u = new URL(s.url + path);
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string | number> = {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/json',
      };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const pin = s.fingerprint ? normFingerprint(s.fingerprint) : null;
      const opts: https.RequestOptions = { method, headers, timeout: timeoutMs };
      if (u.protocol === 'https:' && pin) {
        opts.rejectUnauthorized = false;
        opts.checkServerIdentity = () => undefined;
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, opts, (res) => {
        if (pin) {
          const raw = (res.socket as any)?.getPeerCertificate?.(false)?.raw as Buffer | undefined;
          const got = raw ? normFingerprint(new X509Certificate(raw).fingerprint256) : '';
          if (got !== pin) {
            res.destroy();
            reject(new ReceiverError('receiver TLS fingerprint does not match'));
            return;
          }
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { error: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('timeout', () => req.destroy(new ReceiverError(`receiver did not answer in ${timeoutMs / 1000} s`)));
      req.on('error', (e) => reject(e instanceof ReceiverError ? e : new ReceiverError(e.message)));
      if (payload) req.write(payload);
      req.end();
    });
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Root names from ["A", {name: "B"}, ...]; anything else → []. */
function rootNames(v: unknown): string[] {
  return Array.isArray(v) ? v.map((r: any) => String(isObj(r) ? r.name ?? '' : r)).filter(Boolean) : [];
}

/** Lenient parse of one account. Drops any hash-like field. */
export function parseAccount(v: unknown): ReceiverAccount | null {
  if (!isObj(v)) return null;
  const id = String(v.id ?? v.username ?? '');
  if (!id) return null;
  return {
    id,
    username: String(v.username ?? id),
    roots: rootNames(v.roots),
    allowedRoots: rootNames(v.allowed_roots ?? v.allowedRoots),
    lastLoginMs: num(v.last_login_ms) ?? num(v.lastLoginMs),
    connected: v.connected === true,
  };
}

/** `{accounts, roots}` (or a bare account array) → accounts + every known root name. */
export function parseListing(raw: unknown): ReceiverListing {
  const arr = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.accounts) ? raw.accounts : [];
  const accounts = (arr as unknown[]).map(parseAccount).filter((a): a is ReceiverAccount => !!a);
  const roots = new Set(isObj(raw) ? rootNames(raw.roots) : []);
  for (const a of accounts) for (const r of [...a.roots, ...a.allowedRoots]) roots.add(r);
  return { accounts, roots: [...roots].sort((a, b) => a.localeCompare(b)) };
}

/** Same set of root names, order and duplicates ignored. */
export function sameRoots(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((r) => y.has(r));
}

function errText(json: unknown, status: number): string {
  const e = isObj(json) ? json.error ?? json.message : null;
  return `receiver answered ${status}${e ? `: ${String(e).slice(0, 200)}` : ''}`;
}

export class ReceiverAdmin {
  constructor(private req: Requester) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ReceiverAdmin | null {
    const s = receiverSettings(env);
    return s ? new ReceiverAdmin(nodeRequester(s)) : null;
  }

  private async call(method: string, path: string, body?: unknown, okMissing = false): Promise<unknown> {
    const r = await this.req(method, path, body);
    if (okMissing && r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) {
      throw new ReceiverError(errText(r.json, r.status), r.status === 409 ? 409 : r.status === 400 ? 400 : 502);
    }
    return r.json;
  }

  /** GET /v1/accounts: accounts (no hashes) + every root name the receiver knows. */
  async listing(): Promise<ReceiverListing> {
    return parseListing(await this.call('GET', RECEIVER_PATHS.accounts));
  }

  /** GET /v1/accounts: id, username, roots, allowed roots, connected, last_login_ms (no hashes). */
  async list(): Promise<ReceiverAccount[]> {
    return (await this.listing()).accounts;
  }

  /** POST /v1/accounts; 409 when the username exists. Roots only when non-empty (absent = all). */
  async add(input: { username: string; password: string; roots?: string[] }): Promise<void> {
    const body: Record<string, unknown> = { username: input.username, password: input.password };
    if (input.roots?.length) body.roots = input.roots;
    await this.call('POST', RECEIVER_PATHS.accounts, body);
  }

  /** PUT /v1/accounts/{username}/roots; [] = all roots. Does not touch the password. */
  async setRoots(username: string, roots: string[]): Promise<void> {
    await this.call('PUT', RECEIVER_PATHS.roots(username), { roots });
  }

  async setPassword(username: string, password: string): Promise<void> {
    await this.call('PUT', RECEIVER_PATHS.password(username), { password });
  }

  /** Remove; a missing account is fine. 409 for the receiver's last account. */
  async remove(username: string): Promise<void> {
    await this.call('DELETE', RECEIVER_PATHS.account(username), undefined, true);
  }
}
