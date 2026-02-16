/**
 * Query preprocessor for decomposing natural language queries into structured
 * search components. Extracts keywords, entities, legal terms, and page
 * references to build more effective FTS and hybrid queries.
 */

export interface ProcessedQuery {
  /** Original query for vector embedding */
  original: string;
  /** Significant terms after stopword removal */
  keywords: string[];
  /** Detected person/entity names */
  entities: string[];
  /** Recognized legal concepts */
  legalTerms: string[];
  /** Parsed page/volume references */
  pageReferences: PageReference | null;
  /** Combined search variants for BooleanQuery building */
  queryVariants: string[];
}

export interface PageReference {
  volume?: number;
  page?: number;
  filingType?: string;
  lineStart?: number;
  lineEnd?: number;
}

// Question words and common filler — always removed
const QUESTION_STOPWORDS = new Set([
  'where', 'when', 'what', 'which', 'who', 'whom', 'whose', 'how',
  'did', 'does', 'do', 'is', 'are', 'was', 'were', 'will', 'would',
  'could', 'should', 'can', 'may', 'might', 'shall',
  'say', 'said', 'says', 'saying',
  'there', 'here', 'that', 'this', 'those', 'these',
  'the', 'a', 'an',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'over',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because',
  'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'we', 'us', 'our', 'you', 'your', 'my', 'me', 'i',
  'has', 'have', 'had', 'having', 'been', 'being', 'be',
  'any', 'some', 'all', 'each', 'every', 'both', 'few', 'more',
  'also', 'just', 'only', 'very', 'really', 'quite',
  'tell', 'told', 'find', 'found', 'show', 'shown', 'give', 'given',
  'get', 'got', 'make', 'made', 'take', 'took', 'go', 'went', 'come', 'came',
]);

// These words are semantically important in legal context — never removed
const LEGAL_KEEP_WORDS = new Set([
  'no', 'not', 'never', 'none', 'nor', 'neither',
  'against', 'liable', 'guilty', 'innocent',
  'plaintiff', 'defendant', 'appellant', 'appellee',
  'court', 'judge', 'jury', 'witness', 'testimony',
]);

// Recognized legal terms for the legalTerms field
const LEGAL_TERMS = new Set([
  'fraud', 'negligence', 'breach', 'damages', 'liability',
  'malpractice', 'defamation', 'libel', 'slander',
  'injunction', 'indictment', 'arraignment', 'plea',
  'conviction', 'acquittal', 'sentence', 'probation', 'parole',
  'tort', 'contract', 'statute', 'ordinance', 'regulation',
  'jurisdiction', 'venue', 'standing', 'discovery',
  'deposition', 'interrogatory', 'subpoena', 'affidavit',
  'motion', 'summary judgment', 'default judgment',
  'appeal', 'remand', 'reversal', 'affirm',
  'evidence', 'exhibit', 'testimony', 'hearsay',
  'objection', 'sustained', 'overruled', 'stipulation',
  'settlement', 'verdict', 'judgment', 'decree', 'order',
  'complaint', 'answer', 'counterclaim', 'cross-claim',
  'fiduciary', 'duty', 'standard of care',
  'proximate cause', 'causation', 'foreseeability',
  'compensatory', 'punitive', 'exemplary',
  'due process', 'equal protection',
  'habeas corpus', 'mandamus', 'certiorari',
  'estoppel', 'laches', 'res judicata', 'collateral estoppel',
  'voir dire', 'mistrial', 'directed verdict',
  'misrepresentation', 'concealment', 'conspiracy',
]);

// Title prefixes that indicate the following word is an entity
const ENTITY_PREFIXES = new Set([
  'mr', 'mrs', 'ms', 'dr', 'judge', 'justice',
  'plaintiff', 'defendant', 'appellant', 'appellee',
  'attorney', 'counsel', 'officer', 'detective',
  'senator', 'representative', 'governor',
  'professor', 'prof',
]);

// Common English words that should NOT be treated as entities even when capitalized
const COMMON_WORDS_UPPER = new Set([
  'the', 'and', 'but', 'for', 'nor', 'yet', 'so',
  'court', 'state', 'county', 'city', 'district',
  'united', 'states', 'texas', 'california', 'new', 'york',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'exhibit', 'page', 'volume', 'section', 'article', 'paragraph',
  'no', 'not', 'yes',
]);

// Regex patterns for page/volume references
// Matches: "2 RR page 17", "Vol. 3 page 42", "CR page 15", "2 RR 17:24", etc.
const PAGE_REF_PATTERNS = [
  // "2 RR page 17" or "2 RR 17" or "2 RR 17:24"
  /(\d+)\s*(RR|CR|SR|PR)\s*(?:page\s*)?(\d+)(?::(\d+))?/i,
  // "Vol. 3 page 42" or "Volume 3, page 42"
  /vol(?:ume)?\.?\s*(\d+)[,\s]+(?:page\s*)?(\d+)/i,
  // "RR page 17" (no volume)
  /\b(RR|CR|SR|PR)\s+(?:page\s*)?(\d+)(?::(\d+))?/i,
  // "page 17" (standalone)
  /\bpage\s+(\d+)/i,
];

// Map filing type abbreviations to full names
const FILING_TYPE_MAP: Record<string, string> = {
  'rr': "Reporter's Record",
  'cr': "Clerk's Record",
  'sr': "Supplemental Record",
  'pr': "Plaintiff's Record",
};

export class QueryPreprocessor {
  /**
   * Process a natural language query into structured search components.
   */
  static process(query: string): ProcessedQuery {
    const original = query.trim();
    const words = this.tokenize(original);

    const keywords = this.extractKeywords(words);
    const entities = this.extractEntities(original, words);
    const legalTerms = this.extractLegalTerms(original);
    const pageReferences = this.extractPageReferences(original);
    const queryVariants = this.buildQueryVariants(keywords, entities, legalTerms);

    return {
      original,
      keywords,
      entities,
      legalTerms,
      pageReferences,
      queryVariants,
    };
  }

  /** Split query into words, stripping punctuation */
  private static tokenize(query: string): string[] {
    return query
      .replace(/[?!.,;:'"()\[\]{}]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);
  }

  /** Extract significant keywords after stopword removal */
  private static extractKeywords(words: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const word of words) {
      const lower = word.toLowerCase();

      // Skip if pure number (but keep alphanumeric like "17:24")
      if (/^\d+$/.test(word)) continue;

      // Keep legal-context words even if they appear in stopwords
      if (LEGAL_KEEP_WORDS.has(lower)) {
        if (!seen.has(lower)) {
          seen.add(lower);
          result.push(lower);
        }
        continue;
      }

      // Skip stopwords
      if (QUESTION_STOPWORDS.has(lower)) continue;

      // Keep the word
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(lower);
      }
    }

    return result;
  }

  /** Detect person names and entities using heuristics */
  private static extractEntities(original: string, words: string[]): string[] {
    const entities: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lower = word.toLowerCase();

      // Check if preceded by a title/prefix
      if (i > 0 && ENTITY_PREFIXES.has(words[i - 1].toLowerCase().replace(/\.$/, ''))) {
        if (!seen.has(lower)) {
          seen.add(lower);
          entities.push(word);
        }
        continue;
      }

      // Capitalized word not at sentence start, not a common word
      if (
        i > 0 &&
        word.length > 1 &&
        word[0] === word[0].toUpperCase() &&
        word[0] !== word[0].toLowerCase() &&
        !COMMON_WORDS_UPPER.has(lower) &&
        !QUESTION_STOPWORDS.has(lower) &&
        !LEGAL_TERMS.has(lower)
      ) {
        if (!seen.has(lower)) {
          seen.add(lower);
          entities.push(word);
        }
      }
    }

    // Also check first word if it looks like a proper noun (all caps or title case)
    // and isn't a question word
    if (words.length > 0) {
      const first = words[0];
      const firstLower = first.toLowerCase();
      if (
        first.length > 1 &&
        !QUESTION_STOPWORDS.has(firstLower) &&
        !COMMON_WORDS_UPPER.has(firstLower) &&
        !LEGAL_TERMS.has(firstLower) &&
        (first === first.toUpperCase() || // ALL CAPS
         /^[A-Z][a-z]+$/.test(first)) && // Title Case that looks like a name
        !seen.has(firstLower)
      ) {
        // Only add if it looks like a proper noun (check context)
        // If the query starts with a name-like word followed by a verb, it's likely a name
        if (words.length > 1) {
          const nextLower = words[1].toLowerCase();
          if (QUESTION_STOPWORDS.has(nextLower) || nextLower === 'said' || nextLower === 'says' || nextLower === 'stated' || nextLower === 'testified') {
            seen.add(firstLower);
            entities.push(first);
          }
        }
      }
    }

    return entities;
  }

  /** Match query against known legal terms (supports multi-word terms) */
  private static extractLegalTerms(original: string): string[] {
    const lower = original.toLowerCase();
    const terms: string[] = [];

    for (const term of LEGAL_TERMS) {
      if (lower.includes(term)) {
        terms.push(term);
      }
    }

    return terms;
  }

  /** Parse page/volume references from the query */
  private static extractPageReferences(original: string): PageReference | null {
    for (const pattern of PAGE_REF_PATTERNS) {
      const match = original.match(pattern);
      if (!match) continue;

      // Pattern 1: "2 RR page 17" or "2 RR 17:24"
      if (match.length >= 4 && /^\d+$/.test(match[1]) && /^(RR|CR|SR|PR)$/i.test(match[2])) {
        const ref: PageReference = {
          volume: parseInt(match[1], 10),
          filingType: FILING_TYPE_MAP[match[2].toLowerCase()] || match[2],
          page: parseInt(match[3], 10),
        };
        if (match[4]) {
          ref.lineStart = parseInt(match[4], 10);
        }
        return ref;
      }

      // Pattern 2: "Vol. 3 page 42"
      if (/vol/i.test(match[0])) {
        return {
          volume: parseInt(match[1], 10),
          page: parseInt(match[2], 10),
        };
      }

      // Pattern 3: "RR page 17" (no volume prefix number)
      if (/^(RR|CR|SR|PR)$/i.test(match[1])) {
        const ref: PageReference = {
          filingType: FILING_TYPE_MAP[match[1].toLowerCase()] || match[1],
          page: parseInt(match[2], 10),
        };
        if (match[3]) {
          ref.lineStart = parseInt(match[3], 10);
        }
        return ref;
      }

      // Pattern 4: "page 17" (standalone)
      if (/^page/i.test(match[0])) {
        return {
          page: parseInt(match[1], 10),
        };
      }
    }

    return null;
  }

  /** Build query variants for FTS BooleanQuery */
  private static buildQueryVariants(
    keywords: string[],
    entities: string[],
    legalTerms: string[],
  ): string[] {
    const variants: string[] = [];

    // Variant 1: all keywords combined
    if (keywords.length > 0) {
      variants.push(keywords.join(' '));
    }

    // Variant 2: entities + legal terms (most specific)
    if (entities.length > 0 && legalTerms.length > 0) {
      variants.push([...entities, ...legalTerms].join(' '));
    }

    // Variant 3: each entity paired with each legal term
    for (const entity of entities) {
      for (const term of legalTerms) {
        const pair = `${entity} ${term}`;
        if (!variants.includes(pair)) {
          variants.push(pair);
        }
      }
    }

    return variants;
  }
}
