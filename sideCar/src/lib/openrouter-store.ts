/**
 * Encrypted at-rest persistence for per-master OpenRouter config.
 *
 * WHY THIS EXISTS
 * ---------------
 * The config (key, allow-list, routing modes) used to live only in memory, so
 * every sidecar restart dropped it. A self-update restarts the process, which
 * meant shipping 2.4.4 silently de-configured the whole fleet: the master then
 * reported "no OpenRouter key configured", virtual containers vanished for
 * that slot, and nothing in either UI explained why. The master cannot repair
 * it either — it deliberately never stores the key, so its re-push carries
 * models and modes but not the secret.
 *
 * The key belongs here, on the host that actually spends it. This module keeps
 * it across restarts and re-encrypts whenever the master pushes a new one.
 *
 * THREAT MODEL — READ BEFORE TRUSTING IT
 * --------------------------------------
 * This protects the key from CASUAL disclosure: a config file copied into a
 * backup, a support bundle, a screen share, a `cat config.json`. It does NOT
 * protect against an attacker who can already run code as this user, because
 * the derivation material is on the same machine. That is an honest limit of
 * storing a usable secret on a host that must use it unattended, not an
 * oversight.
 *
 * Set SIDECAR_SECRET to derive from an operator-supplied passphrase instead of
 * machine material; then the file is useless without it. Without it, the
 * derivation falls back to stable host material so the sidecar can still come
 * back unattended after a reboot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from './logger';

const log = createLogger('openrouter-store');

const STORE_PATH = process.env.OPENROUTER_STORE_PATH
  || path.join(
    path.dirname(process.env.CONFIG_PATH
      || path.join(path.dirname(process.argv[1] || __filename), 'config', 'config.json')),
    'openrouter.enc.json',
  );

const MAGIC = 'ss-or-v1';
const ALGO = 'aes-256-gcm';

export interface StoredMasterConfig {
  apiKey: string;
  allowedModels: Record<string, unknown>;
  modeByRole: Record<string, string>;
  /** This master's declared ss-rlm-sandbox domain ('legal' | 'code'), if any.
   *  See virtual-inference.ts's SandboxDomain. Optional for back-compat with
   *  a store file written before this field existed. */
  domain?: string;
}

/** Key material: operator passphrase if provided, else stable host material.
 *  scrypt with a fixed salt — the salt is not the secret here, the material is. */
function derive(): Buffer {
  const material = process.env.SIDECAR_SECRET
    || `${os.hostname()}::${os.userInfo().username}::sound-suite-sidecar`;
  return crypto.scryptSync(material, 'sound-suite-openrouter-store', 32);
}

/** Persist every master's config, encrypted. Best effort: a failure to write
 *  must never take the sidecar down or block a push that already applied. */
export function saveOpenRouterStore(byMaster: Map<string, StoredMasterConfig>): void {
  try {
    const plain = JSON.stringify(
      Object.fromEntries([...byMaster.entries()].map(([url, cfg]) => [url, cfg])),
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, derive(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const payload = {
      magic: MAGIC,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
      savedAt: new Date().toISOString(),
    };
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    // Never log the key, or any prefix of it.
    log.info(`OpenRouter config persisted for ${byMaster.size} master(s)`);
  } catch (err) {
    log.warn(`could not persist OpenRouter config: ${(err as Error).message}`);
  }
}

/** Restore at boot. Returns an empty map on anything unexpected — a corrupt or
 *  undecryptable file means "not configured", never a crash. A changed
 *  SIDECAR_SECRET or a moved machine lands here, and the operator re-pushes. */
export function loadOpenRouterStore(): Map<string, StoredMasterConfig> {
  const out = new Map<string, StoredMasterConfig>();
  try {
    if (!fs.existsSync(STORE_PATH)) return out;
    const payload = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (payload?.magic !== MAGIC) {
      log.warn('OpenRouter store has an unexpected format — ignoring');
      return out;
    }
    const decipher = crypto.createDecipheriv(
      ALGO, derive(), Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    for (const [url, cfg] of Object.entries(JSON.parse(plain) as Record<string, StoredMasterConfig>)) {
      if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey) out.set(url, cfg);
    }
    log.info(`OpenRouter config restored for ${out.size} master(s)`);
  } catch (err) {
    // Wrong secret, truncated file, tampering — all the same outcome.
    log.warn(`could not restore OpenRouter config (re-push required): ${(err as Error).message}`);
    return new Map();
  }
  return out;
}

/** Forget a master's stored config — used when its slot is retired, so a URL
 *  later reused by a different master never inherits a stranger's key. */
export function dropFromOpenRouterStore(
  byMaster: Map<string, StoredMasterConfig>,
): void {
  saveOpenRouterStore(byMaster);
}
