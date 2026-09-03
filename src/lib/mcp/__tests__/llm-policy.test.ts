/** @jest-environment node */

import { enforceProvider, McpError, providersAllowed, profilePolicyDescription } from '../llm-policy';
import { parseProfile, MCP_PROFILES } from '../research-types';
import { AI_PROVIDER_KEYS } from '../../ai/models';

describe('llm-policy', () => {
  describe('enforceProvider — local', () => {
    const cloudProviders = AI_PROVIDER_KEYS.filter((p) => p !== 'ollama');

    it.each(cloudProviders)('refuses provider %s with POLICY_VIOLATION', (provider) => {
      expect(() => enforceProvider('local', provider)).toThrow(McpError);
      try {
        enforceProvider('local', provider);
      } catch (err) {
        expect((err as McpError).code).toBe('POLICY_VIOLATION');
        expect((err as McpError).message).toContain(provider);
      }
    });

    it('refuses unknown providers too', () => {
      expect(() => enforceProvider('local', 'some-new-cloud')).toThrow(McpError);
    });

    it('defaults to ollama when nothing is requested', () => {
      expect(enforceProvider('local')).toBe('ollama');
      expect(enforceProvider('local', undefined)).toBe('ollama');
      expect(enforceProvider('local', '')).toBe('ollama');
    });

    it('accepts ollama', () => {
      expect(enforceProvider('local', 'ollama')).toBe('ollama');
    });
  });

  describe('enforceProvider — routed', () => {
    it('passes any requested provider through unchanged', () => {
      for (const p of AI_PROVIDER_KEYS) expect(enforceProvider('routed', p)).toBe(p);
    });
    it('returns undefined when nothing is requested (router decides)', () => {
      expect(enforceProvider('routed')).toBeUndefined();
    });
  });

  describe('providersAllowed', () => {
    it('is ollama-only for local', () => {
      expect(providersAllowed('local')).toEqual(['ollama']);
    });
    it('is every configured provider key for routed', () => {
      expect(providersAllowed('routed')).toEqual([...AI_PROVIDER_KEYS]);
      expect(providersAllowed('routed')).toContain('anthropic');
    });
  });

  describe('parseProfile — fail-closed', () => {
    it('only the exact string "routed" yields routed', () => {
      expect(parseProfile('routed')).toBe('routed');
    });
    it.each([
      undefined, null, '', 'local', 'ROUTED', 'Routed', ' routed', 'routed ', 'cloud', 1, true, {}, [], ['routed'],
    ])('%p → local', (v) => {
      expect(parseProfile(v)).toBe('local');
    });
    it('lists both profiles', () => {
      expect(MCP_PROFILES).toEqual(['local', 'routed']);
    });
  });

  it('describes each policy', () => {
    expect(profilePolicyDescription('local')).toMatch(/Ollama/);
    expect(profilePolicyDescription('routed')).toMatch(/preset/);
  });
});
