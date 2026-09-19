/** @jest-environment node */

/**
 * Which Prisma models are machine-wide (shared `data/system.db`) and which
 * follow the active profile (docs/tasks/56-system-db.md). The split is a
 * list, so the list is the test: a model added to the schema that describes
 * the fleet or logins must be added here or it silently becomes per-profile.
 */
import { SYSTEM_MODELS, SYSTEM_TABLES, isSystemModel } from '../prisma';

describe('system models', () => {
  it('routes fleet, provisioning, sidecar queue, admin and MCP sessions to the system database', () => {
    for (const m of ['hostRoleAssignment', 'hostProvisioning', 'sidecarCommand', 'adminUser', 'mcpSession', 'modelDownload']) {
      expect(isSystemModel(m)).toBe(true);
    }
  });

  it('keeps case data and per-profile settings on the profile', () => {
    for (const m of ['case', 'document', 'filing', 'motion', 'config', 'chatAttachment', 'searchPreset', 'actionLog', 'court']) {
      expect(isSystemModel(m)).toBe(false);
    }
    expect(isSystemModel(Symbol('x'))).toBe(false);
    expect(isSystemModel('$transaction')).toBe(false);
  });

  it('names one table per system model', () => {
    expect(SYSTEM_TABLES.length).toBe(SYSTEM_MODELS.size);
    for (const t of SYSTEM_TABLES) expect(SYSTEM_MODELS.has(t[0].toLowerCase() + t.slice(1))).toBe(true);
  });
});
