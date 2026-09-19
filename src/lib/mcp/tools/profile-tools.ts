/**
 * `profile_list` / `profile_use` — profiles over MCP (docs/tasks/54-profiles.md).
 *
 * One active profile per server (design A). `profile_use` switches it for
 * EVERYONE — the dashboard included — and every tool result afterwards
 * carries `profile: <name>` so a client can confirm what it is reading. The
 * `expectProfile` guard on every tool (see `tool-registry.ts`) is the belt to
 * this brace: a call that names a profile other than the active one is
 * refused with PROFILE_MISMATCH instead of quietly answering from the wrong
 * data.
 *
 * Both profiles, `category: 'search'` (no LLM), no dependencies: switching
 * data sets must work on a degraded fleet.
 */
import { BaseMCPTool } from './base-tool';
import type { ToolConfigEntry, ToolExecutionContext, ToolMetadata } from '../tool-types';
import { McpError } from '../llm-policy';
import { activeProfileName, readManifest } from '@/lib/profiles';
import { listProfilesWithCases, type ProfilesListing } from '@/lib/profiles/service';
import { switchProfile, type SwitchResult } from '@/lib/profiles/switch';

export class ProfileListTool extends BaseMCPTool<{ includeCases?: boolean }, ProfilesListing> {
  getMetadata(): ToolMetadata {
    return {
      name: 'profile_list',
      displayName: 'List Profiles',
      description:
        'List every data profile on this server, which one is ACTIVE, and the cases each holds ' +
        '(id, name, caseNumber, document count). A profile is a separate SQLite + LanceDB data set ' +
        '(data/<name>/). Every other tool reads the active profile only; call this first when the ' +
        'operator names a profile ("work with Demo") and switch with profile_use if it is not the ' +
        'active one. Pass expectProfile:<name> on any tool to have the call refused if the active ' +
        'profile is different.',
      version: '1.0.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          includeCases: { type: 'boolean', description: 'Include the case list per profile (default true).' },
        },
        required: [],
      },
    };
  }

  getDependencies() {
    return [];
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  async executeImpl(params: { includeCases?: boolean }): Promise<ProfilesListing> {
    return listProfilesWithCases({ includeCases: params?.includeCases !== false });
  }
}

export class ProfileUseTool extends BaseMCPTool<{ name: string }, SwitchResult & { active: string }> {
  getMetadata(): ToolMetadata {
    return {
      name: 'profile_use',
      displayName: 'Use Profile',
      description:
        'Make a profile the ACTIVE one for the whole server — dashboard, MCP and APIs all read it ' +
        'from now on. Restarts the file watcher, parsing workers and search index handle against ' +
        'the new data set (a few seconds; an in-flight parse is re-queued). Say which profile you ' +
        'are on when you report results. Names come from profile_list.',
      version: '1.0.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Profile name exactly as profile_list reports it.' },
        },
        required: ['name'],
      },
    };
  }

  getDependencies() {
    return [];
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  async executeImpl(params: { name: string }, context: ToolExecutionContext, _config: ToolConfigEntry) {
    const name = params.name.trim();
    if (!readManifest(name)) {
      throw new McpError('NOT_FOUND', `profile not found: ${name}. profile_list names the ones that exist.`);
    }
    const result = await switchProfile(name);
    context.logger?.info?.('profile_use', { from: result.from, to: result.to, changed: result.changed });
    return { ...result, active: activeProfileName() };
  }
}

export function getProfileTools(): BaseMCPTool[] {
  return [new ProfileListTool(), new ProfileUseTool()];
}
