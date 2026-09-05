/**
 * Profile policy for the MCP surface (REPORT-v2.1 Part A.2).
 *
 * `local`  — Ollama only. Any other provider is refused, fail-closed. No tool
 *            argument, preset or context overlay can widen a local session.
 * `routed` — any provider configured in Sound Suite; the preset / router
 *            decides per tier (Part B).
 *
 * Applied at the choke points: `ToolRegistry.execute`, `callLLM` /
 * `callLLMJson` in ai-helper, and inside the research tools.
 */

import { AI_PROVIDER_KEYS } from '../ai/models';
import type { McpProfile } from './research-types';

export const LOCAL_PROVIDER = 'ollama';

export class McpError extends Error {
  code: string;
  /**
   * Optional redacted twin of `message`, used by `BaseMCPTool.execute` for the
   * log line when `message` may embed document text (CLAUDE.md § Privacy).
   * The full `message` still reaches the caller that asked for the analysis.
   */
  logSafeMessage?: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/**
 * Resolve the provider a call may use under `profile`.
 *
 * - `local` + requested !== 'ollama' → throws `McpError('POLICY_VIOLATION')`
 * - `local` + nothing requested      → `'ollama'`
 * - `routed`                          → `requested` unchanged (may be undefined;
 *                                       the router / auto-detect fills it in)
 */
export function enforceProvider(profile: McpProfile, requested?: string): string | undefined {
  if (profile === 'local') {
    if (requested && requested !== LOCAL_PROVIDER) {
      throw new McpError(
        'POLICY_VIOLATION',
        `profile "local" refuses provider "${requested}" — only "${LOCAL_PROVIDER}" is permitted; ` +
          'register the "routed" profile to use cloud providers',
      );
    }
    return LOCAL_PROVIDER;
  }
  return requested;
}

/** Providers a profile may route to. */
export function providersAllowed(profile: McpProfile): string[] {
  return profile === 'local' ? [LOCAL_PROVIDER] : [...AI_PROVIDER_KEYS];
}

/** One-line policy statement stamped onto `GET /api/mcp/tools?profile=`. */
export function profilePolicyDescription(profile: McpProfile): string {
  return profile === 'local'
    ? 'Local-only: LLM calls are pinned to Ollama; cloud providers are refused (fail-closed). Case text never leaves this machine.'
    : 'Routed: Sound Suite selects the provider per tier from the active preset; case text may be sent to the configured cloud providers.';
}
