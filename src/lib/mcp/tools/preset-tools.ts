/**
 * `preset_*` tools for the `routed` profile (REPORT-v2.1 Part C.2, work
 * item 8).
 *
 * - preset_list / preset_get   — read saved presets (v1 rows upgraded on read)
 * - preset_define              — validate an inline preset → session handle `tmp_…`
 * - preset_apply               — make a saved preset or handle active for this
 *                                MCP session (`context.sessionId`)
 * - preset_save / preset_delete — persist / remove
 *
 * `getPresetTools()` returns these six plus `routing_explain` so the
 * registry wires the whole Part B/C surface with one call.
 */

import { BaseMCPTool } from './base-tool';
import type { ToolMetadata, ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { PresetV2, ResearchTier, TierSettings } from '../research-types';
import { McpError } from '../llm-policy';
import { validatePreset } from '../presets/preset-schema';
import { deletePreset, getPreset, listPresets, savePreset } from '../presets/preset-store';
import { defineTemp, getActive, getTemp, isTempHandle, setActive } from '../presets/preset-session';
import { RoutingExplainTool } from './routed-routing-explain';

const PROFILES: ToolMetadata['profiles'] = ['routed'];

function invalid(message: string): never {
  throw new McpError('INVALID_PARAMS', message);
}

/** One-line routing summary for listings, e.g. "deep→anthropic/claude-sonnet-5, deep-report→…". */
export function summariseRouting(routing?: Partial<Record<ResearchTier, TierSettings>>): string {
  if (!routing) return 'no routing table (defaults apply)';
  const parts = Object.entries(routing).map(([tier, s]) => {
    if (!s) return `${tier}→?`;
    const bits = [`${s.provider}${s.model ? '/' + s.model : ''}`];
    if (s.effort) bits.push(s.effort);
    if (s.thinking) bits.push('thinking');
    if (s.multiPass) bits.push('multiPass');
    if (s.useRlm) bits.push(`rlm×${s.rlmMaxRounds ?? '?'}`);
    return `${tier}→${bits.join(' ')}`;
  });
  return parts.length ? parts.join(', ') : 'no routing table (defaults apply)';
}

// ---------------------------------------------------------------------------

export interface PresetListResult {
  presets: Array<{ id: string; name: string; storedVersion: number; routing: string; updatedAt: string }>;
  active?: { source: 'temp' | 'saved' | 'default'; ref: string; name: string };
}

export class PresetListTool extends BaseMCPTool<Record<string, never>, PresetListResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_list',
      displayName: 'List Presets',
      description: 'List saved search presets (id, name, one-line routing summary) and the preset active for this session.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
  }

  async executeImpl(_params: Record<string, never>, context: ToolExecutionContext): Promise<PresetListResult> {
    const presets = await listPresets();
    const active = getActive(context.sessionId);
    return {
      presets: presets.map((p) => ({
        id: p.id,
        name: p.name,
        storedVersion: p.storedVersion,
        routing: summariseRouting(p.preset.routing),
        updatedAt: p.updatedAt,
      })),
      ...(active ? { active: { source: active.source, ref: active.ref, name: active.preset.name } } : {}),
    };
  }
}

// ---------------------------------------------------------------------------

export interface PresetGetParams { idOrName: string }
export interface PresetGetResult { id: string; storedVersion: number; preset: PresetV2 }

export class PresetGetTool extends BaseMCPTool<PresetGetParams, PresetGetResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_get',
      displayName: 'Get Preset',
      description: 'Fetch a saved preset by id or name as a full PresetV2 object (v1 dashboard presets are upgraded on read).',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: { idOrName: { type: 'string', description: 'Preset id or exact name' } },
        required: ['idOrName'],
      },
    };
  }

  validateParams(params: PresetGetParams): void {
    if (typeof params?.idOrName !== 'string' || !params.idOrName.trim()) invalid('idOrName is required');
  }

  async executeImpl(params: PresetGetParams): Promise<PresetGetResult> {
    if (isTempHandle(params.idOrName)) {
      const temp = getTemp(params.idOrName);
      if (!temp) throw new McpError('NOT_FOUND', `handle "${params.idOrName}" is unknown or expired`);
      return { id: params.idOrName, storedVersion: 0, preset: temp };
    }
    const stored = await getPreset(params.idOrName);
    if (!stored) throw new McpError('NOT_FOUND', `preset "${params.idOrName}" not found`);
    return { id: stored.id, storedVersion: stored.storedVersion, preset: stored.preset };
  }
}

// ---------------------------------------------------------------------------

export interface PresetDefineParams { preset: unknown }
export interface PresetDefineResult { handle: string; warnings: string[]; preset: PresetV2; expiresInSeconds: number }

export class PresetDefineTool extends BaseMCPTool<PresetDefineParams, PresetDefineResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_define',
      displayName: 'Define Preset',
      description:
        'Validate an inline PresetV2 (routing table per tier: provider/model/effort/thinking/maxTokens/multiPass/useRlm) and return a session-scoped tmp_ handle that lives 1 h and is never persisted. Fails if a named provider is not configured.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: {
          preset: {
            type: 'object',
            description: 'PresetV2: { version: 2, name, routing?: { fast?, deep?, deep-report?, deep-rlm? }, retrieval?, …UI knobs }',
          },
        },
        required: ['preset'],
      },
    };
  }

  validateParams(params: PresetDefineParams): void {
    if (!params?.preset || typeof params.preset !== 'object') invalid('preset object is required');
  }

  async executeImpl(params: PresetDefineParams): Promise<PresetDefineResult> {
    const result = await validatePreset(params.preset);
    if (!result.ok) throw new McpError('INVALID_PRESET', result.errors.join('; '));
    const handle = defineTemp(result.preset);
    return { handle, warnings: result.warnings, preset: result.preset, expiresInSeconds: 3600 };
  }
}

// ---------------------------------------------------------------------------

export interface PresetApplyParams { idOrName?: string; handle?: string }
export interface PresetApplyResult { applied: { source: 'temp' | 'saved' | 'default'; ref: string; name: string }; routing: string; sessionId: string }

export class PresetApplyTool extends BaseMCPTool<PresetApplyParams, PresetApplyResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_apply',
      displayName: 'Apply Preset',
      description: 'Make a saved preset (idOrName) or a tmp_ handle (handle) the active preset for this MCP session. Idle expiry 1 h.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Saved preset id or name' },
          handle: { type: 'string', description: 'tmp_ handle from preset_define' },
        },
        required: [],
      },
    };
  }

  validateParams(params: PresetApplyParams): void {
    const ref = params?.handle ?? params?.idOrName;
    if (typeof ref !== 'string' || !ref.trim()) invalid('idOrName or handle is required');
  }

  async executeImpl(params: PresetApplyParams, context: ToolExecutionContext): Promise<PresetApplyResult> {
    const ref = (params.handle ?? params.idOrName)!.trim();
    const active = await setActive(context.sessionId, ref);
    return {
      applied: { source: active.source, ref: active.ref, name: active.preset.name },
      routing: summariseRouting(active.preset.routing),
      sessionId: context.sessionId ?? 'anonymous',
    };
  }
}

// ---------------------------------------------------------------------------

export interface PresetSaveParams { handle: string; name?: string; id?: string }
export interface PresetSaveResult { id: string; name: string; preset: PresetV2 }

export class PresetSaveTool extends BaseMCPTool<PresetSaveParams, PresetSaveResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_save',
      displayName: 'Save Preset',
      description: 'Persist a preset defined with preset_define to the saved presets (SearchPreset) under `name`. Pass `id` to overwrite an existing saved preset.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'tmp_ handle from preset_define' },
          name: { type: 'string', description: 'Name to save under (defaults to the preset\'s own name)' },
          id: { type: 'string', description: 'Existing saved preset id to overwrite' },
        },
        required: ['handle'],
      },
    };
  }

  validateParams(params: PresetSaveParams): void {
    if (typeof params?.handle !== 'string' || !isTempHandle(params.handle)) invalid('handle (tmp_…) is required');
  }

  async executeImpl(params: PresetSaveParams): Promise<PresetSaveResult> {
    const temp = getTemp(params.handle);
    if (!temp) throw new McpError('NOT_FOUND', `handle "${params.handle}" is unknown or expired`);
    const name = (params.name ?? temp.name).trim();
    if (!name) invalid('name is required');
    const preset: PresetV2 = { ...temp, name };
    const saved = await savePreset(preset, params.id);
    return { id: saved.id, name: saved.name, preset: saved.preset };
  }
}

// ---------------------------------------------------------------------------

export interface PresetDeleteParams { id: string }
export interface PresetDeleteResult { deleted: boolean; id: string }

export class PresetDeleteTool extends BaseMCPTool<PresetDeleteParams, PresetDeleteResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'preset_delete',
      displayName: 'Delete Preset',
      description: 'Delete a saved preset by id.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Saved preset id' } },
        required: ['id'],
      },
    };
  }

  validateParams(params: PresetDeleteParams): void {
    if (typeof params?.id !== 'string' || !params.id.trim()) invalid('id is required');
  }

  async executeImpl(params: PresetDeleteParams): Promise<PresetDeleteResult> {
    const deleted = await deletePreset(params.id.trim());
    return { deleted, id: params.id.trim() };
  }
}

// ---------------------------------------------------------------------------

/** All Part C preset tools plus `routing_explain`. */
export function getPresetTools(): BaseMCPTool[] {
  return [
    new PresetListTool(),
    new PresetGetTool(),
    new PresetDefineTool(),
    new PresetApplyTool(),
    new PresetSaveTool(),
    new PresetDeleteTool(),
    new RoutingExplainTool(),
  ];
}
