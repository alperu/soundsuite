/**
 * In-memory ring buffer for tool execution records.
 * Default capacity: 10,000 entries — no database persistence needed.
 */

import { ToolExecutionRecord, ToolStats } from './tool-types';
import { randomUUID } from 'crypto';

export class ToolExecutionLogger {
  private records: ToolExecutionRecord[] = [];
  private capacity: number;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  /** Record a new execution. Returns the generated record. */
  record(entry: Omit<ToolExecutionRecord, 'id' | 'timestamp'>): ToolExecutionRecord {
    const record: ToolExecutionRecord = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records = this.records.slice(-this.capacity);
    }
    return record;
  }

  /** Count executions within a time window (used for rate-limiting). */
  getRecentExecutionCount(toolName: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.records.filter(
      r => r.toolName === toolName && new Date(r.timestamp).getTime() >= cutoff
    ).length;
  }

  /** Aggregated stats, optionally filtered by tool name. */
  getStats(toolName?: string): ToolStats[] {
    const grouped = new Map<string, ToolExecutionRecord[]>();
    for (const r of this.records) {
      if (toolName && r.toolName !== toolName) continue;
      const list = grouped.get(r.toolName) || [];
      list.push(r);
      grouped.set(r.toolName, list);
    }

    const stats: ToolStats[] = [];
    for (const [name, recs] of grouped) {
      const successCount = recs.filter(r => r.success).length;
      const errorCount = recs.length - successCount;
      const avgTime = recs.reduce((sum, r) => sum + r.executionTimeMs, 0) / recs.length;
      const last = recs[recs.length - 1];
      stats.push({
        toolName: name,
        totalExecutions: recs.length,
        successCount,
        errorCount,
        avgExecutionTimeMs: Math.round(avgTime),
        lastExecutedAt: last?.timestamp ?? null,
      });
    }
    return stats;
  }

  /** Recent execution records for display. */
  getRecentRecords(toolName?: string, limit = 50): ToolExecutionRecord[] {
    let filtered = this.records;
    if (toolName) {
      filtered = filtered.filter(r => r.toolName === toolName);
    }
    return filtered.slice(-limit).reverse();
  }
}
