/**
 * @jest-environment node
 *
 * A stale master entry became undeletable: it was retired at runtime (so absent
 * from the live map, so DELETE 404'd) yet still present in config.json, so it was
 * re-created on every boot. With no wsPort it dialled `wsPort ?? 3002` — another
 * master's relay — and the two slots evicted each other indefinitely.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-blocklist-'));
process.env.CONFIG_PATH = path.join(TMP, 'config.json');

function writeConfig(obj: unknown) {
  fs.writeFileSync(process.env.CONFIG_PATH as string, JSON.stringify(obj, null, 2));
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfg = require('../config');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('persistedOnlyMasters', () => {
  it('reports an entry that is in the file but has no live slot', () => {
    writeConfig({ masters: [
      { serverUrl: 'http://192.0.2.10:3000', wsPort: 3002 },
      { serverUrl: 'http://192.0.2.99:3000' },            // stale, no wsPort
    ]});
    const orphans = cfg.persistedOnlyMasters(['http://192.0.2.10:3000']);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].serverUrl).toBe('http://192.0.2.99:3000');
    // null wsPort is the dangerous case: it dials the 3002 default.
    expect(orphans[0].wsPort).toBeNull();
  });

  it('does not report a live master as an orphan, ignoring a trailing slash', () => {
    writeConfig({ masters: [{ serverUrl: 'http://192.0.2.10:3000/', wsPort: 3002 }] });
    expect(cfg.persistedOnlyMasters(['http://192.0.2.10:3000'])).toHaveLength(0);
  });
});

describe('the block-list', () => {
  it('records a removal and reports it blocked, trailing slash or not', () => {
    cfg.blockMaster('http://192.0.2.99:3000');
    expect(cfg.isMasterBlocked('http://192.0.2.99:3000')).toBe(true);
    expect(cfg.isMasterBlocked('http://192.0.2.99:3000/')).toBe(true);
    expect(cfg.isMasterBlocked('http://192.0.2.10:3000')).toBe(false);
  });

  it('unblocking allows a deliberate re-add', () => {
    cfg.blockMaster('http://192.0.2.55:3000');
    expect(cfg.isMasterBlocked('http://192.0.2.55:3000')).toBe(true);
    expect(cfg.unblockMaster('http://192.0.2.55:3000')).toBe(true);
    expect(cfg.isMasterBlocked('http://192.0.2.55:3000')).toBe(false);
  });

  it('survives a reboot — seeding from disk restores removals', () => {
    // The whole point: without persistence, loadSavedConfig() re-creates the slot
    // and "Remove" silently undoes itself on the next restart.
    jest.resetModules();
    writeConfig({
      masters: [{ serverUrl: 'http://192.0.2.10:3000', wsPort: 3002 }],
      blockedMasters: ['http://192.0.2.99:3000'],
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fresh = require('../config');
    fresh.loadSavedConfig();               // seeds the block-list
    expect(fresh.isMasterBlocked('http://192.0.2.99:3000')).toBe(true);
  });
});
