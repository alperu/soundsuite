// STUB — Agent A produces the real catalogue (Task #13). Replace on merge.
// Shape must remain stable: { slug, displayName, category, shortDoc, source, aliases? }.

export interface MotionTypeEntry {
  /** camelCase identifier persisted in Motion.motionType */
  slug: string;
  /** Human-readable label for the picker. */
  displayName: string;
  /** Loose grouping: 'procedural' | 'dispositive' | 'discovery' | 'evidentiary' | 'family' | 'appellate' | 'other' */
  category: string;
  /** One-line description shown beneath the displayName. */
  shortDoc: string;
  /** Where the entry came from (e.g. 'TRCP', 'FRCP', 'practice'). */
  source: string;
  /** Optional alternate search terms. */
  aliases?: readonly string[];
}

export const MOTION_TYPES: readonly MotionTypeEntry[] = [
  {
    slug: 'disqualify',
    displayName: 'Motion to Disqualify',
    category: 'procedural',
    shortDoc: 'Remove counsel or a judge for conflict / bias.',
    source: 'practice',
    aliases: ['disqualification', 'conflict'],
  },
  {
    slug: 'summaryJudgment',
    displayName: 'Motion for Summary Judgment',
    category: 'dispositive',
    shortDoc: 'Judgment as a matter of law; no material fact in dispute.',
    source: 'TRCP 166a',
    aliases: ['msj', 'summary'],
  },
  {
    slug: 'dismiss',
    displayName: 'Motion to Dismiss',
    category: 'dispositive',
    shortDoc: 'Terminate the case before trial.',
    source: 'practice',
  },
  {
    slug: 'compel',
    displayName: 'Motion to Compel',
    category: 'discovery',
    shortDoc: 'Force a party to respond to discovery.',
    source: 'TRCP 215',
    aliases: ['compel discovery'],
  },
  {
    slug: 'inLimine',
    displayName: 'Motion in Limine',
    category: 'evidentiary',
    shortDoc: 'Exclude evidence before it reaches the jury.',
    source: 'practice',
    aliases: ['limine'],
  },
] as const;
