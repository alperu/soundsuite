/**
 * Persists per-tool configuration to the existing Config table
 * using the key prefix `mcp.tool.<toolName>`.
 */

import { prisma } from '../db/prisma';
import { ToolConfigEntry } from './tool-types';

export class ToolConfigStore {
  private prefix = 'mcp.tool.';

  async getToolConfig(toolName: string): Promise<ToolConfigEntry | null> {
    const row = await prisma.config.findUnique({ where: { key: this.prefix + toolName } });
    if (!row) return null;
    return JSON.parse(row.value) as ToolConfigEntry;
  }

  async setToolConfig(toolName: string, config: ToolConfigEntry): Promise<void> {
    const key = this.prefix + toolName;
    const value = JSON.stringify(config);
    await prisma.config.upsert({
      where: { key },
      update: { value, updatedAt: new Date() },
      create: { key, value },
    });
  }

  async getAllToolConfigs(): Promise<Map<string, ToolConfigEntry>> {
    const rows = await prisma.config.findMany({
      where: { key: { startsWith: this.prefix } },
    });
    const map = new Map<string, ToolConfigEntry>();
    for (const row of rows) {
      const toolName = row.key.slice(this.prefix.length);
      try {
        map.set(toolName, JSON.parse(row.value));
      } catch { /* skip corrupt entries */ }
    }
    return map;
  }
}
