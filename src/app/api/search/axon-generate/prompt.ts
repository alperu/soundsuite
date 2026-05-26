/**
 * System-prompt builder + output sanitizer for /api/search/axon-generate.
 *
 * Pure functions, no I/O — safe to import from tests.
 */

import { CATALOGUE, OPERATORS, BOOLEANS } from '@/components/search/filter-logic-catalogue';

/**
 * Build the deterministic system prompt the Local AI sees.
 *
 * Includes:
 *  - The full field catalogue, grouped by entity (case / filing / motion / …)
 *  - The 6 comparison operators and 3 boolean keywords
 *  - Ref / path-traversal syntax notes
 *  - Today's ISO date so relative phrasing ("next Friday", "April 2026") resolves
 *  - Two worked examples
 */
export function buildAxonSystemPrompt(now: Date = new Date()): string {
  const lines: string[] = [];

  lines.push('You are an Axon/Haystack query translator.');
  lines.push('Convert the user\'s plain-English question into a single-line Axon filter expression.');
  lines.push('');
  lines.push('Available fields, grouped by entity:');
  for (const section of CATALOGUE) {
    lines.push(`# ${section.name} (marker: ${section.marker})`);
    for (const f of section.fields) {
      lines.push(`  - ${f.name} (${f.type}) — e.g. ${f.example}`);
    }
  }
  lines.push('');
  lines.push(`Comparison operators: ${OPERATORS.map(o => o.token).join(' ')}`);
  lines.push(`Booleans / grouping: ${BOOLEANS.map(b => b.token).join(' ')}`);
  lines.push('');
  lines.push('Syntax rules:');
  lines.push('  - Strings are double-quoted: name=="Smith"');
  lines.push('  - Refs are @<uuid> literals: judgeRef==@abc-123');
  lines.push('  - Path traversal uses ->: case->judge->displayName=="Roberts"');
  lines.push('  - Markers stand alone: `motion` matches anything tagged `motion`');
  lines.push('  - Combine with and / or / not, group with ( )');
  lines.push('  - Dates are ISO-8601 strings: "2026-04-15"');
  lines.push(`  - Today's date: ${now.toISOString().slice(0, 10)} (for relative phrasing)`);
  lines.push('');
  lines.push('Examples:');
  lines.push('  Input:  motions filed by Judge Roberts in April 2026');
  lines.push('  Output: motion and judgeRef->displayName=="Roberts" and filedAfter>="2026-04-01" and filedBefore<="2026-04-30"');
  lines.push('');
  lines.push('  Input:  every motion to disqualify');
  lines.push('  Output: motion and motionType=="disqualification"');
  lines.push('');
  lines.push('Output ONLY the Axon expression — single line, no explanation, no markdown, no leading "axon:" label.');

  return lines.join('\n');
}

/**
 * Clean up a model's raw text output before handing it to the parser.
 *
 *  - Strips ```...``` code fences
 *  - Strips leading "axon:" / "filter:" / "output:" labels (case-insensitive)
 *  - Collapses to the first non-empty line (parser expects a single line)
 *  - Trims surrounding whitespace and trailing punctuation
 */
export function sanitizeModelOutput(raw: string): string {
  let s = String(raw ?? '').trim();

  // Strip ```axon … ``` or ``` … ``` fences (greedy outermost pair).
  const fenceMatch = s.match(/```[\w-]*\s*([\s\S]*?)```/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else {
    // Strip stray fence tokens that some models emit without closing.
    s = s.replace(/```[\w-]*/g, '').trim();
  }

  // Drop everything after the first newline — the parser is single-line.
  const firstLine = s.split(/\r?\n/).find(line => line.trim().length > 0) ?? '';
  s = firstLine.trim();

  // Strip common leading labels.
  s = s.replace(/^(axon|filter|output|query)\s*:\s*/i, '').trim();

  // Strip surrounding backticks.
  s = s.replace(/^`+|`+$/g, '').trim();

  // Drop trailing semicolons / periods — not part of the grammar.
  s = s.replace(/[.;]+$/, '').trim();

  return s;
}
